// Antigravity conversations, from the desktop app and from the agy command line.
// Reading uses each conversation's own file; sending uses the app window when it has a debug port,
// otherwise the app's bundled agentapi, and `agy --conversation` for command-line conversations.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from './cdp.js';
import { deliver, launch, locked, waitForReply, withPage } from './desktop.js';

export const PORT = Number(process.env.CROSSTALK_ANTIGRAVITY_PORT || 9000);
const INPUT = '[aria-label="Message input"]';
const DATABASE = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GEMINI = join(homedir(), '.gemini');
const STORES = [join(GEMINI, 'antigravity', 'conversations'), join(GEMINI, 'antigravity-cli', 'conversations')];
const AGENTAPI = join(GEMINI, 'antigravity', 'bin', 'agentapi');
const AGY = existsSync(join(homedir(), '.local', 'bin', 'agy')) ? join(homedir(), '.local', 'bin', 'agy') : 'agy';
const offline = (e) => /crosstalk open antigravity/.test(e.message); // the window has no debug port

async function page() {
  try {
    return await connect(PORT, (t) => t.type === 'page' && /^https:\/\/127\.0\.0\.1:\d+\//.test(t.url));
  } catch (e) {
    throw new Error(`Antigravity ${e.message}. Start it with: crosstalk open antigravity`);
  }
}

// Page-side functions: they run inside Antigravity, so they only use the DOM.
const pageList = () => {
  let project = '';
  return [...document.querySelectorAll('[data-testid=project-header-container],[data-testid=conversation-row-sidebar]')].flatMap((e) => {
    if (e.dataset.testid === 'project-header-container') {
      project = e.innerText.trim().split('\n')[0];
      return [];
    }
    const [title, age] = e.innerText.trim().split('\n');
    return [{ id: e.dataset.cascadeId, name: title, project, age: age || '', open: e.dataset.selected === 'true' }];
  });
};
const pageState = () => {
  const id = location.pathname.match(/\/c\/([0-9a-f-]{36})/)?.[1] || null;
  const row = id && document.querySelector(`[data-cascade-id="${id}"]`);
  const box = document.querySelector('[data-testid=agent-input-box]');
  // While the agent runs, the input box offers a stop button and locks the model picker.
  const busy = !!box && [...box.querySelectorAll('button')].some((b) => /stop|cancel|while the agent is running/i.test(b.getAttribute('aria-label') || b.dataset.tooltipId || ''));
  // An approval card (outside the input box) means the agent waits for the person, e.g. to run a command.
  const view = document.querySelector('[data-testid=conversation-view]');
  const ask = view && [...view.querySelectorAll('button')].find((b) => b.offsetParent && !b.closest('[data-testid=agent-input-box]') &&
    /^(accept|reject|run|allow|deny|approve|always allow|allow once)\b/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
  const status = ask ? 'waiting' : busy ? 'busy' : 'idle';
  const note = ask ? `needs the user's approval ("${(ask.getAttribute('aria-label') || ask.innerText).trim().slice(0, 40)}")` : null;
  const draft = document.querySelector('[aria-label="Message input"]')?.innerText.trim() || '';
  return { id, name: row?.innerText.trim().split('\n')[0] || document.title.replace(/ - .*$/, ''), status, note, draft: !!draft };
};
const pageHasInput = (sel) => !!document.querySelector(sel);

// shortcut: the live Antigravity client is an internal React provider. Switch to a public Desktop API when available.
async function pageConversation(id, action, receipt, text) {
  const roots = [...document.querySelectorAll('#root, body > div')].flatMap((node) =>
    Object.keys(node).filter((key) => key.startsWith('__reactContainer')).map((key) => node[key]?.stateNode?.current || node[key]));
  let client;
  while (roots.length) {
    const fiber = roots.pop();
    const value = fiber?.memoizedProps?.value;
    if (typeof value?.getCascadeTrajectory === 'function' && typeof value?.sendUserCascadeMessage === 'function') {
      client = value;
      break;
    }
    if (fiber?.child) roots.push(fiber.child);
    if (fiber?.sibling) roots.push(fiber.sibling);
  }
  if (!client) throw new Error('Antigravity Desktop conversation client not found');
  const result = await client.getCascadeTrajectory({ cascadeId: id });
  if (result.trajectory?.cascadeId !== id) throw new Error('Antigravity did not return the requested conversation');
  const { steps, generatorMetadata } = result.trajectory;
  if (action === 'messages') return steps.flatMap(({ step }) => {
    const user = step?.case === 'userInput';
    const text = user ? (step.value.items?.map((i) => (typeof i.chunk?.value === 'string' ? i.chunk.value : '')).join('') || step.value.query || '')
      : step?.case === 'plannerResponse' ? step.value.modifiedResponse || step.value.response || '' : '';
    return text.trim() ? [{ role: user ? 'user' : 'antigravity', text: text.trim() }] : [];
  });
  const idle = result.status === 1;
  const waiting = !idle && steps.some((step) => step.status === 9);
  if (action === 'send') {
    const config = generatorMetadata.findLast((entry) => entry.plannerConfig?.planModel)?.plannerConfig;
    if (!config) throw new Error('This Antigravity conversation has no saved model. Send its first message in the app.');
    const { planModel, plannerTypeConfig, planExecuteConfig } = config;
    await client.sendUserCascadeMessage({
      cascadeId: id, clientMessageId: receipt.id, deliveryStrategy: 2, // When idle, including an already idle conversation.
      cascadeConfig: { plannerConfig: { planModel, plannerTypeConfig, planExecuteConfig } },
      items: [{ chunk: { case: 'text', value: text } }],
    });
  }

  let reply = '';
  let error = null;
  let complete = false;
  if (action === 'read' || action === 'wait') {
    let turn = steps;
    if (receipt) {
      const start = steps.findIndex(({ step }) => step?.case === 'userInput' && (receipt.text
        ? step.value.items?.some((item) => item.chunk?.value === receipt.text) || step.value.query === receipt.text
        : step.value.clientMessageId === receipt.id));
      const next = start < 0 ? -1 : steps.findIndex(({ step }, index) => index > start && step?.case === 'userInput');
      turn = start < 0 ? [] : steps.slice(start + 1, next < 0 ? undefined : next);
      complete = start >= 0 && (next >= 0 || (idle && steps[start].status === 3));
    }
    const response = turn.findLast(({ step }) => step?.case === 'plannerResponse')?.step.value;
    reply = (response?.modifiedResponse || response?.response || '').trim();
    const details = turn.findLast(({ step }) => step?.case === 'errorMessage')?.step.value.error;
    error = details?.userErrorMessage || details?.shortError || null;
  }
  return { status: waiting ? 'waiting' : idle ? 'idle' : 'busy', reply, error, complete };
}

async function savedRows() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DATABASE, { readOnly: true });
    try {
      const parents = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_parents'").get();
      return db.prepare(`SELECT s.conversation_id AS id, s.title AS name, s.status, s.last_modified_time AS last, s.agent_name AS agent, s.source, s.preview,
        COALESCE(NULLIF(s.parent_conversation_id, ''), ${parents ? 'p.parent_id' : 'NULL'}) AS parent,
        CASE WHEN json_valid(s.workspace_uris) THEN json_extract(s.workspace_uris, '$[0]') END AS workspace
        FROM conversation_summaries s ${parents ? 'LEFT JOIN conversation_parents p ON p.conversation_id = s.conversation_id' : ''}
        WHERE s.killed = 0 ORDER BY s.last_modified_time DESC`).all()
        .filter((row) => UUID.test(row.id))
        .map((row) => ({
          id: row.id, name: row.name || row.preview?.trim().split('\n').find((l) => l.trim() && !l.startsWith('[crosstalk]'))?.slice(0, 80) || row.id, project: basename(row.workspace || ''),
          cwd: row.workspace?.startsWith('file://') ? fileURLToPath(row.workspace) : null,
          status: /RUNNING|BUSY|CANCELING/.test(row.status) ? 'busy' : 'idle',
          last: Date.parse(String(row.last).replace(' ', 'T')) || null,
          parent: row.parent || null, kind: row.parent ? row.agent || 'sub' : null, // agent: browser, builder, critic, research…
          surface: row.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' ? 'cli' : 'desktop', // the agy command line or the app
        }));
    } finally {
      db.close();
    }
  } catch {
    return []; // Older Node/macOS or app schema: the live sidebar still contributes IDs.
  }
}

