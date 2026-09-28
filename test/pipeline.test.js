// pipeline.test.js — the whole listening loop in the main process: system audio in → speech
// detected → Whisper → a cue streamed to the window and to StandMeet. The servers are local
// stand-ins; the audio is synthesized (a tone as "speech", then silence to end the turn).
const { sent, waitFor } = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const storage = require('../src/storage');
const localai = require('../src/utils/localai');
const standmeet = require('../src/utils/standmeet');
const feed = require('../src/utils/feed');
const { startFakes } = require('./helpers/fake-servers');

const RATE = 24000;
const CHUNK = RATE / 10; // 100 ms chunks, the size the capture sends

function chunk(amp, i) {
    const buf = Buffer.alloc(CHUNK * 2);
    for (let j = 0; j < CHUNK; j++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * (i * CHUNK + j)) / RATE) * amp * 32767), j * 2);
    return buf;
}

function speak(seconds, silence = 3) {
    let i = 0;
    for (; i < seconds * 10; i++) localai.processLocalAudio(chunk(0.3, i));
    for (let k = 0; k < silence * 10; k++) localai.processLocalAudio(chunk(0, i + k));
}

test('pipeline', async t => {
    const fakes = await startFakes();
    t.after(() => {
        localai.closeLocalSession();
        return fakes.close();
    });
    storage.initializeStorage();
    storage.updatePreference('standmeetHost', fakes.url);
    const [role] = await standmeet.listRoles(fakes.url);
    await standmeet.loadCorpus(fakes.url, role);
    localai.__test.attach({ whisperUrl: fakes.url, llamaUrl: fakes.url });

    await t.test('a spoken question becomes a transcript line and a streamed cue', async () => {
        speak(1.5);
        await waitFor(() => sent.some(e => e.channel === 'update-status' && e.data === 'Listening...' && fakes.calls.llama.length), 'the cue to finish');

        const transcript = sent.find(e => e.channel === 'transcript-line');
        assert.deepEqual({ text: transcript.data.text, source: transcript.data.source }, { text: 'How do you isolate untrusted code?', source: 'heard' });
        const responses = sent.filter(e => e.channel === 'new-response' || e.channel === 'update-response');
        assert.equal(responses[0].channel, 'new-response');
        assert.equal(responses.at(-1).data, '**Key:** isolation + sandbox\n\nEvery build runs in its own container.');
    });

    await t.test('Whisper got a real WAV plus the project names as a spelling hint', () => {
        const form = fakes.calls.whisper[0];
        assert.ok(form.includes('RIFF') && form.includes('WAVE'));
        assert.match(form, /Interview about standmeet/);
    });

    await t.test('the model was asked with the cue format and the role-scoped notes', () => {
        const system = fakes.calls.llama[0].messages[0].content;
        assert.match(system, /CUE FORMAT/);
        assert.match(system, /Platform engineer interview/);
        assert.match(system, /its own container with the network off/);
        assert.ok(!system.includes('turns videos into lessons'), 'notes outside the role stay out');
        assert.equal(fakes.calls.llama[0].messages.at(-1).content, 'How do you isolate untrusted code?');
    });

    await t.test('the phone feed got the heard line and the finished card', async () => {
        await feed.flushed();
        const heard = fakes.calls.pushes.filter(p => p.kind === 'heard');
        const cues = fakes.calls.pushes.filter(p => p.kind === 'cue');
        assert.equal(heard.at(-1).text, 'How do you isolate untrusted code?');
        assert.equal(cues.at(-1).text, '**Key:** isolation + sandbox\n\nEvery build runs in its own container.');
    });

    await t.test('a cough followed by a long silence is not sent to Whisper', async () => {
        const calls = fakes.calls.whisper.length;
        speak(0.3, 4);
        await new Promise(r => setTimeout(r, 300));
        assert.equal(fakes.calls.whisper.length, calls);
    });

    await t.test('the second question carries the first exchange as history', async () => {
        speak(1.5);
        await waitFor(() => fakes.calls.llama.length === 2, 'the second request');
        const roles = fakes.calls.llama[1].messages.map(m => m.role);
        assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
        await waitFor(() => sent.at(-1).channel === 'update-status' && sent.at(-1).data === 'Listening...', 'the turn to end');
    });

    await t.test('Whisper hearing only a non-speech tag gives no cue', async () => {
        fakes.behaviour.heard = '[BLANK_AUDIO]';
        const calls = fakes.calls.llama.length;
        speak(1.5);
        await waitFor(() => fakes.calls.whisper.length === 3, 'the transcription');
        await new Promise(r => setTimeout(r, 100));
        assert.equal(fakes.calls.llama.length, calls);
        fakes.behaviour.heard = null;
    });

    await t.test('after the session closes, audio is ignored', async () => {
        localai.closeLocalSession();
        const calls = fakes.calls.whisper.length;
        speak(1.5);
        await new Promise(r => setTimeout(r, 300));
        assert.equal(fakes.calls.whisper.length, calls);
        assert.equal(localai.isLocalSessionActive(), false);
    });
});
