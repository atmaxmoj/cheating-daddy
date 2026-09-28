// rubric.test.js — the eval's own checks must pass a good card and fail each kind of bad one;
// otherwise a green eval says nothing.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { check } = require('../eval/rubric');

const context = `# Your projects
- standmeet: self-hosted page where visitors chat with an AI grounded in my notes.
- youteacher: turns videos into lessons.

# Notes that match what was just said
## untrusted-build-bulkhead (software/untrusted-build-bulkhead)
Each build runs in its own container with the network off.`;

const c = { kind: 'answer', notes: /bulkhead/, key: /isolat|sandbox/ };

const good = `**Key: isolation + sandbox**
**Run each user's code where it cannot reach anything else.**
- Own container per build: one user's code never shares a process or disk with another
- Network off by default: the build cannot call out or reach internal services
- Short-lived: the container is thrown away after one build, so nothing persists between runs

**Example:** in StandMeet, owners upload their own microsite code; every build runs in its own container with the network off, so a broken or hostile site never touches the instance.

_From: untrusted-build-bulkhead_`;

const failed = card => Object.entries(check(card, context, c)).filter(([, v]) => !v.ok).map(([k]) => k);

test('a well-formed card passes every check', () => {
    assert.deepEqual(failed(good), []);
});

test('each defect fails its own check', () => {
    assert.ok(failed(good.replace('**Key: isolation + sandbox**', '**Key: bulkhead pattern for untrusted build isolation**')).includes('keyPlain'));
    assert.ok(failed(good.replace('isolation + sandbox', 'pricing + growth')).includes('keyOnTopic'));
    assert.ok(failed(good.replace(/- Short-lived.*\n/, '').replace(/- Network off.*\n/, '')).includes('points'));
    assert.ok(failed(good.replace('in StandMeet, owners', 'at Google, engineers')).includes('ownExample'));
    assert.ok(failed(good.replace('_From: untrusted-build-bulkhead_', '_From: untrusted-build-bulkhead, kubernetes-guide_')).includes('fromIsReal'));
    assert.ok(failed(good.replace(/^\*\*Key.*\n/, '')).includes('keyLine'));
    assert.ok(failed('**Key: isolation + sandbox**\n**Short.**').includes('length'));
});

test('a context that missed the right note fails retrieval', () => {
    assert.ok(Object.entries(check(good, context.replace(/bulkhead/g, 'other'), c)).some(([k, v]) => k === 'retrieval' && !v.ok));
});

test('small talk must be a dash; an uncovered question must say so', () => {
    assert.ok(check('—', context, { kind: 'smalltalk' }).dash.ok);
    assert.ok(!check('**Key: hello**', context, { kind: 'smalltalk' }).dash.ok);
    assert.ok(check('Not in your notes — ask what they mean by actuator sizing', context, { kind: 'outside' }).notInNotes.ok);
    assert.ok(!check(good, context, { kind: 'outside' }).notInNotes.ok, 'a confident card on an uncovered topic is a failure');
});
