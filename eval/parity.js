// parity.js — `npm run eval:parity`: the server builds byte for byte the prompt this app builds.
//
// The gate for moving the cue card to StandMeet (assistant.cue): for every role (and none), every
// round and every eval question, the system prompt the app assembles here (contextFor + the cues
// profile + the closing rules) must equal assistant.context's, on the same corpus. A difference
// is a bug in the port, not noise: cards are sampled, prompts are not. Exits 1 on any difference.
//
// Needs ~/.standmeet/credentials.json. Flags: --roles N (how many roles besides none; default 2).

const s = require('../src/utils/standmeet');
const { getSystemPrompt } = require('../src/utils/prompts');
const { getPreferences } = require('../src/storage');
const cases = require('./cases');

const HOST = process.env.STANDMEET_HOST || getPreferences().standmeetHost || 'https://sijie.xyz';
const ROLES = Number(process.argv.includes('--roles') ? process.argv[process.argv.indexOf('--roles') + 1] : 2);
const QUESTIONS = [...new Set([
    ...cases.map(c => c.q),
    'Have you run Kafka in production?',
    'How does bwrap isolate the MCP plugins?',
    'Why Postgres for the queue — 为什么不用消息队列？',
])];

async function main() {
    const client = s.createClient(HOST);
    await client.connect();
    const roles = [null, ...(await s.listRoles(HOST)).filter(r => r.corpus_uris.length).slice(0, ROLES)];
    await s.loadScreen(HOST);
    let same = 0;
    const diffs = [];
    for (const role of roles) {
        console.log(`role ${role ? role.name : '(whole wiki)'}: ${await s.loadCorpus(HOST, role)} notes`);
        for (const round of Object.keys(s.ROUNDS)) {
            for (const question of QUESTIONS) {
                const local = getSystemPrompt('cues', s.contextFor(question, round), false, s.roundRules(round));
                const server = await client.tool('assistant.context', { ...(role ? { role_id: role.id } : {}), round, question });
                if (server.system === local) same++;
                else diffs.push({ role: role?.name || '', round, question, local, server: server.system });
            }
        }
    }
    console.log(`\n${same} identical, ${diffs.length} different`);
    for (const d of diffs.slice(0, 3)) {
        let i = 0;
        while (i < d.local.length && d.local[i] === d.server[i]) i++;
        console.log(`\n✖ [${d.role}] ${d.round} — ${d.question}\n  at ${i}:\n  app:    ${JSON.stringify(d.local.slice(Math.max(0, i - 120), i + 120))}\n  server: ${JSON.stringify(d.server.slice(Math.max(0, i - 120), i + 120))}`);
    }
    process.exit(diffs.length ? 1 : 0);
}

main().catch(e => {
    console.error(e);
    process.exit(2);
});
