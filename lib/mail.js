// Agent Mail (mcp_agent_mail) is the mailbox: threads, acknowledgements, search, file reservations.
// crosstalk links a mailbox name to a live session and rings that session when mail arrives,
// so agents never have to poll their inbox.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DIR } from './log.js';

const FILE = joinPath(DIR, 'mail.json');
const PROGRAM = { claude: 'claude-code', codex: 'codex', antigravity: 'antigravity' };

export function am(args) {
  try {
    return JSON.parse(execFileSync('am', [...args, '--json'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('Agent Mail is not installed (the am command). See the README.');
    throw new Error(`Agent Mail: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}

const load = () => {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return { members: [] };
  }
};
const save = (data) => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(`${FILE}.tmp`, FILE);
};
const same = (a, b) => a.project === b.project && a.agent === b.agent;
export const members = () => load().members;

// Registers the calling session in a project's mailbox (or refreshes it) and links the two.
export function join(me, { project, name }) {
  if (!PROGRAM[me.agent] || !me.id) throw new Error('Run this inside a Claude, Codex or Antigravity session, or pass --from <its id>.');
  const data = load();
  const known = data.members.find((m) => m.app === me.agent && m.session === me.id && m.project === project);
  const agent = am(['agents', 'register', '--project', project, '--program', PROGRAM[me.agent], '--model', 'unknown',
    ...(name || known ? ['--name', name || known.agent] : []), '--task', me.name || me.id]);
  const cursor = known?.cursor ?? am(['inbox-events', '--project', project, '--agent', agent.name, '--position-now']).tail_cursor;
  data.members = data.members.filter((m) => !(m.app === me.agent && m.session === me.id && m.project === project) && !same(m, { project, agent: agent.name }));
  data.members.push({ project, agent: agent.name, app: me.agent, session: me.id, label: me.name || me.id, cursor });
  save(data);
  return agent.name;
}

// The mailbox's own notices (contact handshakes) are not worth waking a session for.
const notice = (event) => /^Contact (approved|request|accepted)/i.test(event.subject || '');

// Rings each linked session once per delivered mail, oldest first. The cursor moves on even when a ring fails
// (the session is closed, say): the mail itself stays in the inbox.
export async function watch(ring, { intervalMs = 3000, once = false, onError = () => {}, signal } = {}) {
  while (!signal?.aborted) {
    for (const m of load().members) {
      let page;
      try {
        page = am(['inbox-events', '--project', m.project, '--agent', m.agent, '--after', String(m.cursor ?? 0)]);
      } catch (e) {
        onError(m, e);
        continue;
      }
      for (const event of page.events || []) {
        if (!notice(event)) await ring(m, event).catch((e) => onError(m, e));
        const data = load(); // another join may have written meanwhile
        const member = data.members.find((x) => same(x, m));
        if (member) member.cursor = event.cursor;
        save(data);
      }
    }
    if (once) return;
    await sleep(intervalMs, undefined, { signal }).catch(() => {}); // an abort ends the wait early
  }
}
