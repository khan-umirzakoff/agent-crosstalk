// Routes a message to an agent, stamps who sent it and how to reply, and logs it.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  if (from.reply) return `[crosstalk] From ${from.name}. Reply with: ${from.reply}`; // e.g. Agent Mail, which brings its own reply command
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

// replyBack: this message is the answer of a headless run. It never starts another run (no ping-pong between two
// terminal sessions, no headless resume of a terminal session that may be in use); it stays in the log instead.
export async function send(agent, target, text, sender, waiting = false, { replyBack = false } = {}) {
  const from = await withTitle(sender);
  // A terminal session runs headless and cannot run commands, so it just answers; crosstalk brings the answer back.
  const body = (state) => `${header(from, (waiting || ['cli', 'exec'].includes(state?.surface)) && agent !== 'claude')}\n${text}`;
  let to;
  let receipt;
  let delivery;
  if (agent === 'claude') {
    const s = await claude.send(target, body());
    to = { agent, id: s.id, name: s.name, status: s.status };
    delivery = s.delivery;
  } else if (agent === 'antigravity' || agent === 'codex') {
    const s = await (agent === 'codex' ? codex : antigravity).send(target, body, waiting);
    to = { agent, id: s.id, name: s.name };
    receipt = s.run && !replyBack ? startRun(s.run, to, from, !waiting) : s.receipt;
    delivery = s.run && replyBack ? 'not delivered: the sender is a terminal session; the answer is in this log' : s.delivery;
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
  if (receipt?.done) {
    // A headless run: its runner logs the answer, so only read it here.
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (existsSync(receipt.done)) {
        const { reply, error } = JSON.parse(readFileSync(receipt.done, 'utf8'));
        if (!reply) throw new Error(`No reply: ${error}`);
        return reply;
      }
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    throw new Error(`No reply after ${Math.round(timeoutMs / 1000)} s; the run goes on, its answer will be in crosstalk log.`);
  }
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
// The sender's name is shell-quoted and may itself contain ". Reply with:", so it is matched as one quoted string.
const STAMP = new RegExp(String.raw`^\[crosstalk\] From ((?:Claude|Antigravity|Codex)(?:, (?:session|conversation|thread) '(?:[^']|'\\'')*')?|the user, in the crosstalk room|a terminal \(sender not verified\))\. (?:Reply with:|It is waiting:)([^\n]*)\n?`);
const unquote = (q) => (q.startsWith("'") && q.endsWith("'") ? q.slice(1, -1).replace(/'\\''/g, "'") : q);
export function unstamp(m) {
  const stamp = (m.role === 'user' || m.role === 'peer') && (STAMP.exec(m.text) || /^\[crosstalk\] From (.+?)\. (?:Reply with:|It is waiting:)([^\n]*)\n?/.exec(m.text));
  if (!stamp) return m.role === 'user' && m.text.startsWith('[crosstalk]') ? { ...m, role: 'crosstalk' } : m;
  const [whole, who, rest] = stamp;
  if (who.startsWith('the user')) return { ...m, role: 'user', from: null, text: m.text.slice(whole.length) };
  // The sender's app, session name and id, so a reader can tell where it came from and open it.
  const app = /^(Claude|Antigravity|Codex)\b/.exec(who)?.[1].toLowerCase() || null;
  const name = /, (?:session|conversation|thread) (.+)$/.exec(who)?.[1];
  return {
    ...m, role: 'crosstalk', from: who, text: m.text.slice(whole.length),
    fromAgent: app, fromName: name ? claude.clean(unquote(name)) : null, fromId: /crosstalk send \w+ '([^']+)'/.exec(rest)?.[1] || null,
  };
}

// One conversation's messages numbered from 1 (oldest): the last n, or n from number start.
export async function history(agent, target, { n = 10, start } = {}) {
  const { messages: all, ...h } = await numbered(agent, target);
  return { ...h, total: all.length, messages: start ? all.slice(start - 1, start - 1 + n) : all.slice(-n) };
}

// Archive, unarchive or delete a session, and write it to the log so the room shows who did it.
// Only an exact id is accepted: a title fragment or "current" could name another session.
export async function manage(action, agent, target, { force = false, actor } = {}) {
  const app = { claude, antigravity, codex }[agent];
  const fn = app?.[{ archive: 'archive', unarchive: 'unarchive', delete: 'remove' }[action]];
  if (!app) throw new Error('Usage: crosstalk archive|unarchive|delete claude|antigravity|codex <id>');
  if (!UUID.test(target || '') && !(agent === 'claude' && /^[0-9a-f]{8}$/.test(target || ''))) {
    throw new Error(`${action} takes the session's exact id (see crosstalk list ${agent}), not a title.`);
  }
  if (!fn) throw new Error(`crosstalk cannot ${action} ${agent} sessions.`);
  const row = await fn(target, { force });
  log.append({ from: await withTitle(actor), to: { agent, id: row.id, name: row.name }, text: `${action}d this session`, delivery: action });
  return row;
}

// Starts a session with a first message: in the app's window, or as a terminal session (cli).
export async function create(agent, text, { cli = false, cwd, sender, waiting = false } = {}) {
  if (cwd && !existsSync(cwd)) throw new Error(`No folder ${cwd}`);
  if (!cli && agent !== 'claude') return send(agent, 'new', text, sender, waiting); // Claude desktop sessions start only in the app
  const app = { claude, antigravity, codex }[agent];
  if (!app) throw new Error('Usage: crosstalk new claude|antigravity|codex [--cli] [--cwd DIR] <text>');
  const from = await withTitle(sender);
  const s = await app.startCli(`${header(from, agent !== 'claude')}\n${text}`, cwd);
  const to = { agent, id: s.id, name: s.name };
  log.append({ from, to, text, delivery: s.delivery });
  return { to, from, receipt: s.run ? startRun(s.run, to, from, !waiting) : s.receipt, delivery: s.delivery };
}

// A terminal session runs headless in a detached crosstalk process: it saves the answer for --wait and,
// when nobody waits, sends it back to whoever wrote, like any other reply.
const RUNS = join(log.DIR, 'runs');
const BIN = fileURLToPath(new URL('../bin/crosstalk.js', import.meta.url));
const RUN_LIMIT = 30 * 60000; // a hung agy or codex exec is stopped after this
const writeAtomic = (file, data) => {
  writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  renameSync(`${file}.tmp`, file); // a reader never sees half a file
};

function startRun(run, to, from, deliver) {
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });
  chmodSync(RUNS, 0o700); // also when an older version made it
  const id = randomUUID();
  const done = join(RUNS, `${id}.done.json`);
  const spec = join(RUNS, `${id}.spec.json`);
  writeAtomic(spec, JSON.stringify({ ...run, to, from, deliver, done }));
  const child = spawn(process.execPath, [BIN, '__run', spec], { detached: true, stdio: 'ignore' });
  child.unref();
  return { done };
}

