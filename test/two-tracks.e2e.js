// two-tracks.e2e.js — the transcript keeps both sides of the call (owner, 2026-10-13: "TRANSCRIPT 这个
// 也分两组吧，一个是从电脑监听的，一个是从麦克风的，也就是我说话，这个我说话不需要处理，只是我希望transcript
// 能记上，以提供我后续复盘").
//
// Contract:
//   - Two streams: computer audio is "Them" (transcribed, cued, pushed to the phone feed); the
//     microphone is "Me" (transcribed only: no cue, nothing to the model, nothing to the feed —
//     the feed has no field to say whose line it is).
//   - The sidebar shows both, labelled, in time order.
//   - The saved session keeps both tracks; History shows them under Transcript.
//
// The microphone is Chromium's fake capture device playing a known sentence (launch flags only);
// the other side is `say` through the speakers, as in the other specs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startStandMeet } = require('./helpers/fake-servers');
const { launchApp, say } = require('./helpers/launch');

// micFile — the owner's own sentence as a 16 kHz wav, with quiet after it. afconvert writes an
// Apple FLLR padding chunk before the samples, which Chromium's fake device reads as silence, so
// the file is rewritten as a plain RIFF: fmt + data only.
function micFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-mic-'));
    const aiff = path.join(dir, 'me.aiff');
    const wav = path.join(dir, 'me.wav');
    execFileSync('say', ['-v', 'Daniel', '-r', '170', '-o', aiff, 'I led the platform migration at my last company. [[slnc 1500]]']);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
    const raw = fs.readFileSync(wav);
    const chunks = {};
    for (let at = 12; at + 8 <= raw.length; ) {
        const size = raw.readUInt32LE(at + 4);
        chunks[raw.toString('ascii', at, at + 4)] = raw.subarray(at, at + 8 + size);
        at += 8 + size + (size % 2);
    }
    const body = Buffer.concat([Buffer.from('WAVE'), chunks['fmt '], chunks.data]);
    const header = Buffer.alloc(8);
    header.write('RIFF');
    header.writeUInt32LE(body.length, 4);
    fs.writeFileSync(wav, Buffer.concat([header, body]));
    return wav;
}

test('two tracks', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win, config } = await launchApp(t, standmeet.url, `${micFile()}%noloop`);
    const meLine = win.locator('.transcript-line.me');
    const themLine = win.locator('.transcript-line.them');

    await t.test('my own words: a "Me" line, and nothing else', async () => {
        await win.locator('.start-button').click();
        await win.getByText('Ready (', { exact: false }).waitFor({ timeout: 120_000 });
        await meLine.first().waitFor({ timeout: 40_000 });
        const text = await meLine.first().innerText();
        assert.match(text, /platform migration/i);
        assert.match(text, /\bMe\b/, 'labelled as mine');
        await new Promise(r => setTimeout(r, 6000));
        assert.equal(standmeet.calls.pushes.length, 0, 'nothing went to the phone feed: no heard line, no cue');
        assert.doesNotMatch(await win.locator('#responseContainer').innerText(), /Key:/, 'no card for my own words');
    });

    await t.test('their question: a "Them" line and a card', async () => {
        await say('How would you run untrusted code from your users safely?');
        await themLine.first().waitFor({ timeout: 30_000 });
        assert.match(await themLine.first().innerText(), /untrusted code/i);
        assert.match(await themLine.first().innerText(), /\bThem\b/);
        await win.locator('#responseContainer').getByText(/From:/).waitFor({ timeout: 30_000 });
        const heard = standmeet.calls.pushes.filter(p => p.kind === 'heard').map(p => p.text);
        assert.ok(heard.some(h => /untrusted code/i.test(h)), 'their line reached the feed');
        assert.ok(!heard.some(h => /platform migration/i.test(h)), 'mine did not');
        const lines = await win.locator('.transcript-line').allInnerTexts();
        assert.ok(lines.findIndex(l => /platform migration/i.test(l)) < lines.findIndex(l => /untrusted code/i.test(l)), 'time order');
    });

    await t.test('History keeps both tracks for review', async () => {
        await win.locator('.live-bar-back').click();
        await win.locator('.nav-item', { hasText: 'History' }).click();
        await win.locator('.session-card').first().click();
        await win.locator('.tab-btn', { hasText: 'Transcript' }).click();
        const rows = win.locator('.transcript-row');
        await rows.first().waitFor({ timeout: 10_000 });
        const all = (await rows.allInnerTexts()).join('\n');
        assert.match(all, /Me[\s\S]*platform migration/i);
        assert.match(all, /Them[\s\S]*untrusted code/i);
        const [file] = fs.readdirSync(path.join(config, 'history'));
        const saved = JSON.parse(fs.readFileSync(path.join(config, 'history', file), 'utf8'));
        assert.deepEqual([...new Set(saved.transcript.map(l => l.source))].sort(), ['me', 'them'], 'both tracks on disk');
    });
});
