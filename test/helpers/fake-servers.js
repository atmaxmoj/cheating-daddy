// fake-servers.js — a local stand-in for the StandMeet instance (owner MCP at POST /mcp):
// initialize, corpus.list/get, jobs.history, role_list, assistant.push/read. Every call is recorded so a test can
// check what the app sent. The real server's side of assistant.push has its own e2e in the
// StandMeet repo (e2e/test/screen-assistant.spec.ts).
//
// Strict where the real server is: no Sigv1 header → 401; unknown session → 404.

const http = require('http');

const NOTES = [
    { id: 'n1', path: 'software/project/standmeet', title: 'standmeet', body: 'StandMeet is a self-hosted page where visitors chat with an AI grounded in my notes. Owners upload their own microsite code.' },
    { id: 'n2', path: 'software/project/standmeet/sandbox', title: 'sandbox', body: 'Every microsite build from an owner runs untrusted code, so each build runs in its own container with the network off: isolation plus a sandbox. The container is thrown away after the build.' },
    {
        id: 'n5',
        path: 'software/project/standmeet/deployment',
        title: 'deployment',
        body: '# Deployment\n\nOne box, docker compose.\n\n## Why bubblewrap and not Docker for the plugin sandbox\n\nThe backend deliberately gets no docker.sock: holding it would give the backend root on the host. So the plugin sandbox runs on bubblewrap, which builds user and mount namespaces without a daemon. Docker would have given full containers, but only by handing the backend the socket.',
    },
    { id: 'n3', path: 'software/project/youteacher', title: 'youteacher', body: 'YouTeacher turns videos into lessons.' },
    {
        id: 'n6',
        path: 'software/project/youteacher/build-times',
        title: 'build-times',
        body: 'YouTeacher lesson builds last quarter: 70 percent finished in under two minutes, 25 percent took two to five minutes, 5 percent took over five minutes.',
    },
    { id: 'n4', path: 'cooking/risotto', title: 'risotto', body: 'Stir the rice slowly.' },
];

// The phone screen: the owner's fixed script (a subjectivity note) and the briefs the job loop keeps
// on applied postings (jobs.history status applied).
const SCRIPT = {
    id: 's1',
    path: 'phone-screen',
    title: 'Phone screen',
    body: '# Phone screen\n\n## Pay expectations\n\nI am looking for 165 to 180 thousand Canadian base, flexible for the right team.\n\n## Work authorization\n\nOpen work permit in Canada, no sponsorship needed today.',
};
const APPLIED = [
    {
        job_seen_id: 'j1', company: 'Acme', title: 'Backend Engineer', status: 'applied', application_id: 'a1',
        brief: '## Team\nThe merchant risk team: eight engineers who score card payments for fraud in real time.\n\n## My angle\nThe StandMeet sandbox: isolating untrusted work.',
    },
    {
        job_seen_id: 'j2', company: 'Globex', title: 'Platform Engineer', status: 'applied', application_id: 'a2',
        brief: '## Team\nThe developer tooling guild: four engineers who own the build farm and CI runners.',
    },
    { job_seen_id: 'j3', company: 'Initech', title: 'SRE', status: 'applied', application_id: 'a3' },
];

const ROLES = [
    { id: 'r-sm', name: 'standmeet-only', description: 'Platform engineer interview', corpus_uris: ['wiki://software/project/standmeet/**'] },
];

async function startStandMeet() {
    const calls = { mcp: [], pushes: [] };
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
        if (name === 'corpus.list' && args.genre === 'subjectivity') {
            return ok({ items: [{ id: SCRIPT.id, path: SCRIPT.path, title: SCRIPT.title, preview: '' }] });
        }
        if (name === 'corpus.get' && args.genre === 'subjectivity') return ok({ body: SCRIPT.body });
        if (name === 'jobs.history') {
            return ok({ items: args.status === 'applied' ? APPLIED : [] });
        }
        if (name === 'corpus.list') {
            if (args.genre !== 'wiki') return ok({ items: [] });
            const start = Number(args.cursor || 0); // two per page: the app must follow next_cursor
            const items = NOTES.slice(start, start + 2).map(({ id, path, title }) => ({ id, path, title, preview: '' }));
            return ok({ items, ...(start + 2 < NOTES.length ? { next_cursor: String(start + 2) } : {}) });
        }
        if (name === 'corpus.get') return ok({ body: NOTES.find(n => n.id === args.id).body });
        if (name === 'role_list') return ok({ items: ROLES });
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
        return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] } });
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        inject: append, // another agent's assistant.push
        close: () => new Promise(r => server.close(r)),
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

module.exports = { startStandMeet, NOTES, ROLES };
