// app.e2e.js — `npm run test:app`: the real app, end to end, driven like the user drives it.
//
// Real: Electron, system-audio capture, whisper.cpp, DeepSeek. Stand-in: the StandMeet instance
// (test/helpers/fake-servers.js) — its server side of assistant.push has its own e2e.
// The interviewer's question is spoken through the speakers with `say`, the way the other side
// of a call reaches the app. Needs: macOS, screen-recording permission for Electron, sound on.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startStandMeet } = require('./helpers/fake-servers');
const { ROOT, launchApp, say } = require('./helpers/launch');

test('screen assistant', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win, config } = await launchApp(t, standmeet.url);

    await t.test('start screen: StandMeet look, credited to Cheating Daddy', async () => {
        assert.equal(await win.title(), 'Screen Assistant');
        await win.getByText('modified from Cheating Daddy').waitFor();
        await win.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim().toLowerCase() === '#1b1814');
        assert.match(await win.evaluate(() => getComputedStyle(document.body).fontFamily), /Newsreader/);
        assert.equal(await win.locator('.start-button').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(181, 57, 28)');
        assert.equal(await win.getByText('Relay URL').count(), 0, 'cards go to StandMeet admin, not a relay');
    });

    await t.test('the role picker lists the instance roles; a pick is remembered', async () => {
        await win.locator('option', { hasText: 'standmeet-only' }).waitFor({ state: 'attached' });
        await win.locator('select').filter({ has: win.locator('option', { hasText: 'Whole wiki (no role)' }) }).selectOption({ label: 'standmeet-only' });
        await win.getByText('Platform engineer interview', { exact: false }).waitFor();
        await new Promise(r => setTimeout(r, 300));
        const prefs = JSON.parse(fs.readFileSync(path.join(config, 'preferences.json'), 'utf8'));
        assert.equal(prefs.standmeetRoleId, 'r-sm');
    });

    await t.test('start: the role-scoped corpus loads (3 notes) and it listens', async () => {
        await win.locator('.start-button').click();
        await win.getByText('Ready (3 notes)', { exact: false }).waitFor({ timeout: 120_000 });
    });

    await t.test('a spoken question: transcript line, then a cue card from the role notes', async () => {
        await say('How would you run untrusted code from your users safely?');
        const line = win.locator('.transcript-line').last();
        await line.waitFor({ timeout: 30_000 });
        assert.match(await line.innerText(), /untrusted code/i);

        const card = win.locator('#responseContainer');
        await card.getByText(/From:/).waitFor({ timeout: 30_000 });
        const text = await card.innerText();
        assert.match(text, /Key:/, 'the card opens with its Key');
        assert.match(text, /isolat|sandbox|container/i, 'it answers from the sandbox note');
        assert.match(text, /From:.*sandbox/i, 'it cites the role-scoped note');
        await win.screenshot({ path: path.join(ROOT, 'test-results', 'cue-card.png') });
    });

    await t.test('the phone feed got the heard line and the finished card', async () => {
        const card = await win.locator('#responseContainer').innerText();
        const deadline = Date.now() + 5000;
        let last;
        while (Date.now() < deadline) {
            last = standmeet.calls.pushes.filter(p => p.kind === 'cue').at(-1);
            if (last && /From:/.test(last.text)) break;
            await new Promise(r => setTimeout(r, 100));
        }
        assert.match(standmeet.calls.pushes.find(p => p.kind === 'heard').text, /untrusted code/i);
        assert.ok(last, 'a cue was pushed');
        assert.ok(card.includes(last.text.split('\n')[0].replace(/\*/g, '').trim().slice(0, 20)), 'the pushed card is the card on screen');
    });

    await t.test('a question naming a technology gets the choice matrix, pick first', async () => {
        await say('Why did you use bubblewrap for the plugin sandbox instead of Docker?');
        await win.locator('.transcript-line', { hasText: /docker/i }).waitFor({ timeout: 30_000 });
        const table = win.locator('#responseContainer table');
        await table.waitFor({ timeout: 30_000 });
        await win.locator('#responseContainer').getByText(/From:/).waitFor({ timeout: 30_000 });
        const rows = await table.locator('tbody tr').allInnerTexts();
        assert.match(rows[0], /bubble ?wrap|bwrap/i, 'the pick is the first row');
        assert.ok(rows.some(r => /docker/i.test(r)), 'Docker is weighed against it');
        await win.screenshot({ path: path.join(ROOT, 'test-results', 'choice-matrix.png') });
        await new Promise(r => setTimeout(r, 1500));
        assert.match(standmeet.calls.pushes.filter(p => p.kind === 'cue').at(-1).text, /\|\s*(bubble ?wrap|bwrap)/i, 'the phone gets the table too');
    });

    await t.test('small talk gives no card', async () => {
        const before = standmeet.calls.pushes.filter(p => p.kind === 'cue').length;
        await say('Great, can you hear me okay?');
        await win.locator('.transcript-line', { hasText: /hear me/i }).waitFor({ timeout: 30_000 });
        await new Promise(r => setTimeout(r, 6000));
        const cues = standmeet.calls.pushes.filter(p => p.kind === 'cue').slice(before);
        assert.ok(cues.every(c => c.text.trim() === '—'), `got ${JSON.stringify(cues.at(-1)?.text)}`);
    });
});
