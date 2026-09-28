// standmeet.js — the user's own corpus as the cue context, instead of a pasted "context" box.
//
// At session start the app reads every wiki note from the user's StandMeet instance over the
// owner MCP (the same Ed25519 Sigv1 credentials the StandMeet MCP client uses), keeps the English
// text in memory and builds a small BM25 index. Per question, the top notes become the context of
// that one request: retrieval is local and takes milliseconds, so the only network hop in the cue
// loop is the model.
//
// Host: preference `standmeetHost` (default https://sijie.xyz).
// Credentials: $STANDMEET_CREDS_PATH or ~/.standmeet/credentials.json ({keyId, privateKeyPem}).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PAGE = 200;
const CONCURRENCY = 16;
const NOTE_CHARS = 4000; // kept per note (and searched)
const CONTEXT_CHARS = 2000; // per note in a prompt: enough for the details and examples a cue needs
const TOP_K = 6;
const PROJECT_K = 3; // extra slots for the user's project notes (the source of the cue's example)
const STACK_K = 3; // extra slots for the sections about a technology the question names

// ── owner MCP client ──

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

// ── note text ──

// cleanBody — the English pane of a bilingual note as plain prose: callout quoting, HTML, code
// and diagram blocks, and wiki-link brackets removed.
function cleanBody(body) {
    return plain(englishPane(body)).slice(0, NOTE_CHARS);
}

// englishPane — the English pane with quoting, HTML, code and link brackets removed; headings kept.
function englishPane(body) {
    let text = body || '';
    const en = text.indexOf('[!lang] en');
    if (en >= 0) {
        const rest = text.slice(en + '[!lang] en'.length);
        const next = rest.indexOf('[!lang]');
        text = next >= 0 ? rest.slice(0, next) : rest;
    }
    return text
        .split('\n')
        .map(l => l.replace(/^(\s*>\s?)+/, ''))
        .join('\n')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[!i18n\]|\[!lang\][^\n]*/g, ' ');
}

