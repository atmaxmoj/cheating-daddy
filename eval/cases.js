// cases.js — the cue eval's golden set: interview questions against the owner's real corpus.
//
// kind:
//   answer     — a question the notes cover. `notes` must match a note path the retrieval put in
//                the context; `key` must match the card's Key line (the core idea, in plain words).
//   smalltalk  — not a question to the owner; the card must be exactly "—".
//   outside    — nothing in the notes covers it; the card must say "Not in your notes".
// role: the StandMeet role to load (null = every wiki note).

module.exports = [
    {
        q: 'What problem does StandMeet solve?',
        kind: 'answer',
        notes: /software\/project\/standmeet/,
        key: /introduc|audience|represent|resume|linkedin|voice|context|repeat|same question|present/i,
    },
    {
        q: 'How would you run code from untrusted users safely on your own servers?',
        kind: 'answer',
        notes: /bulkhead|sandbox|isolat/,
        key: /isolat|sandbox|contain/i,
    },
    {
        q: "How do you make sure an AI agent's output is actually correct?",
        kind: 'answer',
        notes: /gate|test|audit|verif/,
        key: /gate|test|check|verif|audit/i,
    },
    {
        q: 'How do you test prompts when the output is different every time?',
        kind: 'answer',
        notes: /test|eval|golden/,
        key: /golden|eval|regress|test|runs|judge|sampl/i,
    },
    {
        q: "Tell me about a project you're proud of.",
        kind: 'answer',
        notes: /software\/project\//,
        key: /.+/,
    },
    {
        q: 'How do you decide what to build first when everything feels important?',
        kind: 'answer',
        notes: /.+/,
        key: /.+/,
    },
    { q: 'Can you hear me okay? Let me share my screen.', kind: 'smalltalk' },
    { q: 'Great, thanks for joining today.', kind: 'smalltalk' },
    { q: 'How would you size the hydraulic landing gear actuators of a regional airliner?', kind: 'outside' },
    {
        q: 'How would you run untrusted code safely?',
        kind: 'answer',
        role: 'standmeet-only', // only used when this role exists on the instance
        notes: /software\/project\/standmeet/,
        key: /isolat|sandbox|contain/i,
    },
];
