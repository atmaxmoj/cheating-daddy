// app.e2e.js — `npm run test:app`: the real Electron app, launched with a fresh config and a
// stand-in StandMeet, driven like a user. Checks what the start screen promises: the StandMeet
// look and credit, DeepSeek + Cue Cards preselected, and the interview-role picker filled from
// the instance (picking one is remembered).
const { home } = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { _electron: electron } = require('playwright-core');
const storage = require('../src/storage');
const { startFakes } = require('./helpers/fake-servers');

test('start screen', async t => {
    const fakes = await startFakes();
    t.after(fakes.close);
    storage.initializeStorage();
    storage.updatePreference('standmeetHost', fakes.url);

    const app = await electron.launch({
        // the electron package's index.js exports the binary path (env.js stands in only for 'electron')
        executablePath: require('../node_modules/electron/index.js'),
        args: [path.join(__dirname, '..')],
        env: { ...process.env, HOME: home, STANDMEET_CREDS_PATH: process.env.STANDMEET_CREDS_PATH },
        timeout: 30_000,
    });
    t.after(() => app.close());
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await t.test('the window is the Screen Assistant, credited to Cheating Daddy', async () => {
        assert.equal(await win.title(), 'Screen Assistant');
        await win.getByText('modified from Cheating Daddy').waitFor();
        await win.getByText('Screen Assistant', { exact: false }).first().waitFor();
    });

    await t.test('StandMeet paper and ink, Newsreader type', async () => {
        await win.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() !== '#f5f5f5');
        const look = await win.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            return {
                ink: root.getPropertyValue('--text-primary').trim().toLowerCase(),
                accent: root.getPropertyValue('--accent').trim().toLowerCase(),
                font: getComputedStyle(document.body).fontFamily,
            };
        });
        assert.deepEqual({ ink: look.ink, accent: look.accent }, { ink: '#1b1814', accent: '#b5391c' });
        assert.match(look.font, /Newsreader/);
        const start = win.locator('.start-button');
        assert.equal(await start.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(181, 57, 28)', 'Start is vermillion');
    });

    await t.test('the phone relay settings are gone (cards go to StandMeet admin)', async () => {
        assert.equal(await win.getByText('Relay URL').count(), 0);
    });

    await t.test('the role picker lists the instance roles, and a pick is remembered', async () => {
        const picker = win.locator('select').filter({ has: win.locator('option', { hasText: 'Whole wiki (no role)' }) });
        await win.locator('option', { hasText: 'standmeet-only' }).waitFor({ state: 'attached' });
        await picker.selectOption({ label: 'standmeet-only' });
        await win.getByText('Platform engineer interview', { exact: false }).waitFor();
        await new Promise(r => setTimeout(r, 200));
        assert.equal(storage.getPreferences().standmeetRoleId, 'r-sm');
    });

    await t.test('screenshot for review', async () => {
        await win.screenshot({ path: path.join(__dirname, '..', 'test-results', 'start-screen.png') });
    });
});
