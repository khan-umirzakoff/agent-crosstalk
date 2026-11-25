// Codex desktop (the Codex mode of the ChatGPT app): types into a Codex thread and reads replies over CDP.
import { connect, sleep } from './cdp.js';
import { resolve } from './antigravity.js';
import { deliver, launch, locked, waitForReply, withPage } from './desktop.js';

export const PORT = Number(process.env.CROSSTALK_CODEX_PORT || 9001);
const INPUT = '[data-codex-composer]';
const ROW = '[data-app-action-sidebar-thread-row]';

async function page() {
  try {
    return await connect(PORT, (t) => t.type === 'page' && t.url.startsWith('app://-/index'));
  } catch (e) {
    throw new Error(`Codex ${e.message}. Start it with: crosstalk open codex`);
  }
}

// Page-side functions: they run inside the ChatGPT app, so they only use the DOM.
const pageList = () => {
  const seen = new Set();
  return [...document.querySelectorAll('[data-app-action-sidebar-thread-row]')].flatMap((r) => {
    const raw = r.dataset.appActionSidebarThreadId || '';
    if (r.dataset.appActionSidebarThreadKind !== 'local' || !/^local:[0-9a-f-]{36}$/.test(raw)) return []; // Codex threads only
    const id = raw.slice(6);
    if (seen.has(id)) return []; // a thread shows both in its project and in Recents
    seen.add(id);
    let project = '';
    for (let e = r.parentElement, i = 0; e && i < 12; e = e.parentElement, i++) {
      const head = e.querySelector(':scope > * [data-app-action-sidebar-project-row], :scope > [data-app-action-sidebar-project-row]');
      if (head) {
        project = head.dataset.appActionSidebarProjectLabel;
        break;
      }
    }
    return [{ id, name: r.dataset.appActionSidebarThreadTitle || r.querySelector('[data-thread-title]')?.textContent.trim() || id, project, open: r.dataset.appActionSidebarThreadActive === 'true' }];
  });
};
const pageState = () => {
  const transcript = [...document.querySelectorAll('[data-rail-chat-transcript]')].find((t) => t.offsetParent);
  const active = document.querySelector('[data-app-action-sidebar-thread-active=true]')?.dataset.appActionSidebarThreadId || '';
  const id = transcript?.querySelector('[data-response-update-thread]')?.dataset.responseUpdateThread || active.match(/^local:([0-9a-f-]{36})$/)?.[1] || null;
  const controls = [...(document.querySelector('[data-composer-trailing-controls]')?.querySelectorAll('button') || [])];
  const busy = controls.some((b) => /^stop\b/i.test((b.getAttribute('aria-label') || '').trim()));
  const ask = transcript && [...transcript.querySelectorAll('button')].find((b) => b.offsetParent &&
    /^(approve|allow|deny|reject|accept|always allow|allow once|run command)\b/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
  const status = ask ? 'waiting' : busy ? 'busy' : 'idle';
  const note = ask ? `needs the user's approval ("${(ask.getAttribute('aria-label') || ask.innerText).trim().slice(0, 40)}")` : null;
  const draft = document.querySelector('[data-codex-composer]')?.innerText.trim() || '';
  const codexMode = /current mode: codex/i.test(document.querySelector('button[aria-label^="Switch mode"]')?.getAttribute('aria-label') || '');
  return { id, name: id ? document.title : 'new Codex thread', status, note, draft: !!draft, codexMode };
};
const pageLastReply = () => {
  const t = [...document.querySelectorAll('[data-rail-chat-transcript]')].find((x) => x.offsetParent);
  return [...(t?.querySelectorAll('[data-markdown-text-style=assistant-message]') || [])].pop()?.innerText.trim() || '';
};
const mark = (sel, text) => {
  const e = [...document.querySelectorAll(sel)].find((x) => x.offsetParent && (!text || x.innerText.trim() === text));
  e?.setAttribute('data-crosstalk-click', '');
  return !!e;
};
const unmark = () => document.querySelectorAll('[data-crosstalk-click]').forEach((e) => e.removeAttribute('data-crosstalk-click'));

async function click(p, sel, text) {
  await p.run(unmark);
  if (!(await p.run(mark, sel, text))) return false;
  return p.clickOn('[data-crosstalk-click]');
}

// The ChatGPT app has a ChatGPT mode and a Codex mode; Codex threads only run in Codex mode.
async function codexMode(p) {
  if ((await p.run(pageState)).codexMode) return;
  if (!(await click(p, 'button[aria-label^="Switch mode"]'))) throw new Error('Could not find the ChatGPT/Codex mode switch.');
  await sleep(400);
  if (!(await click(p, '[role=menuitem]', 'Codex'))) throw new Error('Could not switch the ChatGPT app to Codex mode.');
  for (let i = 0; i < 20 && !(await p.run(pageState)).codexMode; i++) await sleep(250);
}

async function waitFor(p, test, what) {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const s = await p.run(pageState).catch(() => null);
    if (s && test(s) && (await p.run((sel) => !!document.querySelector(sel), INPUT))) return s;
  }
  throw new Error(`${what} did not open.`);
}

