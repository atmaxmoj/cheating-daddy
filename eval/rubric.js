// rubric.js — the deterministic half of the cue eval: checks a card against the format the
// prompt asks for and against the context it was given. Each check returns {ok, why}.
// Word counts: whitespace-separated tokens of the card with markdown markers removed.

const words = s => s.replace(/[*_#>`-]/g, ' ').split(/\s+/).filter(Boolean);

function lines(card) {
    return card
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
}

// noteTitles — the titles of the notes the context carried ("## <title> (<path>)" and the
// "- <title>: …" project overview lines).
function noteTitles(context) {
    const titles = new Set();
    for (const m of context.matchAll(/^## (.+?) \(/gm)) {
        titles.add(m[1].trim().toLowerCase()); // "deployment › the stance"
        titles.add(m[1].split(' › ')[0].trim().toLowerCase()); // or just the note, "deployment"
    }
    for (const m of context.matchAll(/^- ([^:\n]+):/gm)) titles.add(m[1].trim().toLowerCase());
    return titles;
}

function projectNames(context) {
    const section = context.split('# Your projects')[1]?.split('\n# ')[0] || '';
    return [...section.matchAll(/^- ([^:\n]+):/gm)].map(m => m[1].trim());
}

// matrixRows — the choice matrix's data rows as arrays of cells (header and --- row dropped).
function matrixRows(card) {
    const rows = lines(card).filter(l => l.startsWith('|'));
    return rows
        .slice(1)
        .filter(r => !/^\|[\s|:-]+\|$/.test(r))
        .map(r => r.replace(/^\||\|$/g, '').split('|').map(s => s.trim()));
}

// checkMatrix — c.matrix set: the question names a technology, so the matrix must be there, lead
// with the pick, include the named alternatives, and list only options the context mentions.
// c.matrix unset: no matrix at all.
function checkMatrix(card, context, c) {
    const rows = matrixRows(card);
    if (!c.matrix) return { noMatrix: { ok: rows.length === 0, why: `${rows.length} matrix rows on a question that names no technology` } };
    const ctx = context.toLowerCase();
    const named = rows.map(r => (r[0] || '').replace(/\(.*?\)|[*`]/g, '').trim());
    const text = rows.map(r => r.join(' ')).join('\n');
    return {
        matrix: { ok: rows.length >= 2 && rows.length <= 4, why: `${rows.length} rows` },
        matrixPickFirst: { ok: rows.length > 0 && c.matrix.chosen.test(rows[0][0]) && /✓|yes/i.test(rows[0][1] || ''), why: `first row: ${JSON.stringify(rows[0])}` },
        matrixAlternatives: { ok: c.matrix.alts.every(a => a.test(text)), why: `rows ${JSON.stringify(named)} vs ${c.matrix.alts}` },
        matrixGrounded: {
            ok: named.length > 0 && named.every(n => n.toLowerCase().split(/[\s/]+/).some(w => w.length >= 3 && ctx.includes(w))),
            why: `options ${JSON.stringify(named)} must appear in the context`,
        },
    };
}

const content = s => new Set(words(s.toLowerCase()).filter(w => w.length > 3));

// checkSupplement — optional, the model's call. When present: short, and new — no card point
// shares more than half its content words (a restated point is not a supplement).
function checkSupplement(card, points) {
    const line = lines(card).find(l => l.startsWith('**Supplementary:**'));
    if (!line) return {};
    const body = line.replace('**Supplementary:**', '');
    const mine = content(body);
    const overlap = Math.max(0, ...points.map(p => [...content(p)].filter(w => mine.has(w)).length / Math.max(1, mine.size)));
    return {
        supplementShort: { ok: words(body).length <= 35, why: `${words(body).length} words` },
        supplementNew: { ok: overlap <= 0.5, why: `${Math.round(overlap * 100)}% of its words repeat one point` },
    };
}

// CONTEXT_LINE — a line of the card's Context section (how it happened); it is not a point and does
// not count toward the word limit.
const CONTEXT_LINE = /^(\*\*Context\b|[-*] (\*\*)?(Then|Weighed|Decided|After):|([-*] )?_?Your notes don't say)/;

function checkAnswer(card, context, c) {
    const all = lines(card);
    const ls = all.filter(
        l => !l.startsWith('|') && !l.startsWith('**Why this over') && !l.startsWith('**Supplementary:**') && !CONTEXT_LINE.test(l),
    );
    const story = all.filter(l => CONTEXT_LINE.test(l));
    const key = /^\*\*Key:\s*(.+?)\*\*$/.exec(ls[0] || '');
    const ideas = key ? key[1].split('+').map(s => s.trim()) : [];
    const points = ls.filter(l => /^[-*] /.test(l));
    const example = ls.find(l => l.startsWith('**Example:**')) || '';
    const from = /^_From:\s*(.+?)_$/.exec(ls.find(l => l.startsWith('_From:')) || '');
    const cited = from ? from[1].split(/,\s*/).map(s => s.trim().toLowerCase()) : [];
    const known = noteTitles(context);
    const projects = projectNames(context);
    const n = words(ls.join('\n')).length; // the matrix does not count toward the limit
    return {
        ...checkMatrix(card, context, c),
        ...checkSupplement(card, points),
        retrieval: { ok: c.notes.test(context), why: `context paths ${c.notes}` },
        contextStory: {
            ok: story[0]?.startsWith('**Context') && story.slice(1).some(l => /Decided:|Then:|Your notes don't say/i.test(l)),
            why: `context lines: ${JSON.stringify(story)}`,
        },
        keyLine: { ok: !!key, why: `first line: ${ls[0]}` },
        keyPlain: {
            ok: ideas.length >= 2 && ideas.length <= 3 && ideas.every(i => i.split(/\s+/).length <= 3),
            why: `ideas: ${JSON.stringify(ideas)}`,
        },
        keyOnTopic: { ok: !!key && c.key.test(key[1]), why: `key "${key?.[1]}" vs ${c.key}` },
        answerLine: { ok: /^\*\*[^*].*\*\*$/.test(ls[1] || '') && !/^\*\*(Key|Example)/.test(ls[1] || ''), why: `second line: ${ls[1]}` },
        points: { ok: points.length >= 3 && points.length <= 4, why: `${points.length} points` },
        pointsHaveDetail: { ok: points.length > 0 && points.every(p => words(p).length >= 6), why: 'every point ≥ 6 words' },
        // The Example is optional (6319c8f: only when a note ties a project to the answer; never
        // stretched in). When there is one, it names one of the user's own projects.
        ownExample: {
            ok: !example || projects.some(p => example.toLowerCase().includes(p.toLowerCase().replace(/-/g, ' ')) || example.toLowerCase().includes(p.toLowerCase())),
            why: `example "${example.slice(0, 80)}" vs projects ${JSON.stringify(projects)}`,
        },
        fromIsReal: {
            // a cited section may be shortened ("deployment › the instance has no control…"); its note must exist
            ok: cited.length > 0 && cited.every(t => known.has(t) || known.has(t.split(' › ')[0].trim())),
            why: `cited ${JSON.stringify(cited)}`,
        },
        length: { ok: n >= 70 && n <= 180, why: `${n} words` },
    };
}

// checkRound — a round case: what the card must not say (forbid), must say (must), and whether a
// choice matrix is out of place (noTable).
function checkRound(card, c) {
    const out = {};
    if (c.forbid) out.roundForbid = { ok: !c.forbid.test(card), why: `matched ${c.forbid}: ${card.slice(0, 160)}` };
    if (c.must) out.roundMust = { ok: c.must.test(card), why: `no ${c.must}: ${card.slice(0, 160)}` };
    if (c.noTable) out.roundNoTable = { ok: !/^\|.*\|$/m.test(card), why: 'a table on the card' };
    return out;
}

function check(card, context, c) {
    const t = card.trim();
    if (c.kind === 'smalltalk') return { dash: { ok: t === '—' || t === '-', why: `got "${t.slice(0, 60)}"` } };
    if (c.kind === 'outside') return { notInNotes: { ok: /^Not in your notes/i.test(t), why: `got "${t.slice(0, 80)}"` } };
    if (c.kind === 'round') return checkRound(card, c);
    return checkAnswer(card, context, c);
}

module.exports = { check, noteTitles, projectNames };
