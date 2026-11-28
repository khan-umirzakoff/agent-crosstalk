// The crosstalk daemon (`crosstalk daemon`, `crosstalk ui`): keeps every app's session list fresh in memory, keeps
// one Codex app-server open, rings sessions for Agent Mail, and serves the chat window and its API on 127.0.0.1.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import * as log from './log.js';
import * as mail from './mail.js';

export const DAEMON = join(log.DIR, 'daemon.json');
// How often each app's list is read again; Codex lists a thousand threads, so it goes slower.
const EVERY = { claude: 5000, antigravity: 5000, codex: 15000, opencode: 15000, hermes: 15000 };
const watchers = new Set(); // event streams to ping when a list changes

const UI = fileURLToPath(new URL('../ui/', import.meta.url)); // built from web/ (npm run build there)
const TYPES = { js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', svg: 'image/svg+xml' };
const YOU = { agent: 'user', id: null, name: 'you' };
const HEADERS = { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

// Where a running daemon listens, if one does.
export async function running() {
  try {
    const d = JSON.parse(readFileSync(DAEMON, 'utf8'));
    process.kill(d.pid, 0);
    const r = await fetch(`http://127.0.0.1:${d.port}/`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? { ...d, link: `http://127.0.0.1:${d.port}/#${d.token}` } : null;
  } catch {
    return null;
  }
}

// live: false serves the window without reading any app (tests).
export function serve(port, openBrowser, { live = true } = {}) {
  // Per-run token, handed over only in the URL fragment of the link this command prints.
  const token = randomBytes(24).toString('hex');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const cache = {};
  const busy = new Set();
  const refresh = async (name) => {
    if (busy.has(name)) return;
    busy.add(name);
    try {
      const rows = await Promise.resolve().then(() => core.APPS[name].list()).catch((e) => ({ error: e.message }));
      const changed = JSON.stringify(rows) !== JSON.stringify(cache[name]);
      cache[name] = rows;
      if (changed) for (const res of watchers) res.write('event: state\ndata: {}\n\n');
    } finally {
      busy.delete(name);
    }
  };
  const timers = [];
  const stop = new AbortController();
  if (live) {
    core.APPS.codex.keepServer?.();
    for (const name of core.APP_NAMES) {
      refresh(name);
      timers.push(setInterval(() => refresh(name), EVERY[name] || 10000));
    }
    mail.watch(core.ringMail, { intervalMs: 5000, signal: stop.signal, onError: (m, e) => console.error(`mail ${m.agent}: ${e.message}`) })
      .catch((e) => console.error(`mail: ${e.message}`));
  } else for (const name of core.APP_NAMES) cache[name] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { ...HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!hosts.has(req.headers.host)) return json(403, { error: 'bad host' }); // blocks DNS rebinding
    if (url.pathname === '/') {
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(join(UI, 'index.html')));
    }
    // Hashed build files: one plain name under assets/, never a path out of it.
    const asset = /^\/assets\/([\w.-]+\.(js|css|woff2|svg))$/.exec(url.pathname);
    if (asset) {
      try {
        const data = readFileSync(join(UI, 'assets', asset[1]));
        res.writeHead(200, { ...HEADERS, 'cache-control': 'public, max-age=31536000, immutable', 'content-type': TYPES[asset[2]] });
        return res.end(data);
      } catch {
        return json(404, { error: 'not found' });
      }
    }
    const given = req.headers['x-crosstalk-token'] || url.searchParams.get('token');
    if (given !== token) return json(401, { error: 'This room was restarted. Open the link that `crosstalk ui` printed.' });

    try {
      if (url.pathname === '/api/state') {
        await Promise.all(core.APP_NAMES.filter((name) => !(name in cache)).map(refresh)); // only before the first read
        const agents = Object.fromEntries(core.APP_NAMES.map((name) => [name, Array.isArray(cache[name]) ? core.tree(cache[name].map(({ prior, wake, ...r }) => r)) : cache[name] ?? { error: 'loading' }]));
        return json(200, { agents });
      }
      if (url.pathname === '/api/messages') {
        const agent = url.searchParams.get('agent');
        const id = url.searchParams.get('id');
        if (!core.APP_NAMES.includes(agent) || !id) return json(400, { error: 'agent and id required' });
        return json(200, await core.history(agent, id, { n: Math.min(Number(url.searchParams.get('n')) || 60, 5000) }));
      }
      if (url.pathname === '/api/send' && req.method === 'POST') {
        const { agent, target, text } = JSON.parse(await body(req));
        if (!core.APP_NAMES.includes(agent) || typeof text !== 'string' || !text.trim()) return json(400, { error: 'agent and text required' });
        const { to, delivery } = await core.send(agent, target || null, text.trim(), YOU);
        refresh(agent);
        return json(200, { to, delivery });
      }
      if (url.pathname === '/api/manage' && req.method === 'POST') {
        const { action, agent, target } = JSON.parse(await body(req));
        if (!['archive', 'unarchive', 'delete'].includes(action) || !core.APP_NAMES.includes(agent) || !target) return json(400, { error: 'action, agent and target required' });
        const row = await core.manage(action, agent, target, { actor: YOU });
        await refresh(agent);
        return json(200, { id: row.id, name: row.name });
      }
      if (url.pathname === '/events') return stream(req, res);
      json(404, { error: 'not found' });
    } catch (e) {
      json(500, { error: e.message });
    }
  });

  server.on('close', () => {
    for (const t of timers) clearInterval(t);
    stop.abort();
    core.APPS.codex.releaseServer?.();
  });

  return new Promise((ok, bad) => {
    server.on('error', bad);
    server.listen(port, '127.0.0.1', () => {
      const link = `http://127.0.0.1:${port}/#${token}`;
      mkdirSync(log.DIR, { recursive: true, mode: 0o700 });
      writeFileSync(DAEMON, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
      const bye = () => {
        try {
          if (JSON.parse(readFileSync(DAEMON, 'utf8')).pid === process.pid) rmSync(DAEMON);
        } catch {}
        process.exit(0);
      };
      process.once('SIGINT', bye);
      process.once('SIGTERM', bye);
      console.log(`crosstalk daemon: ${link}\n(Ctrl-C to stop; the link works until then)`);
      if (openBrowser) execFile('open', [link]);
      ok(server);
    });
  });
}

function body(req) {
  return new Promise((ok, bad) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) bad(new Error('message too large'));
    });
    req.on('end', () => ok(data));
  });
}

// Server-sent events: the last 500 messages first, then each new log line as it is written.
function stream(req, res) {
  res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream', connection: 'keep-alive' });
  let offset = 0;
  const tick = (backlog) => {
    const end = size();
    if (end < offset) offset = 0; // log was cleared
    if (end === offset) return;
    const fd = openSync(log.FILE, 'r');
    const buf = Buffer.alloc(end - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    const whole = buf.lastIndexOf(10) + 1; // only complete lines; the rest waits for the next tick
    offset += whole;
    const lines = buf.subarray(0, whole).toString('utf8').split('\n').filter(Boolean);
    for (const line of backlog === true ? lines.slice(-500) : lines) res.write(`data: ${line}\n\n`);
  };
  tick(true);
  watchers.add(res);
  const onChange = () => tick(false);
  watchFile(log.FILE, { interval: 500 }, onChange);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    watchers.delete(res);
    unwatchFile(log.FILE, onChange);
    clearInterval(ping);
  });
}

function size() {
  try {
    return statSync(log.FILE).size;
  } catch {
    return 0;
  }
}
