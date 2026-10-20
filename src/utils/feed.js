// feed.js — streams what the assistant hears and the cue cards it writes to StandMeet
// (owner MCP `assistant.push`), so /admin/screen-assistant shows them live on a phone. It also
// pulls the feed (`assistant.read`): another agent running a mock interview pushes its question
// (heard) and the owner's answer (said) there, and the app takes them as if it had heard them.
//
// Fire-and-forget: a slow or unreachable StandMeet never holds up the cue on the desktop.
// Pushes go out one at a time, in order, so a late partial never overwrites a finished cue.
// A failed push reconnects and tries once more (a restarted instance forgets MCP sessions).

const crypto = require('crypto');
const { getPreferences } = require('../storage');
const { createClient } = require('./standmeet');

const CUE_THROTTLE_MS = 300;
const PULL_MS = 1000;

let client = null;
let queue = Promise.resolve();
let pendingCue = null;
let cueTimer = null;
const own = new Set(); // ids this app pushed: pulled back, they are not someone else's
let pullTimer = null;

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
    own.add(event.id);
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

// publishSaid — the owner's own line (the microphone): transcript only, so the agent running the
// interview can read the answer back.
function publishSaid(text) {
    return push({ kind: 'said', id: crypto.randomUUID(), text });
}

// startPulling — calls onEvent({kind, text}) for each heard or said line another agent pushes from
// now on. What was already in the feed is history, not a question to answer.
async function startPulling(onEvent) {
    stopPulling();
    let since = null;
    const tick = async () => {
        try {
            const c = await connected();
            const { events, last_seq: last } = await c.tool('assistant.read', { since: since ?? 0 });
            const fresh = since === null ? [] : events;
            since = last;
            for (const e of fresh) {
                if (!own.has(e.id) && (e.kind === 'heard' || e.kind === 'said')) {
                    own.add(e.id);
                    onEvent(e);
                }
            }
        } catch (error) {
            client = null;
            console.error('[feed] pull', error.message);
        }
    };
    await tick();
    pullTimer = setInterval(tick, PULL_MS);
}

function stopPulling() {
    clearInterval(pullTimer);
    pullTimer = null;
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

module.exports = { publishTranscript, publishSaid, publishCue, newCueID, flushed, startPulling, stopPulling };
