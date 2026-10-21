// feed.js — the app's line to StandMeet's screen assistant (owner MCP). It pushes what the app
// hears (assistant.push heard / said), asks for the cue card (assistant.cue — the card is made on
// the server and streamed into the feed), and pulls the feed (assistant.read): the growing cards,
// and the lines another agent running a mock interview pushes there.
//
// Pushes are fire-and-forget: a slow or unreachable StandMeet never holds up the transcript. They
// go out one at a time, in order. A failed call reconnects and tries once more (a restarted
// instance forgets MCP sessions).

const crypto = require('crypto');
const { getPreferences } = require('../storage');
const { createClient } = require('./standmeet');

const PULL_MS = 400; // a card grows on screen at this pace

let client = null;
let queue = Promise.resolve();
const own = new Set(); // lines this app pushed: pulled back, they are not someone else's
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

// call — one owner MCP tool call. A transport failure reconnects and tries once more; the tool's
// own answer ("no such role") is thrown as it is.
async function call(name, args) {
    try {
        return await (await connected()).tool(name, args);
    } catch (error) {
        if (error.message.startsWith(`StandMeet ${name}:`)) throw error;
        client = null;
        return (await connected()).tool(name, args);
    }
}

function push(event) {
    own.add(event.id);
    queue = queue
        .then(() => call('assistant.push', event))
        .catch(error => console.error('[feed]', error.message));
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

// startPulling — calls onEvent(event) for each card in the feed (growing text under one id, from
// this app's asks or another agent's) and each heard or said line another agent pushes, from now
// on. What was already in the feed is history, not a question to answer.
async function startPulling(onEvent) {
    stopPulling();
    let since = null;
    const tick = async () => {
        try {
            const { events, last_seq: last } = await call('assistant.read', { since: since ?? 0 });
            const fresh = since === null ? [] : events;
            since = last;
            for (const e of fresh) {
                if (e.kind === 'cue') onEvent(e);
                else if (!own.has(e.id)) {
                    own.add(e.id);
                    onEvent(e);
                }
            }
        } catch (error) {
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

// newCueID — one id per card; the feed keeps the latest text under it.
function newCueID() {
    return crypto.randomUUID();
}

// flushed — resolves once every push queued so far has settled (tests; quitting).
function flushed() {
    return queue;
}

module.exports = { call, publishTranscript, publishSaid, newCueID, flushed, startPulling, stopPulling };
