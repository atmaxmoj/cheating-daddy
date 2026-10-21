// stt.js — `npm run eval:stt`: what a mis-heard question does to retrieval.
//
// Each answer case in cases.js is spoken by several macOS voices (accents), then degraded the way
// a call degrades it (phone band, low-bitrate Opus, background noise), then transcribed by the
// app's own Whisper with the app's own prompt hint. The transcript is the query the app would use.
// Per case and condition it reports:
//   · the transcript (read them — the errors are the finding);
//   · retrieval: the case's `notes` still in the context (the clean question's check, rubric.js);
//   · overlap: the share of the clean question's notes the transcript still retrieves.
// Writes eval/results/stt-<time>.json. No model calls; Whisper runs locally.
//
// Needs: ffmpeg, the app's downloaded Whisper (run the app once), ~/.standmeet/credentials.json.
// Flags: --only <substring>.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const s = require('../src/utils/standmeet');
const { getPreferences } = require('../src/storage');
const cases = require('./cases');

const HOST = process.env.STANDMEET_HOST || getPreferences().standmeetHost || 'https://sijie.xyz';
const CONFIG = path.join(os.homedir(), 'Library/Application Support/cheating-daddy-config');
const WHISPER = path.join(CONFIG, 'binaries/whisper-server-macos-arm64');
const MODEL = path.join(CONFIG, 'models/whisper/ggml-base.en.bin');
const PORT = 18781;
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';

const VOICES = ['Samantha', 'Daniel', 'Aman', 'Karen', 'Moira'];
// CONDITIONS — ffmpeg filters from the 16 kHz voice to what the call delivers.
const CONDITIONS = {
    clean: null,
    call: 'highpass=f=300,lowpass=f=3400,aresample=8000,aresample=16000',
    noisy: 'highpass=f=300,lowpass=f=3400,aresample=8000,aresample=16000[v];anoisesrc=color=pink:amplitude=0.06:r=16000[n];[v][n]amix=inputs=2:duration=first:normalize=0',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-eval-'));

function speak(text, voice, condition, file) {
    const aiff = path.join(tmp, 'say.aiff');
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    const filter = CONDITIONS[condition];
    const args = ['-y', '-loglevel', 'error', '-i', aiff, '-ac', '1', '-ar', '16000'];
    if (!filter) return execFileSync('ffmpeg', [...args, file]);
    // the call codec: Opus at 12 kb/s, then back to the WAV Whisper gets
    const opus = path.join(tmp, 'call.ogg');
    execFileSync('ffmpeg', [...args, '-filter_complex', filter, '-c:a', 'libopus', '-b:a', '12k', opus]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', opus, '-ac', '1', '-ar', '16000', file]);
}

// transcribe — the request transcribeAudio() in localai.js sends.
async function transcribe(file) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('language', 'en');
    const hint = session.hint;
    if (hint) form.append('prompt', `Interview about ${hint}.`);
    const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form });
    return ((await res.json()).text || '').trim();
}

// session — the StandMeet client and the Whisper hint it gives (assistant.prepare).
const session = { client: null, hint: '' };
// contextFor — the context StandMeet builds for this line (assistant.context, General round).
const contextFor = async question => (await session.client.tool('assistant.context', { question })).context;

const notesIn = context => [...context.matchAll(/^## .*\(([^)]+)\)/gm)].map(m => m[1]);

async function waitUp() {
    for (let i = 0; i < 120; i++) {
        try {
            await fetch(`http://127.0.0.1:${PORT}/`);
            return;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw new Error('whisper did not start');
}

let whisper;
async function startWhisper() {
    const log = fs.openSync(path.join(__dirname, 'results', 'stt-whisper.log'), 'a');
    whisper = spawn(WHISPER, ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT)], { stdio: ['ignore', log, log] });
    await waitUp();
}

// heardAs — the transcript. Whisper's server drops an idle keep-alive socket while ffmpeg works,
// so the next request on it fails with EPIPE; a retry opens a fresh connection.
async function heardAs(file, tries = 3) {
    try {
        return await transcribe(file);
    } catch (e) {
        if (tries <= 1) throw e;
        await new Promise(r => setTimeout(r, 300));
        return heardAs(file, tries - 1);
    }
}

async function main() {
    fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
    try {
        await startWhisper();
        session.client = s.createClient(HOST);
        await session.client.connect();
        const prepared = await session.client.tool('assistant.prepare', {});
        session.hint = prepared.hint;
        console.log(`loading: ${prepared.notes} notes`);
        const results = [];
        for (const c of cases.filter(x => x.kind === 'answer' && !x.role && x.q.includes(ONLY))) {
            const clean = notesIn(await contextFor(c.q));
            console.log(`\n${c.q}`);
            for (const voice of VOICES) {
                for (const condition of Object.keys(CONDITIONS)) {
                    const wav = path.join(tmp, 'q.wav');
                    speak(c.q, voice, condition, wav);
                    const heard = await heardAs(wav);
                    const context = heard ? await contextFor(heard) : '';
                    const got = notesIn(context);
                    const overlap = clean.length ? clean.filter(p => got.includes(p)).length / clean.length : 1;
                    const retrieval = c.notes.test(context);
                    results.push({ q: c.q, voice, condition, heard, retrieval, overlap });
                    console.log(`  ${retrieval ? '✔' : '✖'} ${(overlap * 100).toFixed(0).padStart(3)}% ${voice.padEnd(8)} ${condition.padEnd(5)} ${heard}`);
                }
            }
        }
        console.log('\ncondition  retrieval  overlap');
        for (const condition of Object.keys(CONDITIONS)) {
            const rs = results.filter(r => r.condition === condition);
            const ret = rs.filter(r => r.retrieval).length / rs.length;
            const ov = rs.reduce((a, r) => a + r.overlap, 0) / rs.length;
            console.log(`${condition.padEnd(10)} ${(ret * 100).toFixed(0).padStart(5)}%    ${(ov * 100).toFixed(0).padStart(4)}%`);
        }
        const file = path.join(__dirname, 'results', `stt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(results, null, 2));
        console.log(`report: ${file}`);
    } finally {
        whisper?.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main().catch(e => {
    console.error(e);
    process.exit(2);
});
