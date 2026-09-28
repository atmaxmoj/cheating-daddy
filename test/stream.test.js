// stream.test.js — reading the model's streamed answer (OpenAI SSE, llama-server and DeepSeek).
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { __test: a } = require('../src/utils/localai');

function response(chunks) {
    return {
        body: (async function* () {
            for (const c of chunks) yield Buffer.from(c);
        })(),
    };
}

const ev = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test('events split across network chunks are reassembled, and each step shows the text so far', async () => {
    const wire = ev('**Key:** ') + ev('isolation') + ev(' + sandbox') + 'data: [DONE]\n\n';
    const chunks = [wire.slice(0, 7), wire.slice(7, 40), wire.slice(40, 41), wire.slice(41)];
    const seen = [];
    const full = await a.readStreamingResponse(response(chunks), t => seen.push(t));
    assert.equal(full, '**Key:** isolation + sandbox');
    assert.deepEqual(seen, ['**Key:** ', '**Key:** isolation', '**Key:** isolation + sandbox']);
});

test('keep-alives, role-only deltas and [DONE] add no text', async () => {
    const wire = ': keep-alive\n\n' + `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n` + ev('hi') + 'data: [DONE]\n\n';
    const seen = [];
    assert.equal(await a.readStreamingResponse(response([wire]), t => seen.push(t)), 'hi');
    assert.deepEqual(seen, ['hi']);
});

test('DeepSeek model ids skip the local model runner', () => {
    assert.ok(a.isApiModel('deepseek:deepseek-flash'));
    assert.ok(!a.isApiModel('unsloth/Qwen3-4B-GGUF'));
    assert.ok(!a.isApiModel(undefined));
});
