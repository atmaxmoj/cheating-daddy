// claude.check.js — `node src/utils/claude.check.js`: runs requestClaude against a canned SSE
// response (no network, no key) and checks the request shape and the streamed text.

const assert = require('assert');
const { requestClaude } = require('./claude');

const sse = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"- stages"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" & gates"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

async function main() {
    let sent = null;
    global.fetch = async (url, init) => {
        sent = { url, init, body: JSON.parse(init.body) };
        const body = (async function* () {
            for (const s of sse) yield new TextEncoder().encode(s);
        })();
        return { ok: true, body };
    };

    const seen = [];
    const text = await requestClaude(
        {
            apiKey: 'k',
            model: 'claude-haiku-4-5-20251001',
            messages: [
                { role: 'system', content: 'be a cue card' },
                { role: 'user', content: 'How do you verify agents?' },
                { role: 'user', content: [{ type: 'text', text: 'this' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] },
            ],
        },
        t => seen.push(t),
    );

    assert.equal(text, '- stages & gates');
    assert.deepEqual(seen, ['- stages', '- stages & gates']);
    assert.equal(sent.init.headers['x-api-key'], 'k');
    assert.equal(sent.body.system, 'be a cue card');
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.messages[1].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
    await assert.rejects(requestClaude({ apiKey: '', model: 'm', messages: [] }, () => {}), /API key/);
    console.log('claude ok');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
