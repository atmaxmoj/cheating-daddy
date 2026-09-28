// standmeet.check.js — `node src/utils/standmeet.check.js`: the offline half of standmeet.js — note
// cleaning and retrieval ranking. (Loading the corpus needs a live instance and credentials.)

const assert = require('assert');
const { cleanBody, buildIndex, search, uriMatcher } = require('./standmeet');

const inScope = uriMatcher(['wiki://software/project/standmeet/**', 'subjectivity://cv', 'output://*']);
assert.ok(inScope('wiki://software/project/standmeet'), 'a/** covers a itself');
assert.ok(inScope('wiki://software/project/standmeet/architecture/key-designs'));
assert.ok(!inScope('wiki://software/project/youteacher'));
assert.ok(inScope('subjectivity://cv') && !inScope('subjectivity://cv/old'));
assert.ok(inScope('output://talk') && !inScope('output://talk/slides'), '* stays in one segment');
assert.ok(uriMatcher(['wiki://**'])('wiki://math/logic/turing-machines'));

const bilingual = [
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
].join('\n');

const text = cleanBody(bilingual);
assert.ok(text.startsWith('Stages & gates'), text);
assert.ok(text.includes('see scripting and relaxation'), 'wiki links read as their label');
assert.ok(!text.includes('阶段') && !text.includes('tikz') && !text.includes('<label'), text);

const index = buildIndex([
    { title: 'stages-and-gates', path: 'cybernetics/theory/stages-and-gates', text: 'gate fixes what counts as done' },
    { title: 'untrusted-build-bulkhead', path: 'software/untrusted-build-bulkhead', text: 'run untrusted code in a sandbox, network off' },
    { title: 'short-video', path: 'marketing/awareness/short-video', text: 'hooks readable in three seconds' },
    { title: '短视频', path: 'marketing/短视频', text: '三秒钩子' },
    { title: 'standmeet', path: 'software/project/standmeet', text: 'audience-tailored introduction' },
    { title: 'testing-software-3-0', path: 'cybernetics/engineering/testing-software-3-0', text: 'golden sets and evals' },
]);
assert.equal(search(index, 'Tell me about stand meet')[0].title, 'standmeet', 'a name speech split in two');
assert.equal(search(index, 'How do you test prompts?')[0].title, 'testing-software-3-0', 'test meets testing');
assert.equal(search(index, 'How would you run untrusted code?')[0].title, 'untrusted-build-bulkhead');
assert.equal(search(index, 'what is a gate')[0].title, 'stages-and-gates');
assert.equal(search(index, '短视频怎么做')[0].title, '短视频', 'CJK bigrams match');
assert.deepEqual(search(index, 'How was your weekend?'), [], 'no overlap, no notes');
console.log('standmeet ok');
