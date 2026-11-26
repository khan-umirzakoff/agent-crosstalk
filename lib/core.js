// Routes a message to an agent, stamps who sent it and how to reply, and logs it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

async function numbered(agent, target) {
  const app = { claude, antigravity, codex }[agent];
  if (!app) throw new Error('Usage: crosstalk read claude|antigravity|codex <target>');
  const h = await app.messages(target);
  return { ...h, messages: h.messages.map((m, i) => ({ ...unstamp(m), n: i + 1 })) };
}

// A crosstalk message carries a header line (who sent it, how to reply); history keeps the sender and drops the rest.
const STAMP = /^\[crosstalk\] From (.+?)\. (?:Reply with:|It is waiting:)[^\n]*\n?/;
export function unstamp(m) {
  const stamp = (m.role === 'user' || m.role === 'peer') && STAMP.exec(m.text);
  if (!stamp) return m.role === 'user' && m.text.startsWith('[crosstalk]') ? { ...m, role: 'crosstalk' } : m;
  const person = stamp[1].startsWith('the user');
  return { ...m, role: person ? 'user' : 'crosstalk', from: person ? null : stamp[1], text: m.text.slice(stamp[0].length) };
}

// One conversation's messages numbered from 1 (oldest): the last n, or n from number start.
export async function history(agent, target, { n = 10, start } = {}) {
  const { messages: all, ...h } = await numbered(agent, target);
  return { ...h, total: all.length, messages: start ? all.slice(start - 1, start - 1 + n) : all.slice(-n) };
}

// Read markers: each reader remembers how far it read each conversation, so a reread sends only what is new.
const READS = join(log.DIR, 'reads');
const digest = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
// A message is known by its start, so one that was still streaming when it was read is still recognised.
const mark = (m, k) => digest(`${m.role}\n${m.text.slice(0, k)}`);

// all: numbered messages. cursor: { n, k, mark, length } from the last read, or null.
// Without start: the newest n unread. Returns what to show, what was unread and the new cursor.
export function unreadView(all, cursor, { n = 10, start } = {}) {
  let seen = 0;
  let changed = false;
  if (cursor) {
    const known = (m) => m && mark(m, cursor.k) === cursor.mark;
    const at = known(all[cursor.n - 1]) ? cursor.n - 1 : all.findLastIndex(known);
    if (at < 0) changed = true; // history was rewritten: start over from the newest
    else seen = all[at].text.length > cursor.length ? at : at + 1; // it grew after it was read: show it again
  }
  const messages = start ? all.slice(start - 1, start - 1 + n) : all.slice(Math.max(seen, all.length - n));
  const last = messages.at(-1);
  const k = Math.min(last?.text.length ?? 0, 80);
  const next = last && last.n > seen ? { n: last.n, k, mark: mark(last, k), length: last.text.length } : cursor;
  return { seen, unread: all.length - seen, changed, messages, cursor: next };
}

// What reader has not read in this conversation yet (or the range asked for), and moves its marker.
export async function read(agent, target, { n = 10, start, reader } = {}) {
  const { messages: all, ...h } = await numbered(agent, target);
  const file = join(READS, `${digest(`${reader?.agent}:${reader?.id || ''}|${agent}:${h.id}`)}.json`);
  let cursor = null;
  try {
    cursor = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  const view = unreadView(all, cursor, { n, start });
  if (view.cursor && view.cursor !== cursor) {
    mkdirSync(READS, { recursive: true });
    writeFileSync(file, JSON.stringify(view.cursor));
  }
  return { ...h, total: all.length, ...view };
}

export async function list(agent) {
  const out = {};
  if (!agent || agent === 'claude') out.claude = await Promise.resolve().then(claude.list).catch((e) => ({ error: e.message }));
  if (!agent || agent === 'antigravity') out.antigravity = await antigravity.list().catch((e) => ({ error: e.message }));
  if (!agent || agent === 'codex') out.codex = await codex.list().catch((e) => ({ error: e.message }));
  return out;
}

// Sessions as the apps' sidebars show them: by project, each child (fork, side session, subagent) under
// its parent, most recent activity first. Returns [{ project, rows: [{ ...row, depth }] }].
export function tree(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  for (const r of byId.values()) {
    const seen = new Set([r.id]);
    let p = byId.get(r.parent);
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      p = byId.get(p.parent);
    }
    if (p?.id === r.id) r.parent = null; // a parent loop would hide every session in it
  }
  const roots = [];
  for (const r of byId.values()) (byId.get(r.parent)?.children ?? roots).push(r);
  const recent = (r) => (r.recent ??= Math.max(r.last || 0, ...r.children.map(recent)));
  const newest = (a, b) => recent(b) - recent(a);
  const flat = ({ children, recent: _, ...r }, depth) => [{ ...r, depth }, ...children.sort(newest).flatMap((c) => flat(c, depth + 1))];
  const projects = new Map();
  for (const r of roots.sort(newest)) projects.set(r.project || '', [...(projects.get(r.project || '') || []), ...flat(r, 0)]);
  return [...projects].map(([project, list]) => ({ project, rows: list }));
}
