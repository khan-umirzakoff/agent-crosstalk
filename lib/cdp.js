// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.

export async function connect(port, pick) {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  } catch {
    throw new Error(`not reachable on 127.0.0.1:${port}`);
  }
  const page = targets.find(pick);
  if (!page) throw new Error('app window not found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  // If the app quits mid-call, every waiting call fails instead of hanging.
  ws.onclose = () => {
    for (const done of pending.values()) done({ error: { message: 'connection to the app closed' } });
    pending.clear();
  };
  await new Promise((ok, bad) => {
    ws.onopen = ok;
    ws.onerror = () => bad(new Error('CDP connection failed'));
  });

  const send = (method, params = {}) =>
    new Promise((ok) => {
      const id = ++seq;
      const timer = setTimeout(() => pending.get(id)?.({ error: { message: `${method} timed out` } }), 15000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        pending.delete(id);
        ok(m);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const check = (r) => {
    if (r.error) throw new Error(r.error.message);
    return r;
  };

  // Runs fn inside the page with JSON-serializable args and returns its JSON result.
  async function run(fn, ...args) {
    const r = check(await send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(args)})`,
      returnByValue: true,
      awaitPromise: true,
    }));
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page error');
    return r.result.result.value;
  }

  async function typeAndSubmit(text) {
    check(await send('Input.insertText', { text }));
    await sleep(200);
    check(await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }));
    check(await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }));
  }

  return { run, typeAndSubmit, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
