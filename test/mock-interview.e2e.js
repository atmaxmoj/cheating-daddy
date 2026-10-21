// mock-interview.e2e.js — another agent runs the interview (owner, 2026-10-19: "如果我用别的agent来做
// 模拟面试，我也是需要那个agent把card给我的，但是这个题目注入，答案注入啥的都没有"; 2026-10-20: "让facade可以
// agent自己接管").
//
// Contract:
//   - A question another agent pushes to the feed (assistant.push kind=heard) is a "Them" line and
//     the app asks StandMeet for its card, exactly as for a question heard through the speakers. It
//     is not pushed back.
//   - A card another agent asked for itself (assistant.cue — the server writes it to the feed) shows
//     on the desktop without the app asking anything.
//   - An answer another agent pushes (kind=said) is a "Me" line: transcript only, no card.
//
// Real: Electron. Stand-in: the StandMeet instance and its feed (fake-servers.js); the other agent
// is the stand-in's inject(). What a card says is the server's (npm run eval).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startStandMeet } = require('./helpers/fake-servers');
const { ROOT, launchApp } = require('./helpers/launch');

test('mock interview', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win } = await launchApp(t, standmeet.url);
    const card = win.locator('#responseContainer');

    await win.locator('.start-button').click();
    await win.getByText('Ready (', { exact: false }).waitFor({ timeout: 120_000 });

    await t.test("an agent's question: a Them line and its card", async () => {
        standmeet.inject({ id: 'q1', kind: 'heard', text: 'How would you run untrusted code from your users safely?' });
        await win.locator('.transcript-line.them', { hasText: /untrusted code/i }).waitFor({ timeout: 15_000 });
        await card.getByText(/From:/).waitFor({ timeout: 30_000 });
        assert.match(await card.innerText(), /Context/, 'the whole card, Context included');
        assert.match(standmeet.calls.cues.at(-1).question, /untrusted code/i, 'the app asked for its card');
        assert.equal(standmeet.calls.pushes.filter(p => p.kind === 'heard').length, 0, 'the question is not pushed back');
        await win.screenshot({ path: path.join(ROOT, 'test-results', 'mock-interview-card.png') });
    });

    await t.test('a card the agent asked for itself shows here too', async () => {
        const asked = standmeet.calls.cues.length;
        standmeet.inject({ id: 'agent-c1', kind: 'cue', text: '**Key: queue + one database**' });
        standmeet.inject({ id: 'agent-c1', kind: 'cue', text: '**Key: queue + one database**\n**River keeps jobs in Postgres.**\n\n_From: job-queue_' });
        await card.getByText(/River keeps jobs in Postgres/).waitFor({ timeout: 10_000 });
        assert.equal(standmeet.calls.cues.length, asked, 'the app asked nothing');
    });

    await t.test("an agent's record of my answer: a Me line, no card", async () => {
        const asked = standmeet.calls.cues.length;
        standmeet.inject({ id: 'a1', kind: 'said', text: 'Each build runs in its own container with the network off.' });
        await win.locator('.transcript-line.me', { hasText: /network off/i }).waitFor({ timeout: 15_000 });
        await new Promise(r => setTimeout(r, 3000));
        assert.equal(standmeet.calls.cues.length, asked, 'no card for my own answer');
    });
});
