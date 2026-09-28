// app.e2e.js — `npm run test:app`: the real app, end to end, driven like the user drives it.
//
// Real: Electron, system-audio capture, whisper.cpp, DeepSeek. Stand-in: the StandMeet instance
// (test/helpers/fake-servers.js) — its server side of assistant.push has its own e2e.
// A fresh config (throwaway HOME) reuses the Whisper binary + model already downloaded on this Mac
// and the DeepSeek key saved in the app; nothing of the user's own config is written.
// The interviewer's question is spoken through the speakers with `say`, the way the other side
// of a call reaches the app. Needs: macOS, screen-recording permission for Electron, sound on.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { _electron: electron } = require('playwright-core');
const { startStandMeet } = require('./helpers/fake-servers');

const ROOT = path.join(__dirname, '..');
const REAL_CONFIG = path.join(os.homedir(), 'Library', 'Application Support', 'cheating-daddy-config');

// freshHome — a throwaway HOME with: a StandMeet key pair, the stand-in as host, the downloaded
// Whisper binary + model linked in, and the DeepSeek key copied from the app's own credentials.
function freshHome(standmeetUrl) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-e2e-'));
    const config = path.join(home, 'Library', 'Application Support', 'cheating-daddy-config');
    fs.mkdirSync(config, { recursive: true });
    for (const dir of ['binaries', 'models', 'whisper']) {
        if (fs.existsSync(path.join(REAL_CONFIG, dir))) fs.symlinkSync(path.join(REAL_CONFIG, dir), path.join(config, dir));
    }
    const key = JSON.parse(fs.readFileSync(path.join(REAL_CONFIG, 'credentials.json'), 'utf8')).deepseekApiKey;
    if (!key) throw new Error('save a DeepSeek key in the app first — the e2e uses the real model');
    // configVersion: without it the app treats the directory as stale and wipes it on start
    fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ configVersion: 1, onboarded: true }));
    fs.writeFileSync(path.join(config, 'credentials.json'), JSON.stringify({ deepseekApiKey: key }));
    fs.writeFileSync(path.join(config, 'preferences.json'), JSON.stringify({ standmeetHost: standmeetUrl }));
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const creds = path.join(home, 'standmeet-credentials.json');
    fs.writeFileSync(creds, JSON.stringify({ keyId: 'test-key', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    return { home, config, creds };
}

const say = text => new Promise((resolve, reject) => execFile('say', ['-v', 'Samantha', '-r', '170', text], e => (e ? reject(e) : resolve())));

test('screen assistant', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { home, config, creds } = freshHome(standmeet.url);

    const app = await electron.launch({
        executablePath: require('../node_modules/electron/index.js'),
        args: [ROOT],
        env: { ...process.env, HOME: home, STANDMEET_CREDS_PATH: creds },
        timeout: 30_000,
    });
    t.after(() => app.close());
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await t.test('start screen: StandMeet look, credited to Cheating Daddy', async () => {
        assert.equal(await win.title(), 'Screen Assistant');
        await win.getByText('modified from Cheating Daddy').waitFor();
        await win.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim().toLowerCase() === '#1b1814');
        assert.match(await win.evaluate(() => getComputedStyle(document.body).fontFamily), /Newsreader/);
        assert.equal(await win.locator('.start-button').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(181, 57, 28)');
        assert.equal(await win.getByText('Relay URL').count(), 0, 'cards go to StandMeet admin, not a relay');
    });

    await t.test('the role picker lists the instance roles; a pick is remembered', async () => {
        await win.locator('option', { hasText: 'standmeet-only' }).waitFor({ state: 'attached' });
        await win.locator('select').filter({ has: win.locator('option', { hasText: 'Whole wiki (no role)' }) }).selectOption({ label: 'standmeet-only' });
        await win.getByText('Platform engineer interview', { exact: false }).waitFor();
        await new Promise(r => setTimeout(r, 300));
        const prefs = JSON.parse(fs.readFileSync(path.join(config, 'preferences.json'), 'utf8'));
        assert.equal(prefs.standmeetRoleId, 'r-sm');
    });

    await t.test('start: the role-scoped corpus loads (2 notes) and it listens', async () => {
        await win.locator('.start-button').click();
        await win.getByText('Ready (2 notes)', { exact: false }).waitFor({ timeout: 120_000 });
    });

    await t.test('a spoken question: transcript line, then a cue card from the role notes', async () => {
        await say('How would you run untrusted code from your users safely?');
        const line = win.locator('.transcript-line').last();
        await line.waitFor({ timeout: 30_000 });
        assert.match(await line.innerText(), /untrusted code/i);

        const card = win.locator('#responseContainer');
        await card.getByText(/From:/).waitFor({ timeout: 30_000 });
        const text = await card.innerText();
        assert.match(text, /Key:/, 'the card opens with its Key');
        assert.match(text, /isolat|sandbox|container/i, 'it answers from the sandbox note');
        assert.match(text, /From:.*sandbox/i, 'it cites the role-scoped note');
        await win.screenshot({ path: path.join(ROOT, 'test-results', 'cue-card.png') });
    });

    await t.test('the phone feed got the heard line and the finished card', async () => {
        const card = await win.locator('#responseContainer').innerText();
        const deadline = Date.now() + 5000;
        let last;
        while (Date.now() < deadline) {
            last = standmeet.calls.pushes.filter(p => p.kind === 'cue').at(-1);
            if (last && /From:/.test(last.text)) break;
            await new Promise(r => setTimeout(r, 100));
        }
        assert.match(standmeet.calls.pushes.find(p => p.kind === 'heard').text, /untrusted code/i);
        assert.ok(last, 'a cue was pushed');
        assert.ok(card.includes(last.text.split('\n')[0].replace(/\*/g, '').trim().slice(0, 20)), 'the pushed card is the card on screen');
    });

    await t.test('small talk gives no card', async () => {
        const before = standmeet.calls.pushes.filter(p => p.kind === 'cue').length;
        await say('Great, can you hear me okay?');
        await win.locator('.transcript-line', { hasText: /hear me/i }).waitFor({ timeout: 30_000 });
        await new Promise(r => setTimeout(r, 6000));
        const cues = standmeet.calls.pushes.filter(p => p.kind === 'cue').slice(before);
        assert.ok(cues.every(c => c.text.trim() === '—'), `got ${JSON.stringify(cues.at(-1)?.text)}`);
    });
});
