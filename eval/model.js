// model.js — the judge that grades a card (the card itself comes from StandMeet's assistant.cue).

const { getCredentials } = require('../src/storage');

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'deepseek-v4-pro';
const KEY = process.env.DEEPSEEK_API_KEY || getCredentials().deepseekApiKey;

async function chat(model, messages, maxTokens = 800) {
    if (!KEY) throw new Error('no DeepSeek key: set DEEPSEEK_API_KEY or save one in the app');
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).choices[0].message.content;
}

const JUDGE = `You grade a cue card shown to a job candidate during a live interview. The candidate reads it to answer in their own words.
The card format is fixed: line 1 "**Key: a + b**" is a deliberate memory hook (two or three plain ideas), NOT the answer — do not grade it as a tagline. Line 2 (bold) is the answer; then points, an Example, a From line.
Score each 1-5:
- asked: line 2 and the points answer the question as asked ("what problem" -> the problem, "how" -> the approach), not a tagline.
- grounded: every claim is supported by the CONTEXT; nothing invented (names, numbers, projects).
- speakable: the candidate could talk for a minute from it; points carry concrete details, plain words.
- supplement: ONLY if the card has a "**Supplementary:**" line (else null): it adds something the rest of the card does not say (a likely follow-up with its answer, a number, a trade-off), useful in this interview, and supported by the CONTEXT.
Reply with JSON only: {"asked":n,"grounded":n,"speakable":n,"supplement":n|null,"why":"<one sentence on the weakest score>"}`;

async function judge(q, context, card) {
    const raw = await chat(JUDGE_MODEL, [
        { role: 'system', content: JUDGE },
        { role: 'user', content: `QUESTION: ${q}\n\nCONTEXT:\n${context}\n\nCARD:\n${card}` },
    ], 300);
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) throw new Error(`judge gave no JSON: ${raw.slice(0, 120)}`);
    return JSON.parse(m[0]);
}

module.exports = { judge, JUDGE_MODEL, KEY };
