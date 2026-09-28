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
    for (const m of context.matchAll(/^## (.+?) \(/gm)) titles.add(m[1].trim().toLowerCase());
    for (const m of context.matchAll(/^- ([^:\n]+):/gm)) titles.add(m[1].trim().toLowerCase());
    return titles;
}

function projectNames(context) {
    const section = context.split('# Your projects')[1]?.split('\n# ')[0] || '';
    return [...section.matchAll(/^- ([^:\n]+):/gm)].map(m => m[1].trim());
}

function checkAnswer(card, context, c) {
    const ls = lines(card);
    const key = /^\*\*Key:\s*(.+?)\*\*$/.exec(ls[0] || '');
    const ideas = key ? key[1].split('+').map(s => s.trim()) : [];
    const points = ls.filter(l => /^[-*] /.test(l));
    const example = ls.find(l => l.startsWith('**Example:**')) || '';
    const from = /^_From:\s*(.+?)_$/.exec(ls.find(l => l.startsWith('_From:')) || '');
    const cited = from ? from[1].split(/,\s*/).map(s => s.trim().toLowerCase()) : [];
    const known = noteTitles(context);
    const projects = projectNames(context);
    const n = words(card).length;
    return {
        retrieval: { ok: c.notes.test(context), why: `context paths ${c.notes}` },
        keyLine: { ok: !!key, why: `first line: ${ls[0]}` },
        keyPlain: {
            ok: ideas.length >= 2 && ideas.length <= 3 && ideas.every(i => i.split(/\s+/).length <= 3),
            why: `ideas: ${JSON.stringify(ideas)}`,
        },
        keyOnTopic: { ok: !!key && c.key.test(key[1]), why: `key "${key?.[1]}" vs ${c.key}` },
        answerLine: { ok: /^\*\*[^*].*\*\*$/.test(ls[1] || '') && !/^\*\*(Key|Example)/.test(ls[1] || ''), why: `second line: ${ls[1]}` },
        points: { ok: points.length >= 3 && points.length <= 4, why: `${points.length} points` },
        pointsHaveDetail: { ok: points.length > 0 && points.every(p => words(p).length >= 6), why: 'every point ≥ 6 words' },
        ownExample: {
            ok: projects.some(p => example.toLowerCase().includes(p.toLowerCase().replace(/-/g, ' ')) || example.toLowerCase().includes(p.toLowerCase())),
            why: `example "${example.slice(0, 80)}" vs projects ${JSON.stringify(projects)}`,
        },
        fromIsReal: {
            ok: cited.length > 0 && cited.every(t => known.has(t)),
            why: `cited ${JSON.stringify(cited)}`,
        },
        length: { ok: n >= 70 && n <= 180, why: `${n} words` },
    };
}

function check(card, context, c) {
    const t = card.trim();
    if (c.kind === 'smalltalk') return { dash: { ok: t === '—' || t === '-', why: `got "${t.slice(0, 60)}"` } };
    if (c.kind === 'outside') return { notInNotes: { ok: /^Not in your notes/i.test(t), why: `got "${t.slice(0, 80)}"` } };
    return checkAnswer(card, context, c);
}

module.exports = { check, noteTitles, projectNames };
