// iphone-calls.e2e.js — how an iPhone call reaches the assistant (owner, 2026-10-13: "我现在也没看出来，
// 怎么监听我的iPhone，完全看不出来").
//
// Contract: the start screen shows a short "iPhone calls" panel — the steps that route an iPhone
// call to this Mac, and a live line saying whether a call is on this Mac now (the CallState
// helper). The same panel opens from the listening indicator during a session. A real call is the
// only way to reach the "call on" state, so this spec covers the no-call state.

const test = require('node:test');
const assert = require('node:assert');
const { startStandMeet } = require('./helpers/fake-servers');
const { launchApp } = require('./helpers/launch');

const STEPS = [/Calls on Other Devices/, /Calls from iPhone/, /same Apple ID/i, /answer on the Mac/i, /⌘↩/];

test('iPhone calls', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win } = await launchApp(t, standmeet.url);

    await t.test('the start screen says how to route an iPhone call here', async () => {
        const panel = win.locator('.iphone-calls');
        await panel.waitFor({ timeout: 15_000 });
        const text = await panel.innerText();
        for (const step of STEPS) assert.match(text, step);
        await panel.getByText('No call on this Mac right now').waitFor({ timeout: 10_000 });
        await panel.scrollIntoViewIfNeeded();
        await win.screenshot({ path: require('path').join(__dirname, '..', 'test-results', 'iphone-calls.png') });
    });

    await t.test('the listening indicator opens the same panel', async () => {
        await win.locator('.start-button').click();
        await win.getByText('Ready (', { exact: false }).waitFor({ timeout: 120_000 });
        await win.locator('.listening-indicator').getByRole('button', { name: /iPhone calls/ }).click();
        const panel = win.locator('assistant-view .iphone-calls');
        await panel.getByText('Calls from iPhone', { exact: false }).waitFor({ timeout: 5_000 });
        await panel.getByText('No call on this Mac right now').waitFor({ timeout: 10_000 });
    });
});
