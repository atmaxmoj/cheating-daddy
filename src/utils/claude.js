// claude.js — streams a reply from the Anthropic Messages API.
//
// Takes the same OpenAI-style message list the local llama path builds ({role, content} with
// an optional system message and image_url parts), so localai.js swaps only the call, not the
// conversation code around it.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// toAnthropic — OpenAI-style messages → Anthropic's {system, messages}.
function toAnthropic(messages) {
    const system = messages
        .filter(m => m.role === 'system')
        .map(m => m.content)
        .join('\n\n');
    const rest = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: toContent(m.content) }));
    return { system, messages: rest };
}

function toContent(content) {
    if (typeof content === 'string') return content;
    return content.map(part => {
        if (part.type !== 'image_url') return part;
        const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    });
}

// requestClaude — POST with stream:true; calls onText with the text so far on every delta and
// resolves with the full text.
async function requestClaude({ apiKey, model, messages, maxTokens = 1024 }, onText) {
    if (!apiKey) throw new Error('Anthropic API key is not set');
    const { system, messages: turns } = toAnthropic(messages);
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({ model, system, messages: turns, max_tokens: maxTokens, stream: true }),
    });
    if (!response.ok || !response.body) {
        throw new Error(`Claude API returned HTTP ${response.status}: ${await response.text()}`);
    }
    return readStream(response, onText);
}

// readStream — Anthropic SSE: text arrives as content_block_delta events with a text_delta.
async function readStream(response, onText) {
    const decoder = new TextDecoder();
    let pending = '';
    let fullText = '';
    for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const event = JSON.parse(line.slice(6));
            if (event.type === 'error') throw new Error(`Claude stream error: ${event.error?.message}`);
            if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') continue;
            fullText += event.delta.text;
            onText(fullText);
        }
    }
    return fullText;
}

module.exports = { requestClaude };
