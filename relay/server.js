// relay — carries the live cues from the desktop app to a phone.
//
// The desktop app POSTs each transcript line and each cue; a phone that has logged in with the
// shared token watches them arrive over Server-Sent Events. Nothing is written to disk: the last
// events live in memory so a phone that opens mid-meeting catches up, and a restart forgets them.
//
//   POST {BASE}/api/events   Authorization: Bearer <CUE_TOKEN>   {kind, id, text, final}
//   POST {BASE}/api/login    {token}  → sets the session cookie
//   GET  {BASE}/api/stream   (cookie) → text/event-stream
//   GET  {BASE}/             the phone page
//
// Env: CUE_TOKEN (required), PORT (8080), BASE_PATH ('/cheating-daddy'), BACKLOG (60).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.CUE_TOKEN || '';
const PORT = Number(process.env.PORT || 8080);
const BASE = (process.env.BASE_PATH || '/cheating-daddy').replace(/\/$/, '');
const BACKLOG = Number(process.env.BACKLOG || 60);
const MAX_BODY = 64 * 1024;
const COOKIE = 'cue_session';

if (TOKEN.length < 16) {
    console.error('CUE_TOKEN must be set (at least 16 characters)');
    process.exit(1);
}

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8').replaceAll('__BASE__', BASE);
// The session cookie is an HMAC of the token, so it never carries the token itself.
const SESSION = crypto.createHmac('sha256', TOKEN).update('cue-session').digest('hex');

const events = []; // the backlog, oldest first
const clients = new Set();

function same(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieOf(req) {
    const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return match ? match[1] : '';
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
}

// record — an event with the same id replaces the earlier one (a cue streams in as it is
// written), so the backlog holds each cue once, in its latest form.
function record(event) {
    const at = events.findIndex(e => e.id === event.id);
    // Requests race: a streaming partial that lands after the final must not undo it.
    if (at >= 0 && events[at].final && !event.final) return;
    if (at >= 0) events.splice(at, 1);
    events.push(event);
    while (events.length > BACKLOG) events.shift();
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(frame);
}

function normalize(input) {
    const kinds = ['transcript', 'cue', 'status'];
    if (!input || !kinds.includes(input.kind) || typeof input.text !== 'string') return null;
    return {
        kind: input.kind,
        id: typeof input.id === 'string' && input.id ? input.id.slice(0, 64) : crypto.randomUUID(),
        text: input.text.slice(0, 4000),
        final: input.final !== false,
        at: Date.now(),
    };
}

async function postEvent(req, res) {
    const auth = req.headers.authorization || '';
    if (!same(auth, `Bearer ${TOKEN}`)) return send(res, 401, { error: 'bad token' });
    let event;
    try {
        event = normalize(JSON.parse(await readBody(req)));
    } catch {
        return send(res, 400, { error: 'body must be JSON' });
    }
    if (!event) return send(res, 400, { error: 'expected {kind: transcript|cue|status, text}' });
    record(event);
    return send(res, 200, { ok: true, id: event.id });
}

async function login(req, res) {
    let token = '';
    try {
        token = JSON.parse(await readBody(req)).token || '';
    } catch {
        return send(res, 400, { error: 'body must be JSON' });
    }
    if (!same(token, TOKEN)) return send(res, 401, { error: 'wrong token' });
    // Secure when the request reached the proxy over https (production); a phone on the LAN
    // talking plain http would never store a Secure cookie.
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    const cookie = `${COOKIE}=${SESSION}; Path=${BASE}; HttpOnly${secure}; SameSite=Strict; Max-Age=2592000`;
    return send(res, 200, { ok: true }, { 'set-cookie': cookie });
}

function stream(req, res) {
    if (!same(cookieOf(req), SESSION)) return send(res, 401, { error: 'log in first' });
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ kind: 'hello', backlog: events })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://relay');
    const route = `${req.method} ${url.pathname.replace(/\/$/, '')}`;
    if (route === `GET ${BASE}` || route === `GET ${BASE}/index.html`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(PAGE);
    }
    if (route === `POST ${BASE}/api/events`) return void postEvent(req, res);
    if (route === `POST ${BASE}/api/login`) return void login(req, res);
    if (route === `GET ${BASE}/api/stream`) return stream(req, res);
    if (route === `GET ${BASE}/api/health`) return send(res, 200, { ok: true, clients: clients.size });
    return send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`relay listening on :${PORT}${BASE}`));
