// fake-servers.js — one local HTTP server standing in for everything the app talks to:
//   POST /mcp                  StandMeet owner MCP (initialize, corpus.list/get, role_list, assistant.push)
//   POST /inference            whisper.cpp server (answers `heard`)
//   POST /v1/chat/completions  llama-server, OpenAI SSE stream (answers `cue`, in chunks)
// Every request is recorded so a test can check what the app sent.
//
// It is stricter than it needs to be where the real server is strict: /mcp refuses a request
// without a Sigv1 Authorization header, and a tools/call before initialize.

const http = require('http');

const NOTES = [
    { id: 'n1', path: 'software/project/standmeet', title: 'standmeet', body: 'StandMeet is a self-hosted page where visitors chat with an AI grounded in my notes.' },
    { id: 'n2', path: 'software/project/standmeet/sandbox', title: 'sandbox', body: 'Every microsite build runs in its own container with the network off: isolation plus a sandbox.' },
    { id: 'n3', path: 'software/project/youteacher', title: 'youteacher', body: 'YouTeacher turns videos into lessons.' },
    { id: 'n4', path: 'cooking/risotto', title: 'risotto', body: 'Stir the rice slowly.' },
];

const ROLES = [
    { id: 'r-sm', name: 'standmeet-only', description: 'Platform engineer interview', corpus_uris: ['wiki://software/project/standmeet/**'] },
];

async function startFakes({ heard = 'How do you isolate untrusted code?', cue = ['**Key:** isolation + sandbox\n\n', 'Every build runs in its own container.'] } = {}) {
    const calls = { mcp: [], pushes: [], whisper: [], llama: [] };
    let sessions = 0;
    const live = new Set();
    const behaviour = { failPushes: 0, heard: null }; // heard: override what Whisper "hears"

    const server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        if (req.url === '/mcp') return mcp(req, res, body);
        if (req.url === '/inference') {
            calls.whisper.push(body.toString('latin1'));
            return json(res, 200, { text: behaviour.heard ?? heard });
        }
        if (req.url === '/v1/chat/completions') {
            calls.llama.push(JSON.parse(body.toString()));
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for (const piece of cue) {
                // split each event across two writes: the client must buffer partial lines
                const line = `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
                res.write(line.slice(0, 10));
                await new Promise(r => setTimeout(r, 5));
                res.write(line.slice(10));
            }
            res.end('data: [DONE]\n\n');
            return;
        }
        res.writeHead(404).end();
    });

    function mcp(req, res, body) {
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
            // two pages of one: the client must follow next_cursor
            const start = Number(args.cursor || 0);
            const items = NOTES.slice(start, start + 2).map(({ id, path, title }) => ({ id, path, title, preview: '' }));
            return ok({ items, ...(start + 2 < NOTES.length ? { next_cursor: String(start + 2) } : {}) });
        }
        if (name === 'corpus.get') return ok({ body: NOTES.find(n => n.id === args.id).body });
        if (name === 'role_list') return ok({ items: ROLES });
        if (name === 'assistant.push') {
            if (behaviour.failPushes > 0) {
                behaviour.failPushes--;
                live.clear(); // the server restarted: every session is gone
                return json(res, 404, { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'session not found' } });
            }
            calls.pushes.push(args);
            return ok({ seq: calls.pushes.length });
        }
        return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] } });
    }

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return { url, calls, behaviour, close: () => new Promise(r => server.close(r)) };
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

module.exports = { startFakes, NOTES, ROLES };
