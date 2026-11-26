// Use the running Desktop App Server through its renderer bridge.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { connect } from './cdp.js';
import { resolve } from './antigravity.js';
import { launch, locked, waitForReply, withPage } from './desktop.js';

export const PORT = Number(process.env.CROSSTALK_CODEX_PORT || 9001);

async function page() {
  try {
    return await connect(PORT, (t) => t.type === 'page' && t.url.startsWith('app://-/index'));
  } catch (e) {
    throw new Error(`Codex ${e.message}. Start it with: crosstalk open codex`);
  }
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
const describe = (t) => {
  const waiting = t.status?.activeFlags?.some((f) => /waiting/i.test(f));
  const status = waiting ? 'waiting' : t.status?.type === 'active' ? 'busy' : 'idle';
  return {
    id: t.id, name: t.name || t.preview?.trim().split('\n')[0].slice(0, 100) || t.id,
    project: basename(t.cwd || ''), status,
    note: waiting ? 'has a pending question or approval in Codex' : null,
    last: t.updatedAt * 1000 || null,
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
  return out;
}

async function thread(p, target) {
  const id = !target || target === 'current'
    ? await p.run(currentId)
    : /^[0-9a-f-]{36}$/.test(target) ? target : resolve(await rows(p), target, 'Codex');
  if (!id) throw new Error('No current saved Codex chat. Use an ID from crosstalk list codex.');
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

export const send = (target, buildText, waiting = false) => drive(async (p) => {
  let t = target === 'new'
    ? (await request(p, 'thread/start', { cwd: process.cwd() })).thread
    : await thread(p, target);
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
