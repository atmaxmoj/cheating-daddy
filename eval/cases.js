// cases.js — the cue eval's golden set: interview questions against the owner's real corpus.
//
// kind:
//   answer     — a question the notes cover. `notes` must match a note path the retrieval put in
//                the context; `key` must match the card's Key line (the core idea, in plain words).
//   smalltalk  — not a question to the owner; the card must be exactly "—".
//   outside    — nothing in the notes covers it; the card must say "Not in your notes".
// matrix: set when the question names a technology in the owner's stack — the card must carry
//   the choice matrix, `chosen` in the first row, every `alts` among the rows. Unset on an
//   answer case: the card must carry NO matrix (a general question, even on the same topic).
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
    {
        q: 'Why did you use bubblewrap for the plugin sandbox instead of Docker?',
        kind: 'answer',
        notes: /deployment|mcp-capability-plugins|sandbox/,
        key: /isolat|sandbox|namespace|docker|socket|privilege|host/i,
        matrix: { chosen: /bubblewrap|bwrap/i, alts: [/docker/i] },
    },
    {
        q: 'Why did you build the job queue on River and Postgres rather than a message broker?',
        kind: 'answer',
        notes: /broker|queue|river/,
        key: /postgres|one database|no new service|transaction|simpl|single|broker/i,
        matrix: { chosen: /river|postgres/i, alts: [/broker|kafka|rabbit|nats|redis/i] },
    },
    {
        q: 'How does bwrap isolate the MCP plugins?',
        kind: 'answer',
        notes: /mcp-capability-plugins|capsocket|sandbox|deployment/,
        key: /isolat|sandbox|namespace|network|socket/i,
        matrix: { chosen: /bubblewrap|bwrap/i, alts: [/docker/i] },
    },
    {
        // "react" the verb, not React the library: no matrix (on a story the notes do cover)
        q: 'How did you react when the independent audit failed your video?',
        kind: 'answer',
        notes: /generator|audit|video/,
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
