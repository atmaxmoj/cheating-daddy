// fake-servers.js — a local stand-in for the StandMeet instance (owner MCP at POST /mcp):
// initialize, corpus.list/get, role_list, assistant.push. Every call is recorded so a test can
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
    { id: 'n4', path: 'cooking/risotto', title: 'risotto', body: 'Stir the rice slowly.' },
];

const ROLES = [
    { id: 'r-sm', name: 'standmeet-only', description: 'Platform engineer interview', corpus_uris: ['wiki://software/project/standmeet/**'] },
];

async function startStandMeet() {
    const calls = { mcp: [], pushes: [] };
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
            return ok({ seq: calls.pushes.length });
        }
        return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] } });
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => server.close(r)) };
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
