// env.js — require this FIRST in a test file. It gives the process a throwaway HOME (so storage
// reads and writes a fresh config, never the user's), a throwaway StandMeet key pair, and an
// `electron` stand-in that records what the main process sends to the window.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const credsPath = path.join(home, 'standmeet-credentials.json');
fs.writeFileSync(credsPath, JSON.stringify({ keyId: 'test-key', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
process.env.STANDMEET_CREDS_PATH = credsPath;

// sent — every (channel, data) the main process sent to the window, in order.
const sent = [];
const fakeElectron = {
    BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel, data) => sent.push({ channel, data }) } }] },
    ipcMain: { handle() {}, on() {} },
    app: { getPath: () => home },
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'electron' ? 'electron-stand-in' : resolve.call(this, request, ...rest);
};
require.cache['electron-stand-in'] = { id: 'electron-stand-in', filename: 'electron-stand-in', loaded: true, exports: fakeElectron };

// waitFor — poll until check() returns a truthy value (or time out with the label).
async function waitFor(check, label, ms = 5000) {
    const start = Date.now();
    for (;;) {
        const v = check();
        if (v) return v;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
        await new Promise(r => setTimeout(r, 20));
    }
}

module.exports = { home, sent, waitFor };