function plain(text) {
    return text
        .replace(/^#+\s*/gm, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// sections — a note split at its "## " headings. A long note keeps its later sections (the
// reasons behind a choice often sit far down: "why bubblewrap, not Docker" is section 4 of
// `deployment`), and a question pulls in the one section that answers it, not the note's opening.
function sections(body) {
    return englishPane(body)
        .split(/\n(?=##\s)/)
        .map(s => {
            const m = /^##\s+(.+)/.exec(s);
            return { heading: m ? m[1].trim() : '', text: plain(s).slice(0, NOTE_CHARS) };
        })
        .filter(s => s.text);
}

// ── BM25 index ──

const STOP = new Set(
    'the a an and or of to in on for with is are was were be it this that as at by from you your how what why do does did can could would should i me my we our they their about have has had not but if so tell'.split(
        ' ',
    ),
);

// stem — a light suffix strip so "test" meets "testing" and "tests", "isolate" meets "isolation".
function stem(w) {
    if (w.length > 6 && w.endsWith('ation')) return w.slice(0, -5);
    if (w.length > 5 && /[^aeiou]ate[sd]?$/.test(w)) return w.replace(/ate[sd]?$/, '');
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
}

// tokens — lowercase stemmed words, plus character bigrams for CJK runs (no spaces to split on).
// joinPairs adds each adjacent pair glued together: speech splits names ("stand meet", "you
// teacher") that the notes spell as one word.
function tokens(text, joinPairs = false) {
    const out = [];
    const words = (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    for (const w of words) if (w.length > 1 && !STOP.has(w)) out.push(stem(w));
    if (joinPairs) for (let i = 0; i < words.length - 1; i++) out.push(stem(words[i] + words[i + 1]));
    for (const run of (text || '').match(/[一-鿿]+/g) || []) {
        for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
    return out;
}

function buildIndex(notes) {
    const docs = notes.map(n => {
        const words = [...tokens(n.title), ...tokens(n.title), ...tokens(n.title), ...tokens(n.path), ...tokens(n.text)];
        const tf = new Map();
        for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
        return { note: n, tf, len: words.length };
    });
    const df = new Map();
    for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
    return { docs, df, avg, n: docs.length };
}

function search(index, query, k = TOP_K, where = () => true) {
    const terms = [...new Set(tokens(query, true))];
    const k1 = 1.2;
    const b = 0.75;
    return index.docs
        .filter(d => where(d.note))
        .map(d => {
            let score = 0;
            for (const t of terms) {
                const f = d.tf.get(t);
                if (!f) continue;
                const idf = Math.log(1 + (index.n - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5));
                score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avg));
            }
            return { note: d.note, score };
        })
        .filter(r => r.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, k)
        .map(r => r.note);
}

// ── corpus ──

async function listAll(client, genre) {
    const items = [];
    let cursor;
    do {
        const page = await client.tool('corpus.list', { genre, limit: PAGE, ...(cursor ? { cursor } : {}) });
        items.push(...page.items);
        cursor = page.next_cursor;
    } while (cursor);
    return items;
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

let index = null;
let projects = ''; // the user's project overviews, sent with every question

const PROJECT_ROOT = /^software\/project\/[^/]+$/;
const PROJECT_CHARS = 400;

// projectOverview — "tell me about yourself" shares no words with the notes that answer it; the
// project root notes do, so they ride along with every question.
function projectOverview(notes) {
    return notes
        .filter(n => PROJECT_ROOT.test(n.path) && n.text)
        .map(n => `- ${n.title}: ${n.text.replace(/\s+/g, ' ').slice(0, PROJECT_CHARS)}`)
        .join('\n');
}

// ── roles: one StandMeet role per interview ──
//
// A role's corpus_uris ("wiki://software/**", "subjectivity://cv", …) decide which notes this
// interview's cues may draw on, and its description says what the interview is for. The same
// roles scope what visitors see on the instance; here they scope the user's own cue context.

const LISTABLE = ['wiki', 'output', 'subjectivity']; // genres corpus.list serves

// uriMatcher — a role's URI globs as one test: "**" spans segments, "*" stays inside one, and
// "a/**" also covers "a" itself.
function uriMatcher(globs) {
    const patterns = globs.map(g => {
        const re = g
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\/\*\*$/, '(/.*)?')
            .replace(/\*\*/g, '.*')
            .replace(/(?<!\.)\*/g, '[^/]*');
        return new RegExp(`^${re}$`);
    });
    return uri => patterns.some(p => p.test(uri));
}

// listRoles — the user's roles for the start screen.
async function listRoles(host) {
    const client = createClient(host.replace(/\/$/, ''));
    await client.connect();
    const page = await client.tool('role_list', { limit: 200 });
    return page.items.map(r => ({ id: r.id, name: r.name, description: r.description || '', corpus_uris: r.corpus_uris || [] }));
}

let roleBrief = ''; // "this interview is for …", from the chosen role

// loadCorpus — reads the notes the role may see (all wiki notes when there is no role) and builds
// the index. onProgress(done, total) for the status line. Resolves with the note count.
async function loadCorpus(host, role = null, onProgress = () => {}) {
    const client = createClient(host.replace(/\/$/, ''));
    await client.connect();
    const globs = role ? role.corpus_uris : ['wiki://**'];
    const inScope = uriMatcher(globs);
    const genres = LISTABLE.filter(g => globs.some(u => u.startsWith(`${g}://`)));
    const listed = [];
    for (const genre of genres) {
        for (const item of await listAll(client, genre)) {
            if (inScope(`${genre}://${item.path || ''}`)) listed.push({ ...item, genre });
        }
    }
    let done = 0;
    const notes = await mapLimit(listed, CONCURRENCY, async item => {
        const full = await client.tool('corpus.get', { genre: item.genre, id: item.id }).catch(() => null);
        onProgress(++done, listed.length);
        const body = full ? full.body : item.preview;
        return { title: item.title, path: item.path || '', text: cleanBody(body), sections: sections(body) };
    });
    roleBrief = role ? `${role.name}${role.description ? ` — ${role.description}` : ''}` : '';
    const usable = notes.filter(n => n.text || n.title);
    projects = projectOverview(usable);
    vocabulary = usable
        .filter(n => PROJECT_ROOT.test(n.path))
        .map(n => n.title.replace(/[-_]/g, ' '))
        .join(', ');
    // one search unit per section; a note without headings is one unit
    const units = usable.flatMap(n =>
        n.sections.length > 1
            ? n.sections.map(s => ({ title: s.heading ? `${n.title} › ${s.heading}` : n.title, path: n.path, text: s.text }))
            : [{ title: n.title, path: n.path, text: n.text }],
    );
    index = buildIndex(units);
    return usable.length;
}

// STACK — technology names that turn on the choice matrix when a question names one. Deciding
// this in code, not in the prompt: left to the model, "include it only when…" held 5 times in 9
// (eval, 2026-09-28). Aliases map to the name the notes use.
// ponytail: a hand-kept list; a name missing here gets no matrix — add it when a question misses.
const STACK = {
    bubblewrap: /\b(bubble ?wrap|bwrap)\b/i,
    Docker: /\bdocker\b/i,
    Podman: /\bpodman\b/i,
    Firecracker: /\bfirecracker\b/i,
    gVisor: /\bg ?visor\b/i,
    Kubernetes: /\b(kubernetes|k8s)\b/i,
    Postgres: /\bpostgres(ql)?\b/i,
    pgvector: /\bpg ?vector\b/i,
    Redis: /\bredis\b/i,
    River: /\bRiver\b/,
    Kafka: /\bkafka\b/i,
    RabbitMQ: /\brabbit ?mq\b/i,
    NATS: /\bnats\b/i,
    SQLite: /\bsqlite\b/i,
    MongoDB: /\bmongo(db)?\b/i,
    Meilisearch: /\bmeili ?search\b/i,
    Elasticsearch: /\belastic ?search\b/i,
    MinIO: /\bmin ?io\b/i,
    Gotenberg: /\bgotenberg\b/i,
    Typst: /\btypst\b/i,
    Puppeteer: /\bpuppeteer\b/i,
    Playwright: /\bplaywright\b/i,
    'Next.js': /\bnext ?(\.|dot )?js\b/i,
    // Names that are also everyday words match only as proper nouns ("React", not "how do you react").
    React: /\bReact(\.?js)?\b/,
    Vite: /\bvite\b/i,
    Tailwind: /\btailwind\b/i,
    Puck: /\bPuck\b/,
    Go: /\b(golang|go backend|in go)\b/i,
    Electron: /\belectron\b/i,
    Whisper: /\bWhisper\b/,
    DeepSeek: /\bdeep ?seek\b/i,
    Traefik: /\btraefik\b/i,
    Caddy: /\bCaddy\b/,
    Coolify: /\bcoolify\b/i,
    CircleCI: /\bcircle ?ci\b/i,
    MCP: /\bmcp\b/i,
    sqlc: /\bsqlc\b/i,
};

// stackIn — the technologies a question names, as the notes spell them.
function stackIn(query) {
    return Object.keys(STACK).filter(name => STACK[name].test(query || ''));
}

const MATRIX_ON = names =>
    `# Choice matrix: REQUIRED\nThis question names ${names.join(', ')}. Include the choice matrix, ${names[0]} in the first row, alternatives for the same job from the notes. If the notes name no alternative for this job, write the one line _No alternatives in your notes._ in its place.`;
const MATRIX_OFF = '# Choice matrix: OFF\nThis question names no technology. Do not include a choice matrix.';

// contextFor — the user's projects, then the notes most relevant to what was just said, as prompt
// text ('' before loading).
function contextFor(query) {
    if (!index) return '';
    // The cue's example must come from the user's own projects, so project notes get their own
    // slots next to the best matches from the whole corpus. A named technology gets its own slots
    // too: the sections most about it are where the notes weigh it against its alternatives.
    const named = stackIn(query);
    const general = search(index, query);
    const fromProjects = search(index, query, PROJECT_K, n => n.path.startsWith('software/project/'));
    const aboutStack = named.length ? search(index, named.join(' '), STACK_K) : [];
    const picked = [...new Set([...general, ...fromProjects, ...aboutStack])];
    const notes = picked.map(n => `## ${n.title} (${n.path})\n${n.text.slice(0, CONTEXT_CHARS)}`).join('\n\n');
    const brief = roleBrief ? `# This interview\n${roleBrief}\nLead with what matters for this role.\n\n` : '';
    const matrix = named.length ? MATRIX_ON(named) : MATRIX_OFF;
    return `${brief}${matrix}\n\n# Your projects\n${projects}\n\n# Notes that match what was just said\n${notes}`;
}

function isLoaded() {
    return index !== null;
}

let vocabulary = '';

// transcriptionHint — the user's own names (projects and top-level topics) for Whisper's prompt,
// so "StandMeet" is not heard as "stand meet". '' before loading.
function transcriptionHint() {
    return vocabulary;
}

module.exports = { createClient, loadCorpus, listRoles, contextFor, isLoaded, transcriptionHint, cleanBody, buildIndex, search, uriMatcher };
