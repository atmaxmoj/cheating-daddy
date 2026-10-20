// run.js — `npm run eval`: the cue agent against the owner's real corpus and the real model.
//
// For each case in cases.js: load the corpus (scoped to the case's role), build the exact prompt
// the app sends (cues profile + contextFor), ask DeepSeek the way the app does, then score:
//   · the deterministic rubric (rubric.js) — format, Key, own-project example, real sources;
//   · a judge model (JUDGE_MODEL) — answers-as-asked, grounded, speakable, each 1–5.
// Writes eval/results/<time>.json and exits 1 when a check's pass rate is under PASS_RATE.
//
// Needs: ~/.standmeet/credentials.json (or $STANDMEET_CREDS_PATH), a DeepSeek key
// ($DEEPSEEK_API_KEY, else the one saved in the app). Flags: --repeat N, --only <substring>.

const fs = require('fs');
const path = require('path');
const s = require('../src/utils/standmeet');
const { getSystemPrompt } = require('../src/utils/prompts');
const { getPreferences } = require('../src/storage');
const cases = require('./cases');
const { check } = require('./rubric');
const { chat, judge, MODEL, JUDGE_MODEL, KEY } = require('./model');

const HOST = process.env.STANDMEET_HOST || getPreferences().standmeetHost || 'https://sijie.xyz';
const PASS_RATE = 0.9; // per check, across all runs
const JUDGE_MIN = 4; // a judge score below this fails the run

const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : dflt;
};
const REPEAT = Number(arg('--repeat', 1));
const ONLY = arg('--only', '');


async function main() {
    if (!KEY) throw new Error('no DeepSeek key: set DEEPSEEK_API_KEY or save one in the app');
    const roles = await s.listRoles(HOST);
    let loadedFor = null; // the role the index holds now; reload when a case needs another
    const results = [];

    for (const c of cases.filter(x => x.q.includes(ONLY))) {
        const role = c.role ? roles.find(r => r.name === c.role) : null;
        if (c.role && !role) {
            console.log(`skip (no role ${c.role} on ${HOST}): ${c.q}`);
            continue;
        }
        const roleKey = role?.name || '(all wiki)';
        if (loadedFor !== roleKey) {
            console.log(`loading ${roleKey}: ${await s.loadCorpus(HOST, role)} notes`);
            loadedFor = roleKey;
        }
        for (let r = 0; r < REPEAT; r++) {
            // the General round, built exactly as localai.js builds it (closing rules included)
            const context = s.contextFor(c.q, 'general');
            const system = getSystemPrompt('cues', context, false, s.roundRules('general'));
            const started = Date.now();
            const card = await chat(MODEL, [{ role: 'system', content: system }, { role: 'user', content: c.q }]);
            const ms = Date.now() - started;
            const checks = check(card, context, c);
            if (c.kind === 'answer') {
                const j = await judge(c.q, context, card);
                for (const k of ['asked', 'grounded', 'speakable']) checks[`judge.${k}`] = { ok: j[k] >= JUDGE_MIN, why: `${j[k]}/5 — ${j.why}` };
                if (card.includes('**Supplementary:**')) checks['judge.supplement'] = { ok: j.supplement >= JUDGE_MIN, why: `${j.supplement}/5 — ${j.why}` };
            }
            results.push({ q: c.q, role: roleKey, kind: c.kind, ms, card, context, checks });
            const failed = Object.entries(checks).filter(([, v]) => !v.ok);
            console.log(`${failed.length ? '✖' : '✔'} [${roleKey}] ${c.q} (${ms} ms)`);
            for (const [k, v] of failed) console.log(`    ${k}: ${v.why}`);
        }
    }

    // pass rate per check across every run that has it
    const rate = {};
    for (const r of results) for (const [k, v] of Object.entries(r.checks)) (rate[k] ||= []).push(v.ok);
    console.log('\ncheck                 pass rate');
    let gate = true;
    for (const [k, oks] of Object.entries(rate)) {
        const p = oks.filter(Boolean).length / oks.length;
        if (p < PASS_RATE) gate = false;
        console.log(`${p < PASS_RATE ? '✖' : '✔'} ${k.padEnd(20)} ${(p * 100).toFixed(0)}% (${oks.filter(Boolean).length}/${oks.length})`);
    }
    const answers = results.filter(r => r.kind === 'answer');
    console.log(`supplementary added on ${answers.filter(r => r.card.includes('**Supplementary:**')).length}/${answers.length} answer cards (the model's call)`);
    const ms = results.map(r => r.ms).sort((a, b) => a - b);
    console.log(`latency (full card, non-streamed): median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms`);

    const dir = path.join(__dirname, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ host: HOST, model: MODEL, judge: JUDGE_MODEL, results }, null, 2));
    console.log(`report: ${file}`);
    process.exit(gate ? 0 : 1);
}

main().catch(e => {
    console.error(e);
    process.exit(2);
});