// target: conversation id, its exact title, a unique part of its title, "current" or "new".
export function resolve(rows, target, app = 'Antigravity') {
  if (UUID.test(target)) return target;
  const t = target.toLowerCase();
  const exact = rows.filter((r) => r.name.toLowerCase() === t);
  const partial = exact.length ? exact : rows.filter((r) => r.name.toLowerCase().includes(t));
  if (partial.length === 1) return partial[0].id;
  if (!partial.length) throw new Error(`No ${app} conversation matches "${target}". See: crosstalk list ${app.toLowerCase()}`);
  throw new Error(`"${target}" matches ${partial.length} conversations: ${partial.map((r) => `${r.name} (${r.id})`).join('; ')}. Use the id.`);
}

async function waitFor(p, test, what) {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const s = await p.run(pageState).catch(() => null);
    if (s && test(s) && (await p.run(pageHasInput, INPUT).catch(() => false))) return s;
  }
  throw new Error(`${what} did not open.`);
}

const drive = (fn) => locked('antigravity', page, fn);

async function rows(p) {
  const [saved, visible, now] = await Promise.all([savedRows(), p.run(pageList), p.run(pageState)]);
  const all = new Map(saved.map((row) => [row.id, row]));
  for (const row of visible) if (row.id) all.set(row.id, { ...all.get(row.id), ...row });
  if (now.id) all.set(now.id, { ...all.get(now.id), ...now });
  return [...all.values()].map((row) => ({ surface: 'desktop', ...row }));
}

