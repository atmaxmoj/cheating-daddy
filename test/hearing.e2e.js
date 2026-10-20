// hearing.e2e.js — the app hears the owner's technology names as names (owner, 2026-10-20: "我们有没有做
// stt的非准确捕捉干扰测验？有可能query是要重写的").
//
// eval/stt.js measured it: Whisper's prompt held only the project names, so every voice heard
// "bubblewrap" as "bubble wrap" and an Irish voice heard "Postgres" as "Post because". The
// mis-heard line is what the card model reads and what retrieval searches. An LLM rewrite of the
// line was measured too and rejected: +0.8 s per question, and it turned noise into wrong names
// ("graph" → "gVisor"). The fix is the stack names in Whisper's prompt.
//
// Real: Electron, system-audio capture, whisper.cpp. The other side speaks with an accent (Moira,
// en_IE) through the speakers.

const test = require('node:test');
const assert = require('node:assert');
const { startStandMeet } = require('./helpers/fake-servers');
const { launchApp, say } = require('./helpers/launch');

test('technology names are heard as names', async t => {
    const standmeet = await startStandMeet();
    t.after(standmeet.close);
    const { win } = await launchApp(t, standmeet.url);
    await win.locator('.start-button').click();
    await win.getByText('Ready (', { exact: false }).waitFor({ timeout: 120_000 });

    await say('Why did you use bubblewrap for the plugin sandbox instead of Docker?', 'Moira');
    const sandbox = win.locator('.transcript-line', { hasText: /sandbox/i });
    await sandbox.waitFor({ timeout: 30_000 });
    assert.match(await sandbox.innerText(), /bubblewrap/i, 'one word, as the notes spell it');

    await say('Why did you build the job queue on River and Postgres rather than a message broker?', 'Moira');
    const queue = win.locator('.transcript-line', { hasText: /broker/i });
    await queue.waitFor({ timeout: 30_000 });
    assert.match(await queue.innerText(), /postgres/i);
});
