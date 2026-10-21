// standmeet.js — the owner MCP client: the app's line to the user's StandMeet instance, signed with
// the same Ed25519 Sigv1 credentials the StandMeet MCP client uses. The cue card itself is made on
// the server (assistant.cue, see feed.js): the role's notes, the search, the prompt and the model
// all live there, so every driver — this app, a mock-interview agent — gets the same card.
//
// Host: preference `standmeetHost` (default https://sijie.xyz).
// Credentials: $STANDMEET_CREDS_PATH or ~/.standmeet/credentials.json ({keyId, privateKeyPem}).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadCreds() {
    const file = process.env.STANDMEET_CREDS_PATH || path.join(os.homedir(), '.standmeet', 'credentials.json');
    const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!creds.keyId || !creds.privateKeyPem) throw new Error(`${file} is missing keyId or privateKeyPem`);
    return { keyId: creds.keyId, key: crypto.createPrivateKey(creds.privateKeyPem) };
}

function authHeader(creds) {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const challenge = Buffer.from(`standmeet-sigv1\n${creds.keyId}\n${ts}\n${nonce}`, 'utf8');
    const sig = crypto.sign(null, challenge, creds.key).toString('base64');
    return `Sigv1 keyId=${creds.keyId},ts=${ts},nonce=${nonce},sig=${sig}`;
}

function createClient(host) {
    const creds = loadCreds();
    let session = null;
    let nextID = 1;

    async function rpc(method, params, notify = false) {
        const headers = { Authorization: authHeader(creds), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
        if (session) headers['Mcp-Session-Id'] = session;
        const body = { jsonrpc: '2.0', method, params, ...(notify ? {} : { id: nextID++ }) };
        const res = await fetch(`${host}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
        session = res.headers.get('mcp-session-id') || session;
        const text = (await res.text()).trim();
        if (notify) return null;
        if (!res.ok || !text) throw new Error(`StandMeet ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
        const line = text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data:')).slice(5);
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(`StandMeet ${method}: ${msg.error.message}`);
        return msg.result;
    }

    async function tool(name, args) {
        const result = await rpc('tools/call', { name, arguments: args });
        const text = result.content?.[0]?.text || '';
        if (result.isError) throw new Error(`StandMeet ${name}: ${text.slice(0, 200)}`);
        return JSON.parse(text);
    }

    return {
        async connect() {
            await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cue-cards', version: '1' } });
            await rpc('notifications/initialized', {}, true);
        },
        tool,
    };
}

// listRoles — the user's roles for the start screen (one StandMeet role per interview: its
// corpus_uris are the notes the cards may use).
async function listRoles(host) {
    const client = createClient(host.replace(/\/$/, ''));
    await client.connect();
    const page = await client.tool('role_list', { limit: 200 });
    return page.items.map(r => ({ id: r.id, name: r.name, description: r.description || '', corpus_uris: r.corpus_uris || [] }));
}

module.exports = { createClient, listRoles };
