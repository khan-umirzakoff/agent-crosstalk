// Codex threads through the documented `codex app-server`: list, read, status, archive, delete, and a new
// thread's first turn. The desktop app owns its threads, so a message goes into the thread's queue
// (`codex queue`) and a codex:// link has the app open the thread, which runs it now or after the turn in
// progress. Terminal threads (codex, codex exec) continue headless with `codex exec resume`.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolve } from './antigravity.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { DIR } from './log.js';

const UUID = /^[0-9a-f-]{36}$/;

// One `codex app-server` over stdio: JSON-RPC calls and its notifications.
function server() {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  const listeners = new Set();
  let buffer = '';
  let next = 0;
  const fail = (e) => {
    for (const { bad } of waiting.values()) bad(e);
    waiting.clear();
  };
  child.on('error', () => fail(new Error('Codex CLI not found. Install Codex, then try again.')));
  const self = { dead: false };
  child.on('exit', () => {
    self.dead = true; // the next call starts a fresh one
    fail(new Error('codex app-server stopped'));
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      let m;
      try {
        m = JSON.parse(buffer.slice(0, i));
      } catch {
        continue;
      }
      if (m.method && m.id === undefined) for (const listen of listeners) listen(m);
      const call = waiting.get(m.id);
      if (!call) continue;
      waiting.delete(m.id);
      if (m.error) call.bad(new Error(m.error.message));
      else call.ok(m.result);
    }
  });
  const send = (method, params, timeoutMs = 20000) => new Promise((ok, bad) => {
    const id = ++next;
    const timer = setTimeout(() => waiting.delete(id) && bad(new Error(`codex app-server: ${method} timed out`)), timeoutMs);
    waiting.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), bad: (e) => (clearTimeout(timer), bad(e)) });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = send('initialize', { clientInfo: { name: 'crosstalk', version: '0' } })
    .then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`));
  ready.catch(() => {}); // the first call reports it
  return Object.assign(self, {
    call: async (method, params, timeoutMs) => (await ready, send(method, params, timeoutMs)),
    on: (listen) => (listeners.add(listen), () => listeners.delete(listen)),
    close: () => {
      waiting.clear();
      child.kill();
    },
  });
}
// A long-running host (crosstalk daemon) keeps one app-server for every call; a one-off command starts its own.
let shared = null;
let keep = false;
export const keepServer = () => {
  keep = true;
};
export const releaseServer = () => {
  keep = false;
  shared?.close();
  shared = null;
};
async function withServer(fn) {
  if (keep) {
    if (!shared || shared.dead) shared = server();
    return fn(shared);
  }
  const s = server();
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

// A thread started by crosstalk opens with its header line; the name is the line after it.
const firstLine = (text = '') => text.trim().split('\n').find((l) => l.trim() && !l.startsWith('[crosstalk]'))?.slice(0, 100);
const describe = (t) => {
  const waiting = t.status?.activeFlags?.some((f) => /waiting/i.test(f));
  const status = waiting ? 'waiting' : t.status?.type === 'active' ? 'busy' : 'idle';
  return {
    id: t.id, name: t.name || firstLine(t.preview) || t.id,
    project: basename(t.cwd || ''), cwd: t.cwd, status,
    note: waiting ? 'has a pending question or approval in Codex' : null,
    last: t.updatedAt * 1000 || null,
    surface: t.source === 'cli' ? 'cli' : t.source === 'exec' ? 'exec' : t.originator === 'codex_vscode' ? 'ide' : 'desktop',
    parent: t.forkedFromId || t.parentThreadId || t.attachedToThreadId || null,
    kind: t.forkedFromId ? 'fork' : t.parentThreadId || t.attachedToThreadId ? 'sub' : null,
  };
};

async function rows(s) {
  const out = [];
  let cursor = null;
  do {
    const result = await s.call('thread/list', { limit: 100, cursor, archived: false, sourceKinds: ['vscode', 'appServer', 'cli'] });
    out.push(...result.data.map(describe));
    cursor = result.nextCursor;
  } while (cursor);
  // `codex exec` runs pile up by the hundred (reviews, scripts); only today's are worth reaching.
  const runs = await s.call('thread/list', { limit: 50, archived: false, sourceKinds: ['exec'] });
  out.push(...runs.data.filter((t) => Date.now() - t.updatedAt * 1000 < 864e5).map(describe));
  return out;
}

// "current" is the desktop thread used last.
async function thread(s, target) {
  let id = target;
  if (!target || target === 'current') {
    id = (await rows(s)).filter((r) => r.surface === 'desktop').sort((a, b) => b.last - a.last)[0]?.id;
    if (!id) throw new Error('No Codex desktop thread yet.');
  } else if (!UUID.test(target)) id = resolve(await rows(s), target, 'Codex');
  return (await s.call('thread/read', { threadId: id, includeTurns: false })).thread;
}

export const list = () => withServer(rows);
export const status = (target) => withServer(async (s) => describe(await thread(s, target)));

async function* turns(s, id, limit = 10) {
  let cursor = null;
  do {
    const result = await s.call('thread/turns/list', { threadId: id, limit, cursor, sortDirection: 'desc', itemsView: 'full' });
    yield* result.data;
    cursor = result.nextCursor;
  } while (cursor);
}

const userText = (turn) => turn.items?.filter((i) => i.type === 'userMessage').flatMap((i) => (i.content || []).filter((c) => c.type === 'text').map((c) => c.text)).join('\n') || '';
const assistantText = (turn) => turn?.items?.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text || '';

// The user's and Codex's messages, oldest first; tool calls and reasoning are left out.
export const messages = (target) => withServer(async (s) => {
  const t = await thread(s, target);
  const newestFirst = [];
  for await (const turn of turns(s, t.id, 50)) newestFirst.push(turn);
  const list = newestFirst.reverse().flatMap((turn) => (turn.items || []).flatMap((item) => {
    const text = item.type === 'userMessage' ? (item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      : item.type === 'agentMessage' ? item.text : '';
    return text?.trim() ? [{ role: item.type === 'userMessage' ? 'user' : 'codex', text: text.trim(), ts: item.startedAtMs }] : [];
  }));
  return { id: t.id, name: describe(t).name, messages: list };
});

// A headless `codex exec` run, which crosstalk starts and follows (core.startRun); its last message lands in out.
function execRun(args, cwd) {
  const out = join(DIR, 'runs', `${randomUUID()}.txt`);
  return { kind: 'codex', cmd: 'codex', args: ['exec', ...args.slice(0, -1), '--skip-git-repo-check', '-o', out, args.at(-1)], cwd: cwd && existsSync(cwd) ? cwd : process.cwd(), out };
}

// A new desktop thread is saved once it has a turn, so its first turn runs here, in crosstalk's follower process
// (kind codex-app); the app lists the thread from then on and later messages go through its queue.
export async function firstTurn({ cwd, text }, timeoutMs = 30 * 60000) {
  return withServer(async (s) => {
    const t = (await s.call('thread/start', { cwd })).thread;
    const completed = new Promise((ok) => {
      const stop = s.on((m) => m.method === 'turn/completed' && m.params?.threadId === t.id && (stop(), ok(m.params.turn)));
      setTimeout(() => ok(null), timeoutMs);
    });
    await s.call('turn/start', { threadId: t.id, input: [{ type: 'text', text, text_elements: [] }] });
    const done = await completed;
    for await (const turn of turns(s, t.id, 1)) return { id: t.id, reply: assistantText(turn), error: done ? turn.error?.message : 'timed out' };
    return { id: t.id, reply: '', error: 'no turn' };
  });
}

export async function send(target, buildText) {
  if (target === 'new') {
    const text = buildText({ surface: 'desktop' });
    return { id: null, name: 'new codex thread', surface: 'desktop', run: { kind: 'codex-app', cwd: process.cwd(), text }, delivery: 'submitted' };
  }
  const t = await withServer((s) => thread(s, target));
  const state = describe(t);
  if (state.surface === 'cli' || state.surface === 'exec') {
    // A terminal thread stays in the terminal world: it continues headless, the desktop app is not involved.
    return { ...state, run: execRun(['resume', t.id, buildText(state)], t.cwd), delivery: 'submitted' };
  }
  const text = buildText(state);
  execFileSync('codex', ['queue', '--thread', t.id, '--message', text], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  // shortcut: codex:// links open threads on macOS only; elsewhere the message waits for the thread's next turn.
  if (process.platform === 'darwin') execFileSync('open', ['-g', `codex://threads/${t.id}`], { stdio: 'ignore', timeout: 10000 });
  return { ...state, receipt: { text }, delivery: state.status === 'idle' ? undefined : 'queued' };
}

