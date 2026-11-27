// Codex threads: the desktop app's App Server through its window when it has a debug port,
// otherwise a private `codex app-server`; command-line threads continue with `codex exec resume`.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DIR } from './log.js';
import { connect } from './cdp.js';
import { resolve } from './antigravity.js';
import { launch, locked, waitForReply, withPage } from './desktop.js';

export const PORT = Number(process.env.CROSSTALK_CODEX_PORT || 9001);

async function page() {
  try {
    return await connect(PORT, (t) => t.type === 'page' && t.url.startsWith('app://-/index'));
  } catch {
    return stdioServer(); // no window port: Codex's own app server answers the same requests
  }
}

// The documented `codex app-server` over stdio, dressed as a page so the code below runs unchanged.
function stdioServer() {
  const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let buffer = '';
  let next = 0;
  const fail = (e) => { for (const { bad } of waiting.values()) bad(e); waiting.clear(); };
  child.on('error', () => fail(new Error('Codex CLI not found; install it or open the Codex window with: crosstalk open codex')));
  child.on('exit', () => fail(new Error('codex app-server stopped')));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      let m;
      try {
        m = JSON.parse(buffer.slice(0, i));
      } catch {
        continue;
      }
      const call = waiting.get(m.id);
      if (!call) continue;
      waiting.delete(m.id);
      if (m.error) call.bad(new Error(m.error.message));
      else call.ok(m.result);
    }
  });
  const call = (method, params) => new Promise((ok, bad) => {
    const id = ++next;
    const timer = setTimeout(() => waiting.has(id) && (waiting.delete(id), bad(new Error(`codex app-server: ${method} timed out`))), 20000);
    waiting.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), bad: (e) => (clearTimeout(timer), bad(e)) });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = call('initialize', { clientInfo: { name: 'crosstalk', version: '0' } })
    .then(() => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`));
  ready.catch(() => {}); // surfaced by the first run() instead
  return {
    stdio: true,
    async run(fn, ...args) {
      await ready;
      if (fn === pageRequest) return call(...args);
      if (fn === currentId) return null; // only the window knows which chat is open
      throw new Error('This needs the Codex window: crosstalk open codex');
    },
    close: () => {
      waiting.clear(); // nobody waits for answers after close
      child.kill();
    },
  };
}

const currentId = () => {
  const transcript = [...document.querySelectorAll('[data-rail-chat-transcript]')].find((t) => t.offsetParent);
  const active = document.querySelector('[data-app-action-sidebar-thread-active=true]')?.dataset.appActionSidebarThreadId || '';
  return transcript?.querySelector('[data-response-update-thread]')?.dataset.responseUpdateThread
    || active.match(/^local:([0-9a-f-]{36})$/)?.[1] || null;
};

// shortcut: Electron's bridge is internal. Use the documented control socket once Desktop exposes it.
function pageRequest(method, params) {
  return new Promise((resolve, reject) => {
    const bridge = window.electronBridge;
    if (!bridge?.sendMessageFromView) return reject(new Error('Codex Desktop App Server bridge not found'));
    const id = 'crosstalk-' + crypto.randomUUID();
    const clear = () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
    const receive = (event) => {
      const { type, message } = event.data ?? {};
      if (event.source !== window || type !== 'mcp-response' || message?.id !== id) return;
      clear();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    const timer = setTimeout(() => {
      clear();
      reject(new Error(`Codex ${method} did not confirm the request. Check the chat before retrying.`));
    }, 12000);
    window.addEventListener('message', receive);
    bridge.sendMessageFromView({ type: 'mcp-request', hostId: 'local', request: { id, method, params } }).catch((error) => {
      clear();
      reject(error);
    });
  });
}

const request = (p, method, params) => p.run(pageRequest, method, params);
// A thread started by crosstalk opens with its header line; the name is the line after it.
const firstLine = (text = '') => text.trim().split('\n').find((l) => l.trim() && !l.startsWith('[crosstalk]'))?.slice(0, 100);
const describe = (t) => {
  const waiting = t.status?.activeFlags?.some((f) => /waiting/i.test(f));
  const status = waiting ? 'waiting' : t.status?.type === 'active' ? 'busy' : 'idle';
  return {
    id: t.id, name: t.name || firstLine(t.preview) || t.id,
    project: basename(t.cwd || ''), status,
    note: waiting ? 'has a pending question or approval in Codex' : null,
    last: t.updatedAt * 1000 || null,
    surface: t.source === 'cli' ? 'cli' : t.source === 'exec' ? 'exec' : t.originator === 'codex_vscode' ? 'ide' : 'desktop',
    parent: t.forkedFromId || t.parentThreadId || t.attachedToThreadId || null,
    kind: t.forkedFromId ? 'fork' : t.parentThreadId || t.attachedToThreadId ? 'sub' : null,
  };
};

async function rows(p) {
  const out = [];
  let cursor = null;
  do {
    const result = await request(p, 'thread/list', { limit: 100, cursor, archived: false, sourceKinds: ['vscode', 'appServer', 'cli'] });
    out.push(...result.data.map(describe));
    cursor = result.nextCursor;
  } while (cursor);
  // `codex exec` runs pile up by the hundred (reviews, scripts); only today's are worth reaching.
  const runs = await request(p, 'thread/list', { limit: 50, archived: false, sourceKinds: ['exec'] });
  out.push(...runs.data.filter((t) => Date.now() - t.updatedAt * 1000 < 864e5).map(describe));
  return out;
}

async function thread(p, target) {
  const id = !target || target === 'current'
    ? await p.run(currentId)
    : /^[0-9a-f-]{36}$/.test(target) ? target : resolve(await rows(p), target, 'Codex');
  if (!id) throw new Error(p.stdio ? '"current" needs the Codex window (crosstalk open codex). Use a thread ID.' : 'No current saved Codex chat. Use an ID from crosstalk list codex.');
  const result = await request(p, 'thread/read', { threadId: id, includeTurns: false });
  return result.thread;
}

const drive = (fn) => locked('codex', page, fn);
export const list = () => withPage(page, rows);
export const status = (target) => withPage(page, async (p) => describe(await thread(p, target)));

async function* turns(p, id, limit = 10) {
  let cursor = null;
  do {
    const result = await request(p, 'thread/turns/list', {
      threadId: id, limit, cursor, sortDirection: 'desc', itemsView: 'full',
    });
    yield* result.data;
    cursor = result.nextCursor;
  } while (cursor);
}

const assistantText = (turn) => turn?.items?.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text || '';

// The user's and Codex's messages, oldest first; tool calls and reasoning are left out.
export const messages = (target) => withPage(page, async (p) => {
  const t = await thread(p, target);
  const newestFirst = [];
  for await (const turn of turns(p, t.id, 50)) newestFirst.push(turn);
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

export const send = (target, buildText, waiting = false) => drive(async (p) => {
  if (target === 'new' && p.stdio) {
    // Without the window a new thread would die with this process, so it runs as a headless exec.
    return { id: null, name: 'new codex exec run', surface: 'exec', run: execRun([buildText({ surface: 'exec' })], process.cwd()), delivery: 'submitted' };
  }
  let t = target === 'new'
    ? (await request(p, 'thread/start', { cwd: process.cwd() })).thread
    : await thread(p, target);
  const surface = describe(t).surface;
  if (surface === 'cli' || surface === 'exec') {
    // A terminal thread stays in the terminal world: it continues headless, the desktop app is not involved.
    return { ...describe(t), run: execRun(['resume', t.id, buildText(describe(t))], t.cwd), delivery: 'submitted' };
  }
  if (p.stdio) {
    // The desktop app owns this thread and runs it; its queue takes the message for the thread's next turn.
    if (waiting) throw new Error(`The Codex window has no debug port, so "${describe(t).name}" cannot start now. Send without --wait to queue it, or run: crosstalk open codex`);
    execFileSync('codex', ['queue', '--thread', t.id, '--message', buildText(describe(t))], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    return { ...describe(t), delivery: 'queued' };
  }
  if (t.status?.type === 'notLoaded') {
    t = (await request(p, 'thread/resume', { threadId: t.id, excludeTurns: true })).thread;
  }
  const state = describe(t);
  if (waiting && t.ephemeral) throw new Error('Codex cannot look up turn history for a temporary chat. Send without --wait.');
  const text = buildText(state);
  const input = [{ type: 'text', text, text_elements: [] }];
  if (state.status !== 'idle') {
    if (waiting) throw new Error(`Codex "${state.name}" is busy. Send without --wait to queue the message.`);
    const queued = await request(p, 'thread/queue/add', { threadId: t.id, input, clientUserMessageId: randomUUID() });
    if (!queued?.queuedSubmission?.id) throw new Error('Codex did not confirm queueing. Check the chat before retrying.');
    return { ...state, delivery: 'queued' };
  }
  const result = await request(p, 'turn/start', { threadId: t.id, input });
  if (!result.turn?.id) throw new Error('Codex did not return a turn ID. Check the chat before retrying.');
  return { ...state, receipt: result.turn.id };
});

// A new terminal thread: a headless `codex exec` run in cwd.
export const startCli = (text, cwd) => ({ id: null, name: 'new codex exec run', surface: 'exec', run: execRun([text], cwd), delivery: 'submitted' });

// Archive (reversible), unarchive or delete a thread through the App Server; a working thread is left alone unless forced.
const manage = (method, verb) => (target, { force = false } = {}) => drive(async (p) => {
  const t = await thread(p, target);
  const s = describe(t);
  if (!force && verb !== 'unarchive' && s.status !== 'idle') throw new Error(`Codex "${s.name}" is ${s.status}. Add --force to ${verb} it anyway.`);
  await request(p, method, { threadId: t.id });
  return s;
});
export const archive = manage('thread/archive', 'archive');
export const unarchive = manage('thread/unarchive', 'unarchive');
export const remove = manage('thread/delete', 'delete');

export const waitReply = (id, turnId, timeoutMs) => withPage(page, (p) => waitForReply(async () => {
  for await (const turn of turns(p, id)) {
    if (turn.id !== turnId) continue;
    if (turn.status === 'inProgress') return null;
    if (turn.status !== 'completed') throw new Error(`Codex turn ${turn.status}: ${turn.error?.message || 'open the chat for details'}`);
    const reply = assistantText(turn);
    if (!reply) throw new Error('Codex turn completed without a reply. Open the chat for details.');
    return { state: describe(await thread(p, id)), reply };
  }
  return null;
}, { app: 'Codex', id, timeoutMs }));

export async function open() {
  const restarted = await launch('ChatGPT', PORT);
  await withPage(page, (p) => request(p, 'thread/list', { limit: 1, archived: false }));
  return `Codex ${restarted ? 'open' : 'already reachable'} on 127.0.0.1:${PORT}`;
}
