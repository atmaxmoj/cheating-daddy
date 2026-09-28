// feed.js — streams what the assistant hears and the cue cards it writes to StandMeet
// (owner MCP `assistant.push`), so /admin/screen-assistant shows them live on a phone.
//
// Fire-and-forget: a slow or unreachable StandMeet never holds up the cue on the desktop.
// Pushes go out one at a time, in order, so a late partial never overwrites a finished cue.
// A failed push reconnects and tries once more (a restarted instance forgets MCP sessions).

const crypto = require('crypto');
const { getPreferences } = require('../storage');
const { createClient } = require('./standmeet');

const CUE_THROTTLE_MS = 300;

let client = null;
let queue = Promise.resolve();
let pendingCue = null;
let cueTimer = null;

// connected — the client for the host in settings now; a changed host gets a fresh session.
async function connected() {
    const host = (getPreferences().standmeetHost || 'https://sijie.xyz').replace(/\/$/, '');
    if (!client || client.host !== host) {
        const c = createClient(host);
        await c.connect();
        client = { host, tool: c.tool };
    }
    return client;
}

function push(event) {
    queue = queue
        .then(() => connected().then(c => c.tool('assistant.push', event)))
        .catch(() => {
            client = null;
            return connected().then(c => c.tool('assistant.push', event));
        })
        .catch(error => {
            client = null;
            console.error('[feed]', error.message);
        });
    return queue;
}

function publishTranscript(text) {
    return push({ kind: 'heard', id: crypto.randomUUID(), text });
}

// newCueID — one id per cue; the page keeps the latest text under it.
function newCueID() {
    return crypto.randomUUID();
}

// publishCue — partial updates are throttled; the final one always goes out.
function publishCue(id, text, final) {
    pendingCue = { kind: 'cue', id, text };
    if (final) {
        clearTimeout(cueTimer);
        cueTimer = null;
        const event = pendingCue;
        pendingCue = null;
        return push(event);
    }
    if (cueTimer) return queue;
    cueTimer = setTimeout(() => {
        cueTimer = null;
        if (pendingCue) push(pendingCue);
        pendingCue = null;
    }, CUE_THROTTLE_MS);
    return queue;
}

// flushed — resolves once every push queued so far has settled (tests; quitting).
function flushed() {
    return queue;
}

module.exports = { publishTranscript, publishCue, newCueID, flushed };
