// Antigravity Desktop conversations and its running language-server client.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { connect, sleep } from './cdp.js';
import { deliver, launch, locked, waitForReply, withPage } from './desktop.js';

export const PORT = Number(process.env.CROSSTALK_ANTIGRAVITY_PORT || 9000);
const INPUT = '[aria-label="Message input"]';
const DATABASE = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
      return db.prepare(`SELECT conversation_id AS id, title AS name, status,
        CASE WHEN json_valid(workspace_uris) THEN json_extract(workspace_uris, '$[0]') END AS workspace
        FROM conversation_summaries WHERE killed = 0 ORDER BY last_modified_time DESC`).all()
        .filter((row) => UUID.test(row.id))
        .map((row) => ({ id: row.id, name: row.name || row.id, project: basename(row.workspace || ''), status: /RUNNING|BUSY|CANCELING/.test(row.status) ? 'busy' : 'idle' }));
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
  return [...all.values()];
}

async function resolveTarget(p, target) {
  if (!target || target === 'current') return p.run(pageState);
  const all = await rows(p);
  const id = resolve(all, target);
  return all.find((row) => row.id === id) || { id, name: id };
}

export const list = () => withPage(page, rows);

export const status = (target) => withPage(page, async (p) => {
  const state = await resolveTarget(p, target);
  if (!state.id) return state;
  const { status } = await p.run(pageConversation, state.id, 'status');
  return { ...state, status, note: status === 'waiting' ? 'has a pending question or approval in Antigravity' : null };
});

// The user's and Antigravity's messages, oldest first; tool steps are left out.
export const messages = (target) => withPage(page, async (p) => {
  const { id, name } = await resolveTarget(p, target);
  return { id, name, messages: id ? await p.run(pageConversation, id, 'messages') : [] };
});

export const send = (target, buildText) => drive(async (p) => {
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

export const waitReply = (id, receipt, timeoutMs) => withPage(page, (p) => waitForReply(async () => {
  const result = await p.run(pageConversation, id, 'wait', receipt);
  if (!result.complete) return null;
  if (result.error) throw new Error(`Antigravity turn failed: ${result.error}`);
  if (!result.reply) throw new Error('Antigravity turn completed without a reply. Open the chat for details.');
  const state = (await savedRows()).find((row) => row.id === id) || { id, name: id };
  return { state, reply: result.reply };
}, { app: 'Antigravity', id, timeoutMs }));

export async function open() {
  return (await launch('Antigravity', PORT))
    ? `Antigravity open; crosstalk can reach it on 127.0.0.1:${PORT}`
    : `Antigravity already reachable on 127.0.0.1:${PORT}`;
}
