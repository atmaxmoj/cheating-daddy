// relay.js — mirrors what the assistant hears and cues to the phone relay (relay/server.js).
//
// Off unless the user set a relay URL and token. Fire-and-forget: a slow or unreachable relay
// never holds up the cue on the desktop.

const crypto = require('crypto');
const { getPreferences, getCredentials } = require('../storage');

const CUE_THROTTLE_MS = 300;

let pendingCue = null;
let cueTimer = null;

function target() {
    const url = (getPreferences().relayUrl || '').trim().replace(/\/$/, '');
    const token = getCredentials().relayToken || '';
    return url && token ? { url, token } : null;
}

function post(event) {
    const t = target();
    if (!t) return;
    fetch(`${t.url}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` },
        body: JSON.stringify(event),
    })
        .then(res => {
            if (!res.ok) console.error('[relay] HTTP', res.status);
        })
        .catch(error => console.error('[relay]', error.message));
}

function publishTranscript(text) {
    post({ kind: 'transcript', id: crypto.randomUUID(), text });
}

// newCueID — one id per cue, so the relay replaces the streaming versions in place.
function newCueID() {
    return crypto.randomUUID();
}

// publishCue — partial updates are throttled; the final one always goes out.
function publishCue(id, text, final) {
    pendingCue = { kind: 'cue', id, text, final };
    if (final) {
        clearTimeout(cueTimer);
        cueTimer = null;
        post(pendingCue);
        pendingCue = null;
        return;
    }
    if (cueTimer) return;
    cueTimer = setTimeout(() => {
        cueTimer = null;
        if (pendingCue) post(pendingCue);
        pendingCue = null;
    }, CUE_THROTTLE_MS);
}

module.exports = { publishTranscript, publishCue, newCueID };
