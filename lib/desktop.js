// Shared plumbing for desktop agent apps driven over CDP: one driver at a time, the person's
// draft kept, and launching the app with a local debug port.
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './cdp.js';
import { DIR } from './log.js';

// One crosstalk at a time drives an app window, so two senders cannot type into each other's chat.
export async function locked(name, openPage, fn) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const lock = join(DIR, `${name}.lock`);
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60000) rmSync(lock, { force: true }); // left by a crashed run
      } catch {}
      if (i > 120) throw new Error(`${name} is in use by another crosstalk command; try again.`);
      await sleep(500);
    }
  }
  try {
    return await withPage(openPage, fn);
  } finally {
    rmSync(lock, { force: true });
  }
}

export async function withPage(openPage, fn) {
  const p = await openPage();
  try {
    return await fn(p);
  } finally {
    p.close();
  }
}

const pageText = (sel) => document.querySelector(sel)?.innerText.trim() || '';

// Types text into the chat input and submits it. An unsent draft is set aside once the person has
// stopped typing for 2 s, and put back afterwards. pageState must return { id, status, draft }.
export async function deliver(p, { input, pageState, before, text, app }) {
  const draft = before.draft ? await settledDraft(p, input, before.name) : '';
  const focus = () => p.run((sel) => {
    const e = document.querySelector(sel);
    e?.focus();
    return !!e;
  }, input);
  if (before.id && (await p.run(pageState)).id !== before.id) throw new Error(`The ${app} window changed conversation; not sent.`);
  if (!(await focus())) throw new Error(`${app} chat input not found.`);
  if (draft) {
    await p.clear();
    await sleep(200);
    if (await p.run(pageText, input)) throw new Error(`Could not set the draft in "${before.name}" aside; not sent.`);
  }
  let sent = null;
  try {
    await p.typeAndSubmit(text);
    for (let i = 0; i < 15 && !sent; i++) {
      await sleep(200);
      const s = await p.run(pageState);
      if (!s.draft || s.status !== 'idle') sent = s;
    }
  } finally {
    if (draft) {
      await sleep(300);
      if ((await focus()) && !(await p.run(pageText, input))) await p.type(draft);
      await sleep(200);
      if ((await p.run(pageText, input)) !== draft) throw new Error(`Could not put the draft back in "${before.name}". Here it is so nothing is lost:\n${draft}`);
    }
  }
  if (!sent) throw new Error(`Text was typed but not submitted; press Enter in ${app}.`);
  return sent;
}

// The adapter returns a reply only after finding the turn for this send.
export async function waitForReply(getReply, { id, app, timeoutMs, intervalMs = 3000 }) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await getReply();
    if (result) return result;
    await sleep(Math.min(intervalMs, Math.max(0, end - Date.now())));
  }
  throw new Error(`${app} has no confirmed reply to this message after ${Math.round(timeoutMs / 1000)} s. Check the conversation ${id}.`);
}

// Waits until the person has stopped typing for 2 s (up to a minute) and returns the draft.
async function settledDraft(p, input, name) {
  let last = await p.run(pageText, input);
  for (let still = 0, i = 0; still < 4; i++) {
    if (i > 120) throw new Error(`The person is still typing in "${name}". Not sent; try again later.`);
    await sleep(500);
    const now = await p.run(pageText, input);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
}

// Quits the app and reopens it with its debug port bound to 127.0.0.1.
export async function launch(app, port) {
  const up = () => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (await up()) return false;
  const running = () => {
    try {
      execFileSync('pgrep', ['-xq', app]);
      return true;
    } catch {
      return false;
    }
  };
  if (running()) {
    execFileSync('osascript', ['-e', `quit app "${app}"`]);
    for (let i = 0; running(); i++) {
      if (i > 30) throw new Error(`${app} did not quit (an unsaved-changes dialog?).`);
      await sleep(1000);
    }
  }
  // `open` passes our environment on; drop the caller's agent identity so the app's shells don't inherit it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX_|ANTHROPIC|AI_AGENT)/.test(k)));
  execFileSync('open', ['-a', app, '--args', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env });
  for (let i = 0; !(await up()); i++) {
    if (i > 30) throw new Error(`${app} started but its debug port ${port} did not open.`);
    await sleep(1000);
  }
  return true;
}
