// fake-servers.js — a local stand-in for the StandMeet instance (owner MCP at POST /mcp):
// initialize, role_list, assistant.prepare/cue/push/read. Every call is recorded so a test can
// check what the app sent. The card is the server's: here it is a canned card for the question
// (cardFor), streamed into the feed under the asked id the way assistant.cue streams it. The real
// tools have their own e2e in the StandMeet repo (e2e/test/assistant-cue.spec.ts,
// screen-assistant.spec.ts); the card's quality is `npm run eval`, against the real server.
//
// Strict where the real server is: no Sigv1 header → 401; unknown session → 404.

const http = require('http');

const ROLES = [
    { id: 'r-sm', name: 'standmeet-only', description: 'Platform engineer interview', corpus_uris: ['wiki://software/project/standmeet/**'] },
];
// NOTE_COUNT — what assistant.prepare reports: the role's scope, or every wiki note.
const NOTE_COUNT = { 'r-sm': 3, '': 9 };
// HINT — assistant.prepare's names for Whisper, as the server builds them (projects, stack).
const HINT = 'standmeet, youteacher, bubblewrap, bwrap, Docker, Kubernetes, k8s, Postgres, River';
const ROUND_LIST = [
    { id: 'general', label: 'General', hint: 'Any note may help; the card picks its form.' },
    { id: 'technical', label: 'Technical deep-dive', hint: 'Only technology your own work shows you used — with the details.' },
    { id: 'mentor', label: 'Mentor', hint: 'Only what you took part in yourself.' },
];

const PIE = '```mermaid\npie title Builds\n    "under 2 min" : 70\n    "2 to 5 min" : 25\n    "over 5 min" : 5\n```';

// cardFor — the canned card the stand-in's assistant.cue writes for a question.
function cardFor(question) {
    if (/hear me|thanks for joining/i.test(question)) return '—';
    if (/docker|bubble ?wrap/i.test(question)) {
        return [
            '**Key: isolation + no docker.sock**',
            '**The backend never holds docker.sock, so plugins run in bubblewrap.**',
            '- Holding the socket: it would give the backend root on the host',
            '',
            '**Why this over the alternatives:**',
            '| Option | Picked | Good at | Why (not) here |',
            '|---|---|---|---|',
            '| bubblewrap | ✓ | namespaces without a daemon | needs no docker.sock |',
            '| Docker | | full containers | would hand the backend root on the host |',
            '',
            '_From: deployment_',
        ].join('\n');
    }
    if (/pie chart|build times/i.test(question)) return `**Key: build times**\n**Most builds finish in two minutes.**\n\n${PIE}\n\n_From: build-times_`;
    return [
        '**Key: isolation + sandbox**',
        '**Every build runs untrusted code in its own container, network off.**',
        '- Container per build: thrown away after the build',
        '- Network off: the code cannot reach anything',
        '- Isolation: one owner cannot touch another',
        '',
        '**Context — how it happened:**',
        '- Then: owners started uploading their own microsite code',
        '- Weighed: a shared builder against one container per build',
        '- Decided: one container per build with the network off, so a bad build stays in its box',
        '',
        '_From: sandbox_',
    ].join('\n');
}

async function startStandMeet() {
    // mcp: every request; pushes: the app's assistant.push args; cues: its assistant.cue args.
    const calls = { mcp: [], pushes: [], cues: [] };
    // feed — the instance's screen-assistant feed: the app's own pushes and what another agent
    // injects (inject), read back by assistant.read the way the real store does (one event per id,
    // latest text, after `since`).
    const feed = [];
    const append = e => feed.push({ ...e, seq: feed.length + 1, at: new Date().toISOString() });
    let sessions = 0;
    const live = new Set();

    const server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.url !== '/mcp') return res.writeHead(404).end();
        if (!/^Sigv1 keyId=test-key,ts=\d+,nonce=[\w-]+,sig=\S+$/.test(req.headers.authorization || '')) return json(res, 401, {});
        const msg = JSON.parse(body.toString());
        calls.mcp.push(msg);
        if (msg.method === 'initialize') {
            const sid = `s${++sessions}`;
            live.add(sid);
            res.setHeader('Mcp-Session-Id', sid);
            return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26' } });
        }
        if (!msg.id) return res.writeHead(202).end();
        if (!live.has(req.headers['mcp-session-id'])) return json(res, 404, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'session not found' } });
        const { name, arguments: args } = msg.params;
        const ok = payload => json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
        const fail = text => json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text }] } });
        if (name === 'role_list') return ok({ items: ROLES });
        if (name === 'assistant.prepare') {
            if (args.role_id && !ROLES.some(r => r.id === args.role_id)) return fail('no such role');
            return ok({ notes: NOTE_COUNT[args.role_id || ''], hint: HINT, rounds: ROUND_LIST, role: null });
        }
        if (name === 'assistant.cue') {
            calls.cues.push(args);
            const card = cardFor(args.question);
            const id = args.id || `srv-${calls.cues.length}`;
            // streamed as the server streams it: a first part, then the whole card
            append({ id, kind: 'cue', text: card.slice(0, Math.ceil(card.length / 2)) });
            await new Promise(r => setTimeout(r, 900));
            append({ id, kind: 'cue', text: card });
            return ok({ card, feed_id: id, model: 'stand-in' });
        }
        if (name === 'assistant.push') {
            calls.pushes.push(args);
            append(args);
            return ok({ seq: feed.length });
        }
        if (name === 'assistant.read') {
            const since = Number(args.since || 0);
            const after = feed.filter(e => e.seq > since);
            const latest = new Map();
            for (const e of after) latest.set(e.id, e);
            return ok({ events: [...latest.values()], last_seq: after.at(-1)?.seq ?? since });
        }
        return fail(`unknown tool ${name}`);
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        feed, // every event in the feed, in order (the app's pushes and the cards)
        cards: () => feed.filter(e => e.kind === 'cue'),
        inject: append, // another agent's assistant.push
        // the app polls the feed every 400 ms: its keep-alive socket is never idle, so close it
        close: () => new Promise(r => {
            server.close(r);
            server.closeAllConnections();
        }),
    };
}

function readBody(req) {
    return new Promise(resolve => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

function json(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

module.exports = { startStandMeet, ROLES };