// A new terminal thread: a headless `codex exec` run in cwd.
export const startCli = (text, cwd) => ({ id: null, name: 'new codex exec run', surface: 'exec', run: execRun([text], cwd), delivery: 'submitted' });

// Archive (reversible), unarchive or delete a thread through the App Server; a working thread is left alone unless forced.
const manage = (method, verb) => (target, { force = false } = {}) => withServer(async (s) => {
  const t = await thread(s, target);
  const state = describe(t);
  if (!force && verb !== 'unarchive' && state.status !== 'idle') throw new Error(`Codex "${state.name}" is ${state.status}. Add --force to ${verb} it anyway.`);
  await s.call(method, { threadId: t.id }).catch((e) => {
    // The desktop app has the thread open and is its only writer.
    throw /active writer/.test(e.message) ? new Error(`The Codex app has "${state.name}" open. ${verb[0].toUpperCase() + verb.slice(1)} it in the app.`) : e;
  });
  return state;
});
export const archive = manage('thread/archive', 'archive');
export const unarchive = manage('thread/unarchive', 'unarchive');
export const remove = manage('thread/delete', 'delete');

// Waits for the turn that took our queued message and returns Codex's answer in it.
export const waitReply = (id, receipt, timeoutMs) => withServer(async (s) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for await (const turn of turns(s, id, 10)) {
      if (userText(turn).trim() !== receipt.text.trim()) continue;
      if (turn.status === 'inProgress') break;
      if (turn.status !== 'completed') throw new Error(`Codex turn ${turn.status}: ${turn.error?.message || 'open the chat for details'}`);
      const reply = assistantText(turn);
      if (!reply) throw new Error('Codex turn completed without a reply. Open the chat for details.');
      return { state: describe(await thread(s, id)), reply };
    }
    await sleep(3000);
  }
  throw new Error(`Codex has no reply after ${Math.round(timeoutMs / 1000)} s. Check thread ${id}.`);
});

export async function open() {
  return 'Codex needs no restart: crosstalk uses codex app-server and the app opens threads by their codex:// link.';
}
