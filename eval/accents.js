// accents.js — `npm run eval:accents -- <clips dir> [turbo model]`: how well the app's Whisper hears
// real people with real accents.
//
// The voice the app transcribes is the interviewer's: anyone, any accent, mixed and unsteady
// (owner, 2026-10-21: "像我这样的人，会混杂着多个地方的口音，肯定听不准的" — and TTS audio always
// comes out clean, so it cannot stand in). The clips are real human speech from EdAcc (the
// Edinburgh International Accents of English Corpus: conversations, 40+ accents), one audio file
// per utterance plus manifest.json ({file, text, accent, l1}).
//
// Each clip is transcribed in each condition, as transcribeAudio() in localai.js asks:
//   base        — the app's model (ggml-base.en), no prompt
//   base+hint   — the same, with the Whisper prompt the app sends (assistant.prepare's names)
//   turbo+hint  — large-v3-turbo with the prompt (when a model path is given)
// and scored against the reference: word error rate per accent, the share of clips whose
// transcript is wrong in more than half its words, and the time per clip. EdAcc speech holds no
// tech names, so base vs base+hint also shows whether the names prompt ever drags ordinary words
// toward them ("over-correction").
//
// Needs ffmpeg, the app's downloaded Whisper, ~/.standmeet/credentials.json (for the hint).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const s = require('../src/utils/standmeet');
const { getPreferences } = require('../src/storage');

const HOST = process.env.STANDMEET_HOST || getPreferences().standmeetHost || 'https://sijie.xyz';
const CONFIG = path.join(os.homedir(), 'Library/Application Support/cheating-daddy-config');
const WHISPER = path.join(CONFIG, 'binaries/whisper-server-macos-arm64');
const BASE = path.join(CONFIG, 'models/whisper/ggml-base.en.bin');
const [CLIPS, TURBO] = process.argv.slice(2);
const PORT = 18782;

// norm — words as a WER counts them: lowercase, no punctuation, no EdAcc annotations.
const norm = t => t.toLowerCase().replace(/<[^>]*>|\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

function wer(ref, hyp) {
    const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
    for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
    for (let i = 1; i <= ref.length; i++) {
        for (let j = 1; j <= hyp.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
        }
    }
    return { errors: d[ref.length][hyp.length], words: ref.length };
}

async function waitUp() {
    for (let i = 0; i < 240; i++) {
        try {
            await fetch(`http://127.0.0.1:${PORT}/`);
            return;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw new Error('whisper did not start');
}

async function transcribe(wav, prompt, tries = 3) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('language', 'en');
    if (prompt) form.append('prompt', prompt);
    try {
        const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form });
        return ((await res.json()).text || '').trim();
    } catch (e) {
        if (tries <= 1) throw e;
        await new Promise(r => setTimeout(r, 300)); // an idle keep-alive socket the server dropped
        return transcribe(wav, prompt, tries - 1);
    }
}

async function runCondition(name, model, prompt, clips) {
    const server = spawn(WHISPER, ['-m', model, '--host', '127.0.0.1', '--port', String(PORT)], { stdio: 'ignore' });
    try {
        await waitUp();
        const out = [];
        for (const c of clips) {
            const started = Date.now();
            const heard = await transcribe(c.wav, prompt);
            const ms = Date.now() - started;
            const w = wer(norm(c.text), norm(heard));
            out.push({ ...c, condition: name, heard, ms, ...w });
        }
        return out;
    } finally {
        server.kill();
        await new Promise(r => setTimeout(r, 1000));
    }
}

function report(results) {
    const groups = [...new Set(results.map(r => r.accent))].sort();
    const conds = [...new Set(results.map(r => r.condition))];
    const cell = rs => {
        const e = rs.reduce((a, r) => a + r.errors, 0);
        const n = rs.reduce((a, r) => a + r.words, 0);
        const bad = rs.filter(r => r.errors / r.words > 0.5).length;
        return `${((100 * e) / n).toFixed(1).padStart(5)}% ${String(bad).padStart(2)}✖`;
    };
    console.log(`\nword error rate (lower is better) · ✖ = clips more than half wrong\n${'accent'.padEnd(24)}${conds.map(c => c.padStart(14)).join('')}   clips`);
    for (const g of [...groups, 'ALL']) {
        const rs = results.filter(r => g === 'ALL' || r.accent === g);
        console.log(`${g.padEnd(24)}${conds.map(c => cell(rs.filter(r => r.condition === c)).padStart(14)).join('')}   ${rs.length / conds.length}`);
    }
    for (const c of conds) {
        const ms = results.filter(r => r.condition === c).map(r => r.ms).sort((a, b) => a - b);
        console.log(`${c}: median ${ms[Math.floor(ms.length / 2)]} ms per clip, p90 ${ms[Math.floor(ms.length * 0.9)]} ms`);
    }
}

async function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(CLIPS, 'manifest.json'), 'utf8'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accents-'));
    const clips = manifest.map(m => {
        const wav = path.join(tmp, `${path.parse(m.file).name}.wav`);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(CLIPS, m.file), '-ac', '1', '-ar', '16000', wav]);
        return { file: m.file, text: m.text, accent: m.accent, l1: m.l1, wav };
    });
    const client = s.createClient(HOST);
    await client.connect();
    const hint = `Interview about ${(await client.tool('assistant.prepare', {})).hint}.`;
    const results = [];
    results.push(...(await runCondition('base', BASE, '', clips)));
    results.push(...(await runCondition('base+hint', BASE, hint, clips)));
    if (TURBO) results.push(...(await runCondition('turbo+hint', TURBO, hint, clips)));
    report(results);
    const dir = path.join(__dirname, 'results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `accents-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(results.map(({ wav, ...r }) => r), null, 1));
    console.log(`report: ${file}`);
    fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch(e => {
    console.error(e);
    process.exit(2);
});
