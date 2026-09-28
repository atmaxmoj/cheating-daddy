// standmeet.test.js — the cue context: note cleaning, retrieval, role scoping, and reading the
// corpus over the owner MCP (against a local stand-in instance).
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/utils/standmeet');
const { startFakes, ROLES } = require('./helpers/fake-servers');

test('role globs: a/** covers a, * stays in one segment', () => {
    const inScope = s.uriMatcher(['wiki://software/project/standmeet/**', 'subjectivity://cv', 'output://*']);
    assert.ok(inScope('wiki://software/project/standmeet'));
    assert.ok(inScope('wiki://software/project/standmeet/architecture/key-designs'));
    assert.ok(!inScope('wiki://software/project/standmeet-old'), 'a sibling with the same prefix is out');
    assert.ok(!inScope('wiki://software/project/youteacher'));
    assert.ok(inScope('subjectivity://cv') && !inScope('subjectivity://cv/old'));
    assert.ok(inScope('output://talk') && !inScope('output://talk/slides'));
    assert.ok(s.uriMatcher(['wiki://**'])('wiki://math/logic/turing-machines'));
    assert.ok(!s.uriMatcher([])('wiki://anything'), 'no globs, no notes');
});

test('a bilingual note reads as its English pane, links as their labels, no code', () => {
    const text = s.cleanBody(
        [
            '> [!i18n]',
            '> <label><input type="radio" name="x-lang" checked>EN</label>',
            '>',
            '> > [!lang] en',
            '> > # Stages & gates',
            '> > The gate fixes *what counts as done*; see [[script|scripting]] and [[relaxation]].',
            '> > ```tikz',
            '> > \\draw (0,0) -- (1,1);',
            '> > ```',
            '>',
            '> > [!lang] zh',
            '> > # 阶段与关卡',
        ].join('\n'),
    );
    assert.ok(text.startsWith('Stages & gates'), text);
    assert.ok(text.includes('see scripting and relaxation'));
    assert.ok(!text.includes('阶段') && !text.includes('tikz') && !text.includes('<label'), text);
    assert.equal(s.cleanBody(null), '');
});

test('retrieval: split names, word forms, CJK, and no match for small talk', () => {
    const index = s.buildIndex([
        { title: 'stages-and-gates', path: 'cybernetics/theory/stages-and-gates', text: 'gate fixes what counts as done' },
        { title: 'untrusted-build-bulkhead', path: 'software/untrusted-build-bulkhead', text: 'run untrusted code in a sandbox, network off' },
        { title: '短视频', path: 'marketing/短视频', text: '三秒钩子' },
        { title: 'standmeet', path: 'software/project/standmeet', text: 'audience-tailored introduction' },
        { title: 'testing-software-3-0', path: 'cybernetics/engineering/testing-software-3-0', text: 'golden sets and evals' },
    ]);
    assert.equal(s.search(index, 'Tell me about stand meet')[0].title, 'standmeet');
    assert.equal(s.search(index, 'How do you test prompts?')[0].title, 'testing-software-3-0');
    assert.equal(s.search(index, 'How would you run untrusted code?')[0].title, 'untrusted-build-bulkhead');
    const iso = s.buildIndex([
        { title: 'sandbox', path: 'p/sandbox', text: 'isolation plus a sandbox' },
        { title: 'other', path: 'p/other', text: 'unrelated words here' },
    ]);
    assert.equal(s.search(iso, 'How do you isolate builds?')[0]?.title, 'sandbox', 'isolate meets isolation');
    assert.equal(s.search(iso, 'what did you create?').length, 0, 'create is not stemmed onto unrelated words');
    assert.equal(s.search(index, 'what is a gate')[0].title, 'stages-and-gates');
    assert.equal(s.search(index, '短视频怎么做')[0].title, '短视频');
    assert.deepEqual(s.search(index, 'How was your weekend?'), []);
    assert.equal(s.search(index, 'untrusted sandbox gate', 1).length, 1, 'k caps the result');
});

test('before the corpus loads there is no context and no Whisper hint', () => {
    assert.equal(s.contextFor('anything'), '');
    assert.equal(s.transcriptionHint(), '');
    assert.ok(!s.isLoaded());
});

test('loading follows every page, and a role limits the notes to its globs', async t => {
    const fakes = await startFakes();
    t.after(fakes.close);

    const roles = await s.listRoles(fakes.url);
    assert.deepEqual(roles.map(r => r.name), [ROLES[0].name]);

    assert.equal(await s.loadCorpus(fakes.url), 4, 'no role: all four wiki notes, across two pages');

    const progress = [];
    const n = await s.loadCorpus(fakes.url, roles[0], (done, total) => progress.push(`${done}/${total}`));
    assert.equal(n, 2, 'the standmeet role sees the standmeet project and its sandbox note');
    assert.equal(progress.at(-1), '2/2');

    const ctx = s.contextFor('How do you isolate untrusted code?');
    assert.match(ctx, /# This interview\nstandmeet-only — Platform engineer interview/);
    assert.match(ctx, /## sandbox \(software\/project\/standmeet\/sandbox\)\nEvery microsite build runs in its own container/);
    assert.ok(!ctx.includes('YouTeacher') && !ctx.includes('risotto'), 'out-of-role notes never reach the prompt');
    assert.match(s.transcriptionHint(), /standmeet/);
});

test('a request without the signed header is refused by the stand-in (it checks what the app sends)', async t => {
    const fakes = await startFakes();
    t.after(fakes.close);
    const res = await fetch(`${fakes.url}/mcp`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
    assert.equal(res.status, 401);
});
