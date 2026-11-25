// Routes a message to an agent, stamps who sent it and how to reply, and logs it.
import { execFileSync } from 'node:child_process';
import * as antigravity from './antigravity.js';
import * as claude from './claude.js';
import * as codex from './codex.js';
import * as log from './log.js';

export const AGENTS = ['claude', 'antigravity', 'codex', 'user'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Who is calling: a Claude session, an Antigravity or Codex agent, or an unverified terminal.
// The nearest agent app among the parent processes decides; environment variables can be inherited
// across apps, so they only name the Claude session once a Claude parent is confirmed.
// "the user" is only ever the person in `crosstalk ui`.
export function whoami(fromId) {
  const id = UUID.test(fromId || '') ? fromId : null;
  for (const cmd of ancestors()) {
    if (cmd.includes('Antigravity.app')) return { agent: 'antigravity', id, name: id || 'Antigravity' };
    if (/ChatGPT\.app|\/codex(\s|$)/.test(cmd)) {
      const thread = UUID.test(process.env.CODEX_THREAD_ID || '') ? process.env.CODEX_THREAD_ID : id;
      return { agent: 'codex', id: thread, name: thread || 'Codex' };
    }
    if (/\/claude(\s|$)|Claude\.app/.test(cmd)) {
      const c = claude.self();
      return c ? { agent: 'claude', id: c.id, name: c.name } : { agent: 'terminal', id: null, name: 'terminal' };
    }
  }
  return { agent: 'terminal', id: null, name: 'terminal' };
}

function ancestors() {
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
    const byPid = new Map(rows.map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, cmd]) => [pid, { ppid, cmd }]));
    const out = [];
    for (let pid = String(process.ppid), n = 0; byPid.has(pid) && n < 50; pid = byPid.get(pid).ppid, n++) out.push(byPid.get(pid).cmd);
    return out;
  } catch {
    return [];
  }
}

// Single quotes, so a session name with $(...) or backticks stays plain text in a shell.
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function replyCommand(from) {
  if (from.agent === 'claude') return `crosstalk send claude ${shellQuote(from.name)} '<reply>'`;
  if (from.agent === 'antigravity' || from.agent === 'codex') return `crosstalk send ${from.agent} ${from.id || 'current'} '<reply>'`;
  return `crosstalk send user '<reply>'`; // a terminal cannot receive; answer in the room
}

const APP = { claude: 'Claude', antigravity: 'Antigravity', codex: 'Codex' };
const PLACE = { claude: 'session', antigravity: 'conversation', codex: 'thread' };

// One plain line on top of every message: who wrote it, from which session, and how to answer.
// With waiting set, the sender reads the answer from this chat itself, so no command is needed to reply.
export function header(from, waiting = false) {
  let who = 'a terminal (sender not verified)';
  if (from.agent === 'user') who = 'the user, in the crosstalk room';
  else if (APP[from.agent]) who = from.agent === 'claude' || from.id ? `${APP[from.agent]}, ${PLACE[from.agent]} ${shellQuote(from.name)}` : APP[from.agent];
  return `[crosstalk] From ${who}. ${waiting ? 'It is waiting: just answer in this chat.' : `Reply with: ${replyCommand(from)}`}`;
}

// Antigravity and Codex agents know at most their id; the receiver also gets the conversation's title.
// An Antigravity agent that gave no --from is the conversation running on screen right now.
async function withTitle(from) {
  if (!['antigravity', 'codex'].includes(from.agent)) return from;
  const rows = await (from.agent === 'codex' ? codex : antigravity).list().catch(() => []);
  if (!Array.isArray(rows)) return from;
  const row = from.id ? rows.find((r) => r.id === from.id) : rows.find((r) => r.status === 'busy');
  return row ? { ...from, id: row.id, name: row.name } : from;
}

export async function send(agent, target, text, sender, waiting = false) {
  const from = await withTitle(sender);
  const body = `${header(from, waiting && agent !== 'claude')}\n${text}`;
  let to;
  let previous;
  if (agent === 'claude') {
    const s = await claude.send(target, body);
    to = { agent, id: s.id, name: s.name, status: s.status };
  } else if (agent === 'antigravity' || agent === 'codex') {
    const s = await (agent === 'codex' ? codex : antigravity).send(target, () => body);
    to = { agent, id: s.id, name: s.name };
    previous = s.previous;
  } else if (agent === 'user') {
    to = { agent: 'user', id: null, name: 'you' };
  } else {
    throw new Error(`Unknown agent "${agent}". Use one of: ${AGENTS.join(', ')}`);
  }
  log.append({ from, to, text });
  return { to, from, previous };
}

// Waits for the answer to a message just sent to Antigravity or Codex, reads it from the app's window
// and logs it. The sender gets the answer as command output, so nothing is delivered back to it.
export async function waitReply({ to, from, previous }, timeoutMs) {
  const app = { antigravity, codex }[to.agent];
  if (!app || !to.id) throw new Error('--wait works for Antigravity and Codex; Claude sessions answer you directly.');
  const { state, reply } = await app.waitReply(to.id, previous, timeoutMs);
  log.append({ from: { agent: to.agent, id: to.id, name: state.name }, to: from, text: reply });
  return reply;
}

export async function list(agent) {
  const out = {};
  if (!agent || agent === 'claude') out.claude = await Promise.resolve().then(claude.list).catch((e) => ({ error: e.message }));
  if (!agent || agent === 'antigravity') out.antigravity = await antigravity.list().catch((e) => ({ error: e.message }));
  if (!agent || agent === 'codex') out.codex = await codex.list().catch((e) => ({ error: e.message }));
  return out;
}