export async function finishRun(specFile) {
  // Only run specs this module wrote: inside the runs folder, for agy or codex.
  const file = resolvePath(specFile);
  if (dirname(file) !== RUNS || !/^[0-9a-f-]{36}\.spec\.json$/.test(basename(file))) throw new Error('Not a crosstalk run.');
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file, { force: true });
  if (!(spec.kind === 'codex-app' || (['agy', 'codex'].includes(spec.kind) && /(^|\/)(agy|codex)$/.test(spec.cmd)))) throw new Error('Not a crosstalk run.');
  let reply = '';
  let error = null;
  let to = spec.to;
  try {
    if (spec.kind === 'codex-app') {
      const run = await codex.firstTurn(spec);
      reply = run.reply.trim();
      to = { ...to, id: run.id };
      if (!reply) error = run.error || 'Codex answered nothing';
    } else {
      let output = '';
      const code = await new Promise((ok) => {
        const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => ((output += `\nstopped after ${RUN_LIMIT / 60000} min`), child.kill()), RUN_LIMIT);
        child.stdout.on('data', (d) => (output += d));
        child.stderr.on('data', (d) => (output += d));
        child.on('error', (e) => ((output += `\n${e.message}`), clearTimeout(timer), ok(-1)));
        child.on('close', (c) => (clearTimeout(timer), ok(c)));
      });
      if (spec.kind === 'agy') {
        try {
          const run = JSON.parse(output.split('\n').reverse().find((line) => line.startsWith('{')));
          reply = String(run.response || '').trim();
          to = { ...to, id: run.conversation_id || to.id };
          if (!reply) error = run.denied_actions?.length ? `it tried to run ${run.denied_actions.map((a) => a.action).join(', ')}, which a headless agy run cannot ask the user for` : `agy status ${run.status}`;
        } catch {
          error = output.trim().split('\n').pop() || `agy exited with code ${code}`;
        }
      } else {
        try {
          reply = readFileSync(spec.out, 'utf8').trim();
        } catch {}
        if (!reply) error = output.trim().split('\n').pop() || `codex exec exited with code ${code}`;
      }
    }
  } catch (e) {
    error = e.message;
  } finally {
    if (spec.out) rmSync(spec.out, { force: true });
    writeAtomic(spec.done, JSON.stringify({ reply, error, to })); // --wait always gets an answer or a reason
  }
  if (!reply) return log.append({ from: to, to: spec.from, text: `(no reply: ${error})` });
  if (!spec.deliver || !['claude', 'antigravity', 'codex'].includes(spec.from?.agent) || !spec.from.id) return log.append({ from: to, to: spec.from, text: reply });
  try {
    await send(spec.from.agent, spec.from.id, reply, to, false, { replyBack: true });
  } catch (e) {
    log.append({ from: to, to: spec.from, text: reply, delivery: `not delivered: ${e.message}` }); // the answer stays in the room and the done file
  }
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