async function resolveTarget(p, target) {
  if (!target || target === 'current') return p.run(pageState);
  const all = await rows(p);
  const id = resolve(all, target);
  return all.find((row) => row.id === id) || { id, name: id };
}

export const list = () => withPage(page, rows).catch((e) => (offline(e) ? savedRows() : Promise.reject(e)));

async function savedRow(target) {
  const saved = await savedRows();
  const id = resolve(saved, target);
  return saved.find((row) => row.id === id) || { id, name: id, surface: 'desktop' };
}

export const status = (target) => withPage(page, async (p) => {
  const state = await resolveTarget(p, target);
  if (!state.id) return state;
  const { status } = await p.run(pageConversation, state.id, 'status');
  return { ...state, status, note: status === 'waiting' ? 'has a pending question or approval in Antigravity' : null };
}).catch((e) => (offline(e) && target && target !== 'current' ? savedRow(target) : Promise.reject(e)));

// Protobuf bytes at a field path (e.g. [19, 2]); each step is one message in the app's private format.
// shortcut: the field numbers are Antigravity internals (user 19.2, reply 20.8 or 20.1, message 114.2.10.1); re-check when it changes.
function field(buf, path) {
  let i = 0;
  const varint = () => {
    let x = 0;
    let shift = 0;
    let b;
    do {
      b = buf[i++];
      x += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return x;
  };
  while (i < buf.length) {
    const key = varint();
    const type = key % 8;
    if (type === 0) varint();
    else if (type === 1) i += 8;
    else if (type === 5) i += 4;
    else if (type === 2) {
      const len = varint();
      const sub = buf.subarray(i, i + len);
      i += len;
      if (Math.floor(key / 8) === path[0]) return path.length === 1 ? sub : field(sub, path.slice(1));
    } else return null;
  }
  return null;
}
const str = (buf, path) => field(buf, path)?.toString('utf8').trim() || '';

// The user's messages, messages from agents and Antigravity's replies, read from the conversation's file.
async function fileMessages(id) {
  const file = STORES.map((dir) => join(dir, `${id}.db`)).find(existsSync);
  if (!file) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT step_type AS type, step_payload AS payload FROM steps ORDER BY idx').all().flatMap(({ type, payload }) => {
      const buf = Buffer.from(payload || []);
      const one = (role, text, from) => (text ? [{ role, text, ...(from ? { from } : {}) }] : []);
      if (type === 14) return one('user', str(buf, [19, 2]));
      if (type === 15) return one('antigravity', str(buf, [20, 8]) || str(buf, [20, 1]));
      if (type === 101) {
        const text = str(buf, [114, 2, 10, 1]);
        return text.startsWith('[Notice]') ? [] : one('peer', text, str(buf, [114, 4, 3]));
      }
      return [];
    });
  } finally {
    db.close();
  }
}

