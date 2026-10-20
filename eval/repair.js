// repair.js — `node eval/repair.js [stt-results.json]`: does repairing a mis-heard question first
// make a better card?
//
// Takes the transcripts eval/stt.js produced (the newest stt-*.json by default). For each heard
// line that differs from the question, two arms build the General-round card as the app does:
//   raw    — the transcript is the query and the user message (the app today);
//   repair — the model repairs the transcript first (repairPrompt), then the same.
// The judge grades both cards against the question the interviewer really asked. Also checked:
// the case's notes are in the context, the choice matrix fires when the question names a
// technology (rubric.js), and what the repair step costs in time.
//
// Result (2026-10-20, 49 mis-heard lines, before the stack names went into Whisper's prompt):
// asked 3.71 → 3.63, grounded 3.73 → 3.98, matrix 20/31 → 28/31, +0.83 s median per question —
// and the repair invented names from noise ("graph" → "gVisor", "Coopatavi" → "Kubernetes").
// Not adopted; the names went into Whisper's prompt instead (transcriptionHint).

const fs = require('fs');
const path = require('path');
const s = require('../src/utils/standmeet');
const { getSystemPrompt } = require('../src/utils/prompts');
const { getPreferences } = require('../src/storage');
const cases = require('./cases');
const { check } = require('./rubric');
const { chat, judge, MODEL } = require('./model');

const HOST = process.env.STANDMEET_HOST || getPreferences().standmeetHost || 'https://sijie.xyz';
const dir = path.join(__dirname, 'results');
const input = process.argv[2] || path.join(dir, fs.readdirSync(dir).filter(f => /^stt-\d.*\.json$/.test(f)).sort().at(-1));

// repairPrompt — ask the model to undo speech-recognition errors in the interviewer's line.
function repairPrompt(line) {
    return [
        {
            role: 'system',
            content: `You repair a speech-to-text transcript of what an interviewer just said to a software engineer.
Fix only words the recognizer mis-heard: a technical name heard as everyday words, a split or mangled term. Names this engineer uses: ${s.transcriptionHint()}.
Keep the speaker's wording and meaning otherwise. Do not answer, do not add words, do not complete a cut-off sentence.
When nothing is mis-heard, or the line is not intelligible, return it unchanged.
Reply with the repaired line only.`,
        },
        { role: 'user', content: line },
    ];
}

async function card(c, query) {
    const context = s.contextFor(query, 'general');
    const system = getSystemPrompt('cues', context, false, s.roundRules('general'));
    const text = await chat(MODEL, [{ role: 'system', content: system }, { role: 'user', content: query }]);
    const j = await judge(c.q, context, text);
    const checks = check(text, context, c);
    return { query, text, asked: j.asked, grounded: j.grounded, why: j.why, retrieval: checks.retrieval?.ok, matrix: checks.matrix?.ok ?? null };
}

async function main() {
    const heard = JSON.parse(fs.readFileSync(input, 'utf8')).filter(r => r.heard.replace(/\W/g, '').toLowerCase() !== r.q.replace(/\W/g, '').toLowerCase());
    console.log(`${input}: ${heard.length} mis-heard lines`);
    console.log(`loading: ${await s.loadCorpus(HOST, null)} notes`);
    const results = [];
    for (const r of heard) {
        const c = cases.find(x => x.q === r.q);
        const started = Date.now();
        const repaired = (await chat(MODEL, repairPrompt(r.heard), 200)).trim();
        const ms = Date.now() - started;
        const [raw, fixed] = await Promise.all([card(c, r.heard), card(c, repaired)]);
        results.push({ q: r.q, voice: r.voice, condition: r.condition, heard: r.heard, repaired, repairMs: ms, raw, fixed });
        console.log(`\n${r.q}\n  heard:    ${r.heard}\n  repaired: ${repaired} (${ms} ms)`);
        for (const [arm, x] of [['raw', raw], ['repair', fixed]]) {
            console.log(`  ${arm.padEnd(6)} asked ${x.asked} grounded ${x.grounded} retrieval ${x.retrieval ? '✔' : '✖'}${x.matrix === null ? '' : ` matrix ${x.matrix ? '✔' : '✖'}`} — ${x.why}`);
        }
    }
    const mean = (arm, k) => (results.reduce((a, r) => a + r[arm][k], 0) / results.length).toFixed(2);
    const rate = (arm, k) => {
        const xs = results.filter(r => r[arm][k] !== null && r[arm][k] !== undefined);
        return `${xs.filter(r => r[arm][k]).length}/${xs.length}`;
    };
    console.log('\narm     asked  grounded  asked≥4  retrieval  matrix');
    for (const arm of ['raw', 'fixed']) {
        const ok = results.filter(r => r[arm].asked >= 4).length;
        console.log(`${arm.padEnd(7)} ${mean(arm, 'asked').padStart(5)}  ${mean(arm, 'grounded').padStart(8)}  ${`${ok}/${results.length}`.padStart(7)}  ${rate(arm, 'retrieval').padStart(9)}  ${rate(arm, 'matrix')}`);
    }
    const ms = results.map(r => r.repairMs).sort((a, b) => a - b);
    console.log(`repair latency: median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms.at(-1)} ms`);
    const file = path.join(dir, `repair-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(results, null, 2));
    console.log(`report: ${file}`);
}

main().catch(e => {
    console.error(e);
    process.exit(2);
});