// target: thread id, its exact title, a unique part of its title, "current" or "new".
async function select(p, target) {
  await codexMode(p);
  const now = await p.run(pageState);
  if (!target || target === 'current') return now;
  if (target === 'new') {
    if (!(await click(p, 'button', 'New chat'))) throw new Error('Codex "New chat" button not found.');
    return waitFor(p, (s) => s.id === null, 'New Codex thread');
  }
  const id = resolve(await p.run(pageList), target, 'Codex');
  if (id === now.id) return now;
  if (!(await click(p, `${ROW}[data-app-action-sidebar-thread-id="local:${id}"] [data-thread-title-trigger]`))) {
    throw new Error(`Codex thread ${id} is not in the sidebar (it may be under "Show more"); open it once in Codex.`);
  }
  return waitFor(p, (s) => s.id === id, 'Codex thread');
}

const drive = (fn) => locked('codex', page, fn);

export const list = () =>
  withPage(page, async (p) => {
    const [rows, now] = await Promise.all([p.run(pageList), p.run(pageState)]);
    return rows.map((r) => (r.id === now.id ? { ...r, status: now.status, note: now.note } : r));
  });

export const status = (target) => drive((p) => select(p, target));

export const read = (target) =>
  drive(async (p) => {
    await select(p, target);
    return p.run(pageLastReply);
  });

// Returns the thread the text went to; a new thread gets its id once Codex starts answering.
export const send = (target, buildText) =>
  drive(async (p) => {
    const before = await select(p, target);
    if (before.status === 'waiting') throw new Error(`Codex "${before.name}" ${before.note}. Not sent: that is the user's call; tell the user instead.`);
    if (before.status === 'busy') throw new Error(`Codex is busy in "${before.name}". Try again when it is idle (crosstalk status codex).`);
    const previous = await p.run(pageLastReply);
    let s = await deliver(p, { input: INPUT, pageState, before, text: buildText(before), app: 'Codex' });
    for (let i = 0; i < 40 && !s.id; i++) {
      await sleep(250);
      s = await p.run(pageState);
    }
    return { ...s, previous };
  });

export const waitReply = (id, previous, timeoutMs) =>
  withPage(page, (p) => waitForReply(p, { id, previous, pageState, pageLastReply, app: 'Codex', timeoutMs }));

export async function open() {
  const restarted = await launch('ChatGPT', PORT);
  await withPage(page, async (p) => {
    for (let i = 0; i < 40 && !(await p.run(() => !!document.querySelector('button[aria-label^="Switch mode"]'))); i++) await sleep(250);
    await codexMode(p);
  });
  return `Codex ${restarted ? 'open' : 'already reachable'} on 127.0.0.1:${PORT}, in Codex mode`;
}
