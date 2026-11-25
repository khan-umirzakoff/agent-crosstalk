// Antigravity desktop: types into its chat and reads replies over a local CDP port.
import { connect, sleep } from './cdp.js';
import { deliver, launch, locked, withPage } from './desktop.js';

export const PORT = Number(process.env.CROSSTALK_ANTIGRAVITY_PORT || 9000);
const INPUT = '[aria-label="Message input"]';

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
const pageClick = (id) => {
  const row = document.querySelector(`[data-cascade-id="${id}"]`);
  if (row) (row.querySelector('a[href]') || row).click(); // the router listens on the row's link
  else location.href = `/c/${id}`;
};
const pageHasInput = (sel) => !!document.querySelector(sel);
const pageLastReply = () => [...document.querySelectorAll('[data-testid=agent-response]')].pop()?.innerText.trim() || '';

// target: conversation id, its exact title, a unique part of its title, "current" or "new".
export function resolve(rows, target, app = 'Antigravity') {
  if (/^[0-9a-f-]{36}$/.test(target)) return target;
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

// Shows the target conversation. Antigravity keeps each conversation's draft, so switching loses nothing.
async function select(p, target) {
  const now = await p.run(pageState);
  if (!target || target === 'current') return now;
  const id = target === 'new' ? null : resolve(await p.run(pageList), target);
  if (id && id === now.id) return now;
  if (!id) {
    const clicked = await p.run(() => {
      const b = document.querySelector('[data-testid=new-conversation-button]');
      b?.click();
      return !!b;
    });
    if (!clicked) throw new Error('New conversation button not found.');
    return waitFor(p, (s) => s.id === null, 'New conversation');
  }
  await p.run(pageClick, id);
  return waitFor(p, (s) => s.id === id, 'Conversation');
}

const drive = (fn) => locked('antigravity', page, fn);

export const list = () =>
  withPage(page, async (p) => {
    const [rows, now] = await Promise.all([p.run(pageList), p.run(pageState)]);
    // Only the conversation on screen has a known state.
    return rows.map((r) => (r.id === now.id ? { ...r, status: now.status, note: now.note } : r));
  });

export const status = (target) => drive((p) => select(p, target));

export const read = (target) =>
  drive(async (p) => {
    await select(p, target);
    return p.run(pageLastReply);
  });

// Returns the conversation the text went to.
export const send = (target, buildText) =>
  drive(async (p) => {
    const before = await select(p, target);
    if (before.status === 'waiting') throw new Error(`Antigravity "${before.name}" ${before.note}. Not sent: that is the user's call; tell the user instead.`);
    if (before.status === 'busy') throw new Error(`Antigravity is busy in "${before.name}". Try again when it is idle (crosstalk status antigravity).`);
    return deliver(p, { input: INPUT, pageState, before, text: buildText(before), app: 'Antigravity' });
  });

export async function open() {
  return (await launch('Antigravity', PORT))
    ? `Antigravity open; crosstalk can reach it on 127.0.0.1:${PORT}`
    : `Antigravity already reachable on 127.0.0.1:${PORT}`;
}
