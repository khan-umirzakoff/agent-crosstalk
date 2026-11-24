// Routes a message to an agent, stamps who sent it and how to reply, and logs it.
import { execFileSync } from 'node:child_process';
import * as antigravity from './antigravity.js';
import * as claude from './claude.js';
import * as log from './log.js';

export const AGENTS = ['claude', 'antigravity', 'user'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Who is calling: a Claude session, an Antigravity or Codex agent, or an unverified terminal.
// The nearest agent app among the parent processes decides; environment variables can be inherited
// across apps, so they only name the Claude session once a Claude parent is confirmed.
// "the user" is only ever the person in `crosstalk ui`.
export function whoami(fromId) {
  const id = UUID.test(fromId || '') ? fromId : null;
  for (const cmd of ancestors()) {
    if (cmd.includes('Antigravity.app')) return { agent: 'antigravity', id, name: id || 'Antigravity' };
    if (/ChatGPT\.app|\/codex(\s|$)/.test(cmd)) return { agent: 'codex', id: null, name: 'Codex' };
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
  if (from.agent === 'antigravity') return `crosstalk send antigravity ${from.id || 'current'} '<reply>'`;
  return `crosstalk send user '<reply>'`; // codex and terminals cannot receive yet; answer in the room
}

export function header(from) {
  const who = { user: 'the user (crosstalk ui)', terminal: 'a terminal (unverified)' }[from.agent] || `${from.agent} ${shellQuote(from.name)}`;
  return `[crosstalk · from ${who} · reply with: ${replyCommand(from)}]`;
}

export async function send(agent, target, text, from) {
  const body = `${header(from)}\n${text}`;
  let to;
  if (agent === 'claude') {
    const s = await claude.send(target, body);
    to = { agent, id: s.id, name: s.name, status: s.status };
  } else if (agent === 'antigravity') {
    const s = await antigravity.send(target, () => body);
    to = { agent, id: s.id, name: s.name };
  } else if (agent === 'user') {
    to = { agent: 'user', id: null, name: 'you' };
  } else {
    throw new Error(`Unknown agent "${agent}". Use one of: ${AGENTS.join(', ')}`);
  }
  log.append({ from, to, text });
  return to;
}

export async function list(agent) {
  const out = {};
  if (!agent || agent === 'claude') out.claude = await Promise.resolve().then(claude.list).catch((e) => ({ error: e.message }));
  if (!agent || agent === 'antigravity') out.antigravity = await antigravity.list().catch((e) => ({ error: e.message }));
  return out;
}
