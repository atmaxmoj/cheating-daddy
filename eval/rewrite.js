// rewrite.js — `npm run eval:rewrite -- <accents-results.json>`: does StandMeet's rewrite layer
// turn what Whisper heard into what was said, without inventing anything?
//
// Input: the transcripts eval/accents.js made of real accented speech (EdAcc), with their
// references. Each transcript goes through assistant.context with rewrite on (the server's own
// rewrite, the one assistant.cue uses) and is scored against the reference with fillers and
// stutter repeats taken out (a rewrite removes them on purpose; the words that were meant stay).
// Compared: the transcript as heard; a mechanical cleanup (fillers deleted, repeats collapsed —
// is a model needed at all?); the rewrite. Also counted:
//   · invented names — an owner name (assistant.prepare's names) in the output that the speaker
//     did not say (Whisper with the names prompt heard "I've got a notification" as "Gotenberg");
//   · refused rewrites, and the time each rewrite took.
//
// Flags: --condition base+hint|turbo+hint (default base+hint), --limit N.

const fs = require('fs');
const s = require('../src/utils/standmeet');
const { getPreferences } = require('../src/storage');

const HOST = process.env.STANDMEET_HOST || getPreferences().standmeetHost || 'https://sijie.xyz';
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const INPUT = process.argv[2];
const CONDITION = arg('--condition', 'base+hint');
const LIMIT = Number(arg('--limit', 1e9));

const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'ah', 'eh', 'hmm', 'mm', 'mhm', 'uhm']);
const rawWords = t => t.toLowerCase().replace(/<[^>]*>|\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
// DISCOURSE — words a rewrite removes on purpose ("yeah", "you know", "I mean"); the reference
// keeps them, so they come out of both sides before counting.
const DISCOURSE = /\b(yeah|okay|ok|you know|i mean)\b/g;
const words = t => rawWords(t.toLowerCase().replace(DISCOURSE, ' '));
// clean — fillers out, an immediately repeated run of one to three words kept once.
function clean(ws) {
    const out = ws.filter(w => !FILLERS.has(w));
    for (let n = 3; n >= 1; n--) {
        for (let i = 0; i + 2 * n <= out.length; ) {
            if (out.slice(i, i + n).join(' ') === out.slice(i + n, i + 2 * n).join(' ')) out.splice(i + n, n);
            else i++;
        }
    }
    return out;
}
function errors(ref, hyp) {
    const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
    for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
    for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hyp.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    return d[ref.length][hyp.length];
}

async function main() {
    const clips = JSON.parse(fs.readFileSync(INPUT, 'utf8')).filter(r => r.condition === CONDITION).slice(0, LIMIT);
    const client = s.createClient(HOST);
    await client.connect();
    const names = (await client.tool('assistant.prepare', {})).hint.split(', ').filter(n => n.length > 2);
    const named = t => names.filter(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t));
    const sum = { heard: 0, mech: 0, rewrite: 0, words: 0, refused: 0, inventedHeard: 0, inventedRewrite: 0, ms: [] };
    const rows = [];
    for (const c of clips) {
        if (!c.heard.trim()) continue;
        const ref = clean(words(c.text));
        const started = Date.now();
        const { heard } = await client.tool('assistant.context', { question: c.heard, rewrite: true });
        sum.ms.push(Date.now() - started);
        const said = named(c.text);
        const extraHeard = named(c.heard).filter(n => !said.includes(n));
        const extraRewrite = named(heard.question).filter(n => !said.includes(n));
        sum.words += ref.length;
        sum.heard += errors(ref, words(c.heard));
        sum.mech += errors(ref, clean(words(c.heard)));
        sum.rewrite += errors(ref, words(heard.question));
        sum.refused += heard.refused ? 1 : 0;
        sum.inventedHeard += extraHeard.length ? 1 : 0;
        sum.inventedRewrite += extraRewrite.length ? 1 : 0;
        rows.push({ accent: c.accent, ref: c.text, heard: c.heard, rewrite: heard.question, refused: heard.refused || '', extraHeard, extraRewrite });
    }
    const pct = n => `${((100 * n) / sum.words).toFixed(1)}%`;
    const ms = sum.ms.sort((a, b) => a - b);
    console.log(`${rows.length} clips (${CONDITION}), word error rate against what was said (fillers and repeats out):`);
    console.log(`  as heard           ${pct(sum.heard)}\n  mechanical cleanup ${pct(sum.mech)}\n  rewrite            ${pct(sum.rewrite)}`);
    console.log(`clips with a name nobody said: as heard ${sum.inventedHeard}, after rewrite ${sum.inventedRewrite}`);
    console.log(`rewrites refused by the guard: ${sum.refused}`);
    console.log(`rewrite time (assistant.context round trip): median ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms`);
    const changed = rows.filter(r => words(r.rewrite).join(' ') !== words(r.heard).join(' '));
    console.log(`\n${changed.length} rewritten; a sample:`);
    for (const r of changed.slice(0, 15)) console.log(`  [${r.accent}] said:  ${r.ref.slice(0, 90)}\n      heard: ${r.heard.replace(/\s+/g, ' ').slice(0, 90)}\n      meant: ${r.rewrite.slice(0, 90)}${r.refused ? `  (refused: ${r.refused})` : ''}`);
    const out = INPUT.replace(/accents-/, `rewrite-${CONDITION.replace('+', '-')}-`);
    fs.writeFileSync(out, JSON.stringify(rows, null, 1));
    console.log(`report: ${out}`);
}

main().catch(e => {
    console.error(e);
    process.exit(2);
});
