// feed.test.js — streaming cards to StandMeet (/admin/screen-assistant on the phone).
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const storage = require('../src/storage');
const feed = require('../src/utils/feed');
const { startFakes } = require('./helpers/fake-servers');

test('feed', async t => {
    const fakes = await startFakes();
    t.after(fakes.close);
    storage.initializeStorage();
    storage.updatePreference('standmeetHost', `${fakes.url}/`);

    await t.test('a heard line and a cue arrive in order; the last cue push is the whole text', async () => {
        feed.publishTranscript('How do you isolate untrusted code?');
        const id = feed.newCueID();
        const growing = ['**Key:**', '**Key:** isolation', '**Key:** isolation + sandbox', '**Key:** isolation + sandbox\n\nEvery build…'];
        for (const text of growing) feed.publishCue(id, text, false);
        await feed.publishCue(id, growing.at(-1) + ' runs in its own container.', true);

        const [heard, ...cues] = fakes.calls.pushes;
        assert.deepEqual({ kind: heard.kind, text: heard.text }, { kind: 'heard', text: 'How do you isolate untrusted code?' });
        assert.ok(cues.length >= 1 && cues.every(c => c.kind === 'cue' && c.id === id));
        assert.ok(cues.length < growing.length + 1, `partials are throttled (${cues.length} pushes for ${growing.length + 1} updates)`);
        assert.equal(cues.at(-1).text, growing.at(-1) + ' runs in its own container.');
    });

    await t.test('a partial left in the throttle never lands after the final text', async () => {
        const before = fakes.calls.pushes.length;
        const id = feed.newCueID();
        feed.publishCue(id, 'partial', false);
        await feed.publishCue(id, 'final', true);
        await new Promise(r => setTimeout(r, 400)); // past the throttle window
        await feed.flushed();
        const mine = fakes.calls.pushes.slice(before).filter(p => p.id === id);
        assert.equal(mine.at(-1).text, 'final');
    });

    await t.test('when the instance restarts (sessions gone), the push reconnects and still arrives', async () => {
        fakes.behaviour.failPushes = 1;
        const sessionsBefore = fakes.calls.mcp.filter(m => m.method === 'initialize').length;
        await feed.publishTranscript('after the restart');
        assert.equal(fakes.calls.pushes.at(-1).text, 'after the restart');
        assert.equal(fakes.calls.mcp.filter(m => m.method === 'initialize').length, sessionsBefore + 1, 'one new session');
    });

    await t.test('an unreachable instance never throws into the cue loop', async () => {
        storage.updatePreference('standmeetHost', 'http://127.0.0.1:9');
        const errors = [];
        const orig = console.error;
        console.error = (...a) => errors.push(a.join(' '));
        try {
            await assert.doesNotReject(feed.publishTranscript('nobody listens'));
        } finally {
            console.error = orig;
        }
        assert.ok(errors.some(e => e.includes('[feed]')), 'the failure is logged');
    });
});