export async function messages(target) {
  if (!target || target === 'current') {
    return withPage(page, async (p) => {
      const s = await p.run(pageState);
      return { id: s.id, name: s.name, messages: s.id ? (await fileMessages(s.id)) || await p.run(pageConversation, s.id, 'messages') : [] };
    });
  }
  const row = await savedRow(target);
  const list = await fileMessages(row.id);
  if (list) return { id: row.id, name: row.name, messages: list };
  return withPage(page, async (p) => ({ id: row.id, name: row.name, messages: await p.run(pageConversation, row.id, 'messages') }));
}

// The running app's language server: its port and token are in an address file the app writes.
function liveHub() {
  const dir = join(GEMINI, 'antigravity', 'daemon');
  const hub = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /^hub_\d+\.json$/.test(f))
    .map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), at: statSync(join(dir, f)).mtimeMs }))
    .filter((h) => { try { process.kill(h.pid, 0); return true; } catch { return false; } })
    .sort((a, b) => b.at - a.at)[0];
  if (!hub) throw new Error('Antigravity is not running. Open the app, then try again.');
  return hub;
}

// shortcut: a private Connect RPC of the app's language server (the app's own UI uses it); no public API exists.
async function rpc(method, body) {
  const hub = liveHub();
  const r = await fetch(`http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-codeium-csrf-token': hub.csrfToken },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Antigravity: ${out.message || r.status}`);
  return out;
}

// Deletes a desktop conversation the way the app's own delete does. agy conversations live outside the app.
export async function remove(target, { force = false } = {}) {
  const row = await savedRow(target);
  if (row.surface === 'cli') throw new Error(`"${row.name}" is an agy (terminal) conversation; crosstalk can delete only desktop conversations.`);
  if (!force && row.status !== 'idle') throw new Error(`Antigravity "${row.name}" is ${row.status}. Add --force to delete it anyway.`);
  await rpc('DeleteCascadeTrajectory', { cascadeId: row.id });
  return row;
}

// A new agy (terminal) conversation in cwd; its id arrives with the answer.
export const startCli = (text, cwd) => ({ id: null, name: 'new agy conversation', surface: 'cli', run: agyRun(['-p', text], cwd), delivery: 'submitted' });

