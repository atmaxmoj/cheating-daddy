// phone-screen.e2e.js — a recruiter phones about a job the owner applied to (owner, 2026-10-13):
// one key and the cues are there, built from the owner's fixed script and that job's brief.
//
// Contract:
//   - The corpus is read when the app launches, so pressing start reads none of it again.
//   - Every session reads the "Phone screen" subjectivity note and the briefs of applied jobs
//     (jobs.history status applied). The script answers what every screen asks.
//   - When the other side names a company the owner applied to, the session locks onto that job:
//     its brief rides with every later question, and no other job's brief does.

const test = require('node:test');
const assert = require('node:assert');
const { startStandMeet } = require('./helpers/fake-servers');
const { launchApp, say } = require('./helpers/launch');

const wikiReads = calls => calls.mcp.filter(m => m.params?.name === 'corpus.get' && m.params.arguments.genre === 'wiki').length;

async function nextCard(win, before) {
    const card = win.locator('#responseContainer');
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
        const text = await card.innerText().catch(() => '');
        if (text !== before && /From:/.test(text)) return text;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`no new card; last: ${await card.innerText()}`);
}

test('phone screen', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win } = await launchApp(t, standmeet.url);

    await t.test('the corpus is read at launch, before start is pressed', async () => {
        const deadline = Date.now() + 30_000;
        while (wikiReads(standmeet.calls) < 5 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
        assert.equal(wikiReads(standmeet.calls), 5, 'every wiki note read while the start screen waits');
        const atLaunch = wikiReads(standmeet.calls);
        await win.locator('.start-button').click();
        await win.getByText('Ready (5 notes)', { exact: false }).waitFor({ timeout: 120_000 });
        assert.equal(wikiReads(standmeet.calls), atLaunch, 'start reads none of it again');
        assert.ok(standmeet.calls.mcp.some(m => m.params?.name === 'jobs.history' && m.params.arguments.status === 'applied'), 'the briefs are read at start');
    });

    let card = '';
    await t.test('the fixed script answers pay', async () => {
        await say('Hi, this is Dana calling from Acme. To start, what are your salary expectations?');
        card = await nextCard(win, card);
        assert.match(card, /165|180/, `the figure from the script: ${card}`);
    });

    await t.test('the company named locks the call onto its brief', async () => {
        await say('Great. And what do you already know about the team you would join?');
        card = await nextCard(win, card);
        assert.match(card, /merchant risk|fraud|card payment/i, `Acme's brief: ${card}`);
        assert.doesNotMatch(card, /build farm|CI runner|tooling guild/i, 'not the other job');
    });
});
