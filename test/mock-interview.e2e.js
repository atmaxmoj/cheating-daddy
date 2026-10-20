// mock-interview.e2e.js — another agent runs the interview (owner, 2026-10-19: "如果我用别的agent来做
// 模拟面试，我也是需要那个agent把card给我的，但是这个题目注入，答案注入啥的都没有"), and a card
// reminds the owner of what happened, not only what to say ("答题能不能有的给出context啊，因为有的我也忘了").
//
// Contract:
//   - A question another agent pushes to the feed (assistant.push kind=heard) is a "Them" line and
//     gets a card, exactly like a question heard through the speakers. It is not pushed back.
//   - An answer another agent pushes (kind=said) is a "Me" line: transcript only, no card.
//   - A card ends with Context: the owner's own words from the notes it cites, verbatim.
//
// Real: Electron, DeepSeek. Stand-in: the StandMeet instance and its feed (fake-servers.js); the
// other agent is the stand-in's inject().

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startStandMeet } = require('./helpers/fake-servers');
const { ROOT, launchApp } = require('./helpers/launch');

test('mock interview', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win } = await launchApp(t, standmeet.url);

    await win.locator('.start-button').click();
    await win.getByText('Ready (', { exact: false }).waitFor({ timeout: 120_000 });

    await t.test("an agent's question: a Them line and a card", async () => {
        standmeet.inject({ id: 'q1', kind: 'heard', text: 'How would you run untrusted code from your users safely?' });
        const them = win.locator('.transcript-line.them', { hasText: /untrusted code/i });
        await them.waitFor({ timeout: 15_000 });
        const card = win.locator('#responseContainer');
        await card.getByText(/From:/).waitFor({ timeout: 30_000 });
        assert.match(await card.innerText(), /Key:/);
        assert.equal(standmeet.calls.pushes.filter(p => p.kind === 'heard').length, 0, 'the question is not pushed back');
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !standmeet.calls.pushes.some(p => p.kind === 'cue' && /From:/.test(p.text))) {
            await new Promise(r => setTimeout(r, 100));
        }
        assert.ok(standmeet.calls.pushes.some(p => p.kind === 'cue' && /From:/.test(p.text)), 'the card reached the feed');
    });

    // Context = how it happened (owner: "context应该是告诉我当时在干什么，我当时怎么做的决定之类的" —
    // a quoted note opening was rejected as useless): what they were doing, and the decision with
    // its reason, from the notes. The sandbox notes give one: untrusted builds → own container,
    // network off; no docker.sock for the backend, since holding it means root on the host.
    await t.test('the card carries Context: what I was doing and how I decided', async () => {
        const card = win.locator('#responseContainer');
        await card.getByText(/Context/).waitFor({ timeout: 10_000 });
        const text = await card.innerText();
        const context = text.slice(text.search(/Context/));
        assert.match(context, /Then:/, 'what I was working on');
        const decided = /Decided:([^\n]+)/.exec(context);
        assert.ok(decided, 'the decision');
        assert.match(decided[1], /container|network|sandbox|bubble ?wrap|docker\.?sock|root/i, `a decision from the notes: ${decided[1]}`);
        await win.screenshot({ path: path.join(ROOT, 'test-results', 'mock-interview-card.png') });
        await new Promise(r => setTimeout(r, 1500));
        assert.match(standmeet.calls.pushes.filter(p => p.kind === 'cue').at(-1).text, /Context/, 'the phone gets it too');
    });

    await t.test("an agent's record of my answer: a Me line, no card", async () => {
        const cues = standmeet.calls.pushes.filter(p => p.kind === 'cue').length;
        standmeet.inject({ id: 'a1', kind: 'said', text: 'Each build runs in its own container with the network off.' });
        const me = win.locator('.transcript-line.me', { hasText: /network off/i });
        await me.waitFor({ timeout: 15_000 });
        await new Promise(r => setTimeout(r, 5000));
        assert.equal(standmeet.calls.pushes.filter(p => p.kind === 'cue').length, cues, 'no card for my own answer');
    });
});
