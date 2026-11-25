// Antigravity desktop: types into its chat and reads replies over a local CDP port.
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.js';
import { DIR } from './log.js';

export const PORT = Number(process.env.CROSSTALK_ANTIGRAVITY_PORT || 9000);
const INPUT = '[aria-label="Message input"]';
const LOCK = join(DIR, 'antigravity.lock');

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
export function resolve(rows, target) {
  if (/^[0-9a-f-]{36}$/.test(target)) return target;
  const t = target.toLowerCase();
  const exact = rows.filter((r) => r.name.toLowerCase() === t);
  const partial = exact.length ? exact : rows.filter((r) => r.name.toLowerCase().includes(t));
  if (partial.length === 1) return partial[0].id;
  if (!partial.length) throw new Error(`No Antigravity conversation matches "${target}". See: crosstalk list antigravity`);
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

// One crosstalk at a time drives the Antigravity window, so two senders cannot type into each other's conversation.
async function locked(fn) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(LOCK, 'wx'));
      break;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 60000) rmSync(LOCK, { force: true }); // left by a crashed run
      } catch {}
      if (i > 120) throw new Error('Antigravity is in use by another crosstalk command; try again.');
      await sleep(500);
    }
  }
  try {
    return await withPage(fn);
  } finally {
    rmSync(LOCK, { force: true });
  }
}

async function withPage(fn) {
  const p = await page();
  try {
    return await fn(p);
  } finally {
    p.close();
  }
}

export const list = () =>
  withPage(async (p) => {
    const [rows, now] = await Promise.all([p.run(pageList), p.run(pageState)]);
    // Only the conversation on screen has a known state.
    return rows.map((r) => (r.id === now.id ? { ...r, status: now.status, note: now.note } : r));
  });

export const status = (target) => locked((p) => select(p, target));

export const read = (target) =>
  locked(async (p) => {
    await select(p, target);
    return p.run(pageLastReply);
  });

// Returns the conversation the text went to.
export const send = (target, buildText) =>
  locked(async (p) => {
    const before = await select(p, target);
    if (before.status === 'waiting') throw new Error(`Antigravity "${before.name}" ${before.note}. Not sent: that is the user's call; tell the user instead.`);
    if (before.status === 'busy') throw new Error(`Antigravity is busy in "${before.name}". Try again when it is idle (crosstalk status antigravity).`);
    // The person's unsent draft goes aside while our message is sent, then comes back.
    const draft = before.draft ? await settledDraft(p, before.name) : '';
    const focus = () => p.run((sel, id) => {
      const still = (location.pathname.match(/\/c\/([0-9a-f-]{36})/)?.[1] || null) === id;
      const e = document.querySelector(sel);
      if (!still || !e) return false;
      e.focus();
      return true;
    }, INPUT, before.id);
    if (!(await focus())) throw new Error('The Antigravity window changed conversation; not sent.');
    if (draft) {
      await p.clear();
      await sleep(200);
      if (await p.run(pageDraft, INPUT)) throw new Error(`Could not set the draft in "${before.name}" aside; not sent.`);
    }
    let sent = null;
    try {
      await p.typeAndSubmit(buildText(before));
      for (let i = 0; i < 15 && !sent; i++) {
        await sleep(200);
        const s = await p.run(pageState);
        if (!s.draft || s.status !== 'idle') sent = s;
      }
    } finally {
      if (draft) await restoreDraft(p, focus, draft, before.name);
    }
    if (!sent) throw new Error('Text was typed but not submitted; press Enter in Antigravity.');
    return sent;
  });

const pageDraft = (sel) => document.querySelector(sel)?.innerText.trim() || '';

// Waits until the person has stopped typing for 2 s (up to a minute) and returns the draft.
async function settledDraft(p, name) {
  let last = await p.run(pageDraft, INPUT);
  for (let still = 0, i = 0; still < 4; i++) {
    if (i > 120) throw new Error(`The person is still typing in "${name}". Not sent; try again later.`);
    await sleep(500);
    const now = await p.run(pageDraft, INPUT);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
}

async function restoreDraft(p, focus, draft, name) {
  await sleep(300);
  if ((await focus()) && !(await p.run(pageDraft, INPUT))) await p.type(draft);
  await sleep(200);
  if ((await p.run(pageDraft, INPUT)) !== draft) {
    throw new Error(`Could not put the draft back in "${name}". Here it is so nothing is lost:\n${draft}`);
  }
}

// Quits Antigravity and reopens it with the debug port bound to 127.0.0.1.
export async function open() {
  const up = () => fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (await up()) return `Antigravity already reachable on 127.0.0.1:${PORT}`;
  const running = () => {
    try {
      execFileSync('pgrep', ['-xq', 'Antigravity']);
      return true;
    } catch {
      return false;
    }
  };
  if (running()) {
    execFileSync('osascript', ['-e', 'quit app "Antigravity"']);
    for (let i = 0; running(); i++) {
      if (i > 30) throw new Error('Antigravity did not quit (an unsaved-changes dialog?).');
      await sleep(1000);
    }
  }
  // `open` passes our environment on; drop the caller's agent identity so Antigravity's shells don't inherit it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|ANTHROPIC|AI_AGENT)/.test(k)));
  execFileSync('open', ['-a', 'Antigravity', '--args', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1'], { env });
  for (let i = 0; !(await up()); i++) {
    if (i > 30) throw new Error(`Antigravity started but its debug port ${PORT} did not open.`);
    await sleep(1000);
  }
  return `Antigravity open; crosstalk can reach it on 127.0.0.1:${PORT}`;
}