// The app's own agentapi, pointed at the running app's language server.
function agentapi(args) {
  const hub = liveHub();
  const out = JSON.parse(execFileSync(AGENTAPI, args, {
    env: { ...process.env, ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${hub.httpPort}`, ANTIGRAVITY_CSRF_TOKEN: hub.csrfToken },
    encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (out.error) throw new Error(`Antigravity: ${out.error}`);
  return out.response;
}

// A command-line conversation continues in a headless `agy` run, which crosstalk starts and follows (core.startRun).
const agyRun = (args, cwd) => ({ kind: 'agy', cmd: AGY, args: [...args, '--output-format', 'json'], cwd: cwd && existsSync(cwd) ? cwd : homedir() });
const sendCli = (row, text) => ({ ...row, run: agyRun(['--conversation', row.id, '-p', text], row.cwd), delivery: 'submitted' });

export async function send(target, buildText) {
  const row = target && target !== 'new' && target !== 'current' ? await savedRow(target) : null;
  if (row?.surface === 'cli') return sendCli(row, buildText(row));
  try {
    return await sendWindow(target, buildText);
  } catch (e) {
    if (!offline(e)) throw e;
    if (target === 'current' || !target) throw new Error('"current" needs the Antigravity window: crosstalk open antigravity. Or use the conversation id.');
    const text = buildText(row || { id: null, name: 'new conversation' });
    const receipt = { id: randomUUID(), text, via: 'agentapi' };
    if (!row) return { id: agentapi(['new-conversation', text]).newConversation.conversationId, name: 'new conversation', receipt, delivery: 'submitted' };
    agentapi(['send-message', row.id, text]);
    return { ...row, receipt, delivery: 'submitted' };
  }
}

const sendWindow = (target, buildText) => drive(async (p) => {
  const state = target === 'new' ? null : await resolveTarget(p, target);
  const receipt = { id: randomUUID() };
  if (state?.id) {
    const { status } = await p.run(pageConversation, state.id, 'send', receipt, buildText(state));
    return { ...state, status, receipt, delivery: status === 'idle' ? undefined : 'queued' };
  }
  if (target === 'new') {
    const clicked = await p.run(() => {
      const button = document.querySelector('[data-testid=new-conversation-button]');
      button?.click();
      return !!button;
    });
    if (!clicked) throw new Error('New conversation button not found.');
  }
  const before = state || await waitFor(p, (s) => s.id === null, 'New conversation');
  receipt.text = `${buildText(before)}\n\n[Crosstalk message ${receipt.id}]`;
  let after = await deliver(p, { input: INPUT, pageState, before, text: receipt.text, app: 'Antigravity' });
  if (!after.id) after = await waitFor(p, (s) => !!s.id, 'Sent Antigravity conversation');
  return { ...after, receipt };
});

export async function waitReply(id, receipt, timeoutMs) {
  const state = async () => (await savedRows()).find((row) => row.id === id) || { id, name: id };
  if (receipt.via === 'agentapi') {
    // Sent through agentapi: the reply is Antigravity's message after ours, once the conversation is idle again.
    const viaFile = await fileMessages(id).catch(() => null);
    if (viaFile) {
      return waitForReply(async () => {
        const all = await fileMessages(id);
        const at = all.findLastIndex((m) => m.text === receipt.text.trim());
        const reply = at < 0 ? null : all.slice(at + 1).findLast((m) => m.role === 'antigravity');
        return reply && (await state()).status !== 'busy' ? { state: await state(), reply: reply.text } : null;
      }, { app: 'Antigravity', id, timeoutMs });
    }
  }
  return withPage(page, (p) => waitForReply(async () => {
    const result = await p.run(pageConversation, id, 'wait', receipt);
    if (!result.complete) return null;
    if (result.error) throw new Error(`Antigravity turn failed: ${result.error}`);
    if (!result.reply) throw new Error('Antigravity turn completed without a reply. Open the chat for details.');
    return { state: await state(), reply: result.reply };
  }, { app: 'Antigravity', id, timeoutMs }));
}

export async function open() {
  return (await launch('Antigravity', PORT))
    ? `Antigravity open; crosstalk can reach it on 127.0.0.1:${PORT}`
    : `Antigravity already reachable on 127.0.0.1:${PORT}`;
}
