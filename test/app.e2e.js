// app.e2e.js — `npm run test:app`: the real app, end to end, driven like the user drives it.
//
// Real: Electron, system-audio capture, whisper.cpp. Stand-in: the StandMeet instance
// (test/helpers/fake-servers.js), which makes the card (assistant.cue) — the real tool has its own
// e2e in the StandMeet repo. This spec checks the facade: what the app asks and what it shows.
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

    await t.test('a spoken question: transcript line, then the card StandMeet made for it', async () => {
        await say('How would you run untrusted code from your users safely?');
        const line = win.locator('.transcript-line').last();
        await line.waitFor({ timeout: 30_000 });
        assert.match(await line.innerText(), /untrusted code/i);

        const card = win.locator('#responseContainer');
        await card.getByText(/From:/).waitFor({ timeout: 30_000 });
        const text = await card.innerText();
        assert.match(text, /Key:/, 'the card opens with its Key');
        assert.match(text, /From:.*sandbox/i, 'the whole card, not the first streamed part');
        await win.screenshot({ path: path.join(ROOT, 'test-results', 'cue-card.png') });

        const ask = standmeet.calls.cues.at(-1);
        assert.match(ask.question, /untrusted code/i, 'the heard line is the question');
        assert.equal(ask.role_id, 'r-sm', 'the role picked on the start screen');
        assert.equal(ask.round, 'general');
        assert.ok(ask.call_id, 'one call id for the interview');
    });

    await t.test('the phone feed got the heard line; the card is the card on screen', async () => {
        const card = await win.locator('#responseContainer').innerText();
        assert.match(standmeet.calls.pushes.find(p => p.kind === 'heard').text, /untrusted code/i);
        assert.equal(standmeet.calls.pushes.filter(p => p.kind === 'cue').length, 0, 'the app pushes no card: the server writes it');
        const last = standmeet.cards().at(-1);
        assert.ok(card.includes(last.text.split('\n')[0].replace(/\*/g, '').trim().slice(0, 20)), 'the feed card is the card on screen');
    });

    await t.test('a card with the choice matrix shows it as a table, pick first', async () => {
        await say('Why did you use bubblewrap for the plugin sandbox instead of Docker?');
        await win.locator('.transcript-line', { hasText: /docker/i }).waitFor({ timeout: 30_000 });
        const table = win.locator('#responseContainer table');
        await table.waitFor({ timeout: 30_000 });
        await win.locator('#responseContainer').getByText(/From:/).waitFor({ timeout: 30_000 });
        const rows = await table.locator('tbody tr').allInnerTexts();
        assert.match(rows[0], /bubble ?wrap|bwrap/i, 'the pick is the first row');
        assert.ok(rows.some(r => /docker/i.test(r)), 'Docker is weighed against it');
        await win.screenshot({ path: path.join(ROOT, 'test-results', 'choice-matrix.png') });
        const calls = new Set(standmeet.calls.cues.map(c => c.call_id));
        assert.equal(calls.size, 1, 'the same call id for every question of the interview');
    });

    await t.test('small talk: the card is a dash', async () => {
        const before = standmeet.calls.cues.length;
        await say('Great, can you hear me okay?');
        await win.locator('.transcript-line', { hasText: /hear me/i }).waitFor({ timeout: 30_000 });
        await new Promise(r => setTimeout(r, 3000));
        assert.equal(standmeet.calls.cues.length, before + 1, 'the line was asked');
        assert.equal(standmeet.cards().at(-1).text, '—');
    });
});
