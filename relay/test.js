// test.js — `node relay/test.js`: starts the relay on a spare port and checks the contract the
// desktop app and the phone page rely on. Exits non-zero on the first failure.

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const TOKEN = 'test-token-0123456789';
const BASE = `http://127.0.0.1:${PORT}/cheating-daddy`;

function post(url, body, headers = {}) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

// readEvents — collects SSE data frames until `count` have arrived.
async function readEvents(res, count) {
    const out = [];
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop();
        for (const f of frames) if (f.startsWith('data: ')) out.push(JSON.parse(f.slice(6)));
        if (out.length >= count) return out;
    }
    return out;
}

async function main() {
    const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        env: { ...process.env, PORT: String(PORT), CUE_TOKEN: TOKEN },
        stdio: 'inherit',
    });
    try {
        await new Promise(r => setTimeout(r, 400));
        const auth = { authorization: `Bearer ${TOKEN}` };

        assert.equal((await post(`${BASE}/api/events`, { kind: 'cue', text: 'x' })).status, 401, 'events need the token');
        assert.equal((await post(`${BASE}/api/events`, { kind: 'nope', text: 'x' }, auth)).status, 400, 'unknown kind');
        assert.equal((await fetch(`${BASE}/api/stream`)).status, 401, 'stream needs a session');
        assert.equal((await post(`${BASE}/api/login`, { token: 'wrong' })).status, 401, 'wrong token');

        const login = await post(`${BASE}/api/login`, { token: TOKEN });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        assert.ok(!cookie.includes(TOKEN), 'the cookie never carries the token');

        // Backlog: a cue streamed twice under one id is kept once, in its final form; a late
        // partial after the final does not undo it.
        await post(`${BASE}/api/events`, { kind: 'transcript', id: 't1', text: 'Tell me about yourself' }, auth);
        await post(`${BASE}/api/events`, { kind: 'cue', id: 'c1', text: '- Stand', final: false }, auth);
        await post(`${BASE}/api/events`, { kind: 'cue', id: 'c1', text: '- StandMeet\n- YouTeacher', final: true }, auth);
        await post(`${BASE}/api/events`, { kind: 'cue', id: 'c1', text: '- Stand', final: false }, auth);

        const stream = await fetch(`${BASE}/api/stream`, { headers: { cookie } });
        assert.equal(stream.status, 200);
        const live = readEvents(stream, 2);
        await new Promise(r => setTimeout(r, 100));
        await post(`${BASE}/api/events`, { kind: 'cue', id: 'c2', text: '- stages & gates', final: true }, auth);
        const [hello, pushed] = await live;

        assert.equal(hello.kind, 'hello');
        assert.deepEqual(hello.backlog.map(e => [e.id, e.text]), [
            ['t1', 'Tell me about yourself'],
            ['c1', '- StandMeet\n- YouTeacher'],
        ]);
        assert.equal(pushed.id, 'c2', 'a live event reaches an open phone');

        const page = await (await fetch(`${BASE}/`)).text();
        assert.ok(page.includes("const BASE = '/cheating-daddy'"), 'the page knows its base path');
        console.log('relay ok');
    } finally {
        server.kill();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
