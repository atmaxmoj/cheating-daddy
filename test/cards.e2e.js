// cards.e2e.js — what a cue card can show, and what the assistant says it is listening to
// (owner, 2026-10-13: "我可能还会需要这个cheating daddy有charts，支持md"; "在监听电脑的时候有指示灯说在监听
// 电脑，监听手机的时候有指示说监听手机").
//
// Contract:
//   - A ```mermaid fence in a card renders as a diagram once the fence is closed. While it streams,
//     and when the diagram does not parse, the card shows the code — never an error message.
//   - The cue prompt lets the model draw a chart when numbers are clearer as one; the phone feed
//     (assistant.push) still gets the raw markdown.
//   - While listening, an indicator says what is heard: "Listening: computer audio", or "Listening:
//     phone call" while a call runs on this Mac (iPhone calls answered here, FaceTime). A real call is
//     the only way to reach the second state, so this spec covers the first.

const test = require('node:test');
const assert = require('node:assert');
const { startStandMeet } = require('./helpers/fake-servers');
const { launchApp } = require('./helpers/launch');

const PIE = '```mermaid\npie title Builds\n    "under 2 min" : 70\n    "2 to 5 min" : 25\n    "over 5 min" : 5\n```';
const ERROR_TEXT = /syntax error|parse error|error in text|mermaid version/i;

test('cue cards', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { app, win } = await launchApp(t, standmeet.url);
    const card = win.locator('#responseContainer');
    // The main process hands the window a card the way the model's stream does.
    const send = (channel, text) => app.evaluate(({ BrowserWindow }, [c, m]) => BrowserWindow.getAllWindows()[0].webContents.send(c, m), [channel, text]);

    await t.test('listening: the indicator says computer audio', async () => {
        await win.locator('.start-button').click();
        await win.getByText('Ready (', { exact: false }).waitFor({ timeout: 120_000 });
        const indicator = win.locator('.listening-indicator');
        await indicator.waitFor({ timeout: 10_000 });
        assert.match(await indicator.textContent(), /Listening: computer audio/);
        assert.equal(await indicator.locator('.listening-dot').count(), 1, 'the live dot');
    });

    await t.test('a streaming chart shows its code, not an error', async () => {
        await send('new-response', '**Key: build times**\n\n' + PIE.split('\n').slice(0, 3).join('\n'));
        await card.getByText('Key:', { exact: false }).waitFor();
        await new Promise(r => setTimeout(r, 500));
        assert.equal(await card.locator('svg').count(), 0, 'no diagram before the fence closes');
        assert.doesNotMatch(await card.innerText(), ERROR_TEXT);
    });

    await t.test('the closed fence renders as a diagram', async () => {
        await send('update-response', `**Key: build times**\n\n${PIE}\n\n_From: build-times_`);
        await card.locator('svg').first().waitFor({ timeout: 10_000 });
        assert.doesNotMatch(await card.innerText(), ERROR_TEXT);
        assert.match(await card.innerText(), /From:/, 'the rest of the card still renders');
        await win.screenshot({ path: require('path').join(__dirname, '..', 'test-results', 'chart-card.png') });
    });

    await t.test('a diagram that does not parse stays code', async () => {
        await send('new-response', '**Key: broken**\n\n```mermaid\npie title Oops\n    this is not a chart :: ::\n```');
        await card.getByText('Key: broken', { exact: false }).waitFor();
        await new Promise(r => setTimeout(r, 1500));
        assert.equal(await card.locator('svg').count(), 0);
        assert.match(await card.innerText(), /this is not a chart/, 'the code is shown');
        assert.doesNotMatch(await win.locator('body').innerText(), ERROR_TEXT);
    });

    await t.test('the model draws a chart from the notes; the phone gets the markdown', async () => {
        const before = standmeet.calls.pushes.length;
        await win.locator('#textInput').fill('How are your YouTeacher build times split? Show it as a pie chart.');
        await win.locator('#textInput').press('Enter');
        await card.locator('svg').first().waitFor({ timeout: 60_000 });
        const deadline = Date.now() + 10_000;
        let last;
        while (Date.now() < deadline) {
            last = standmeet.calls.pushes.slice(before).filter(p => p.kind === 'cue').at(-1);
            if (last && /From:/.test(last.text)) break;
            await new Promise(r => setTimeout(r, 200));
        }
        assert.ok(last, 'a cue was pushed');
        assert.match(last.text, /```mermaid[\s\S]*pie[\s\S]*70/, 'the phone gets the raw chart markdown');
    });
});
