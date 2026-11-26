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
  const agId = process.env.ANTIGRAVITY_CONVERSATION_ID;
  for (const cmd of ancestors()) {
    if (cmd.includes('Antigravity.app') || /\/agy(\s|$)/.test(cmd)) {
      const conversation = id || (UUID.test(agId || '') ? agId : null);
      return { agent: 'antigravity', id: conversation, name: conversation || 'Antigravity' };
    }
    if (/ChatGPT\.app|\/codex(\s|$)/.test(cmd)) {
      const thread = UUID.test(process.env.CODEX_THREAD_ID || '') ? process.env.CODEX_THREAD_ID : id;
      return { agent: 'codex', id: thread, name: thread || 'Codex' };
    }
    if (/\/claude(\s|$)|Claude\.app/.test(cmd)) {
      const c = claude.self();
      return c ? { agent: 'claude', id: c.id, name: c.name } : { agent: 'terminal', id: null, name: 'terminal' };
    }
  }
  if (UUID.test(agId || '') && !UUID.test(process.env.CODEX_THREAD_ID || '') && !process.env.CLAUDE_CODE_SESSION_ID) {
    return { agent: 'antigravity', id: id || agId, name: id || agId };
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
  if (from.agent === 'claude') return `crosstalk send claude ${shellQuote(from.id || from.name)} '<reply>'`;
  if ((from.agent === 'antigravity' || from.agent === 'codex') && from.id) return `crosstalk send ${from.agent} ${shellQuote(from.id)} '<reply>'`;
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
async function withTitle(from) {
  const app = { antigravity, codex }[from.agent];
  if (!app || !from.id) return from;
  const row = await app.status(from.id).catch(() => null);
  return row ? { ...from, id: row.id, name: row.name } : from;
}

export const describeSender = (id) => withTitle(whoami(id));

export async function send(agent, target, text, sender, waiting = false) {
  const from = await withTitle(sender);
  const body = `${header(from, waiting && agent !== 'claude')}\n${text}`;
  let to;
  let receipt;
  let delivery;
  if (agent === 'claude') {
    const s = await claude.send(target, body);
    to = { agent, id: s.id, name: s.name, status: s.status };
    delivery = s.delivery;
  } else if (agent === 'antigravity' || agent === 'codex') {
    const s = await (agent === 'codex' ? codex : antigravity).send(target, () => body, waiting);
    to = { agent, id: s.id, name: s.name };
    receipt = s.receipt;
    delivery = s.delivery;
  } else if (agent === 'user') {
    to = { agent: 'user', id: null, name: 'you' };
  } else {
    throw new Error(`Unknown agent "${agent}". Use one of: ${AGENTS.join(', ')}`);
  }
  log.append({ from, to, text, delivery });
  return { to, from, receipt, delivery };
}

// Waits for the answer to a message just sent to Antigravity or Codex, reads it from the app's window
// and logs it. The sender gets the answer as command output, so nothing is delivered back to it.
export async function waitReply({ to, from, receipt }, timeoutMs) {
  const app = { antigravity, codex }[to.agent];
  if (!app || !to.id) throw new Error('--wait works for Antigravity and Codex; Claude sessions answer you directly.');
  if (!receipt) throw new Error('The destination did not return a turn receipt. Check its chat before retrying.');
  const { state, reply } = await app.waitReply(to.id, receipt, timeoutMs);
  log.append({ from: { agent: to.agent, id: to.id, name: state.name }, to: from, text: reply });
  return reply;
}

// One conversation's messages numbered from 1 (oldest): the last n, or n from number start.
export async function history(agent, target, { n = 10, start } = {}) {
  const app = { claude, antigravity, codex }[agent];
  if (!app) throw new Error('Usage: crosstalk read claude|antigravity|codex <target>');
  const h = await app.messages(target);
  const all = h.messages.map((m, i) => ({ ...m, n: i + 1, role: m.role === 'user' && m.text.startsWith('[crosstalk]') ? 'crosstalk' : m.role }));
  return { ...h, total: all.length, messages: start ? all.slice(start - 1, start - 1 + n) : all.slice(-n) };
}

export async function list(agent) {
  const out = {};
  if (!agent || agent === 'claude') out.claude = await Promise.resolve().then(claude.list).catch((e) => ({ error: e.message }));
  if (!agent || agent === 'antigravity') out.antigravity = await antigravity.list().catch((e) => ({ error: e.message }));
  if (!agent || agent === 'codex') out.codex = await codex.list().catch((e) => ({ error: e.message }));
  return out;
}
