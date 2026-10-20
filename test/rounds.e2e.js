// rounds.e2e.js — the interview round decides what a card may draw on and how it talks (owner,
// 2026-10-19: "技术面那就只能聊自己懂得技术，但是hr就是没有自己不懂得技术，不同的轮次面试这个也是不一样的",
// "还有mentor，只聊自己亲自参与过的").
//
// Contract (each can go red):
//   - HR: no technical apparatus on the card — no choice matrix, no code, even when the question
//     names a technology.
//   - Technical: only technology the owner's own notes show they used. A collected fact about a
//     tool (someone else's Kafka) is not the owner knowing it.
//   - Mentor: only what the owner took part in. Someone else's failure (a collected fact) is not
//     the owner's story.
//
// The corpus (fake-servers.js) holds the owner's own failure (first-launch) next to two collected
// facts (knight-capital, kafka-at-linkedin). Real: Electron, DeepSeek; questions are injected
// through the feed as another agent would.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startStandMeet } = require('./helpers/fake-servers');
const { ROOT, launchApp } = require('./helpers/launch');

// cardFor — a fresh app in `round`; the card for `question`, as text, with its table and code count.
async function cardFor(t, round, question) {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win } = await launchApp(t, standmeet.url);
    await win.locator('select').filter({ has: win.locator('option', { hasText: 'Technical deep-dive' }) }).selectOption({ label: round });
    await win.locator('.start-button').click();
    await win.getByText('Ready (', { exact: false }).waitFor({ timeout: 120_000 });
    standmeet.inject({ id: 'q', kind: 'heard', text: question });
    const card = win.locator('#responseContainer');
    await card.getByText(/From:|Not in your notes/).waitFor({ timeout: 40_000 });
    await new Promise(r => setTimeout(r, 1500)); // let the stream finish
    await win.screenshot({ path: path.join(ROOT, 'test-results', `round-${round.split(' ')[0].toLowerCase()}.png`) });
    return {
        text: await card.innerText(),
        tables: await card.locator('table').count(),
        code: await card.locator('code').count(),
    };
}

test('HR round: no technical apparatus, even on a technology question', async t => {
    const card = await cardFor(t, 'HR / behavioural', 'Why did you use bubblewrap for the plugin sandbox instead of Docker?');
    assert.equal(card.tables, 0, 'no choice matrix');
    assert.equal(card.code, 0, 'no code');
    // the first passing card still read "root on the host box", "control socket", "daemon"
    assert.doesNotMatch(card.text, /docker\.sock|namespaces?|--\w|\broot\b|socket|daemon/i, `no implementation jargon: ${card.text}`);
});

// CLAIMS_KAFKA — the card says the owner used Kafka ("I've worked with Kafka", "we ran Kafka").
// (a later run: "I've worked alongside Kafka … I've built services against a log like that")
const CLAIMS_KAFKA = /\b(I|we)('ve| have)? (ran|run|used|operated|built|worked (with|alongside|on))\b[^.\n]*(kafka|a log like)|^yes\b/im;
// SAYS_NOT — says plainly the owner has not run it ("Not in production myself — I know what Kafka is for").
// (and "Not in my own work — my production experience is with sandboxing…")
const SAYS_NOT = /not in (your|my) (notes|own work)|not in production|haven't (used|run|worked)|not (used|run|operated)|didn't (use|run)|never (used|run)/i;

test('Technical round: a collected fact about a tool is not knowing it', async t => {
    const card = await cardFor(t, 'Technical deep-dive', 'Have you run Kafka in production?');
    assert.doesNotMatch(card.text, CLAIMS_KAFKA, `claims Kafka: ${card.text}`);
    assert.match(card.text, SAYS_NOT, 'says so plainly');
});

// Any round: the first run of the General round answered "Yes — I've worked with Kafka as the
// durable message log between services, the way LinkedIn runs it" from someone else's note.
test('General round: someone else’s fact is never my experience', async t => {
    const card = await cardFor(t, 'General', 'Have you run Kafka in production?');
    assert.doesNotMatch(card.text, CLAIMS_KAFKA, `claims Kafka: ${card.text}`);
    assert.match(card.text, SAYS_NOT, 'says so plainly');
});

test('Mentor round: only what I took part in', async t => {
    const card = await cardFor(t, 'Mentor', 'Tell me about a project that went wrong and what you learned.');
    const from = /From:([^\n]*)/.exec(card.text)?.[1] || '';
    assert.doesNotMatch(from, /knight/i, `someone else's failure is not my story: ${from}`);
    assert.doesNotMatch(card.text, /knight capital/i);
    assert.match(card.text, /YouTeacher|review/i, 'my own failure');
});
