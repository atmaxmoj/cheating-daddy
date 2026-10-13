// launch.js — the real app on a throwaway HOME, pointed at the StandMeet stand-in.
//
// A fresh config reuses the Whisper binary + model already downloaded on this Mac and the DeepSeek
// key saved in the app; nothing of the user's own config is written.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..', '..');
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

// launchApp — the app on a fresh HOME; resolves with the Electron app, its first window and config dir.
// chromiumFlags: Chromium switches for this launch only (e.g. a fake microphone playing a file).
async function launchApp(t, standmeetUrl, chromiumFlags = []) {
    const { home, config, creds } = freshHome(standmeetUrl);
    const app = await electron.launch({
        executablePath: require('../../node_modules/electron/index.js'),
        args: [ROOT, ...chromiumFlags],
        env: { ...process.env, HOME: home, STANDMEET_CREDS_PATH: creds },
        timeout: 30_000,
    });
    t.after(() => app.close());
    // the main process's own log, kept for reading a failure: <test-results>/<test name>.log
    const log = fs.createWriteStream(path.join(ROOT, 'test-results', `${t.name.replace(/\W+/g, '-')}.log`));
    app.process().stdout.pipe(log);
    app.process().stderr.pipe(log);
    const win = await app.firstWindow();
    win.on('console', m => log.write(`[renderer] ${m.text()}\n`));
    await win.waitForLoadState('domcontentloaded');
    return { app, win, config };
}

// say — the other side of the call, spoken through the speakers.
const say = text => new Promise((resolve, reject) => execFile('say', ['-v', 'Samantha', '-r', '170', text], e => (e ? reject(e) : resolve())));

module.exports = { ROOT, launchApp, say };
