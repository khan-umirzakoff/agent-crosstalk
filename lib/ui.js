// `crosstalk ui`: a local chat room. Shows every crosstalk message and lets the person send one.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import * as log from './log.js';

const PAGE = fileURLToPath(new URL('../ui/index.html', import.meta.url));
const YOU = { agent: 'user', id: null, name: 'you' };
const HEADERS = { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

export function serve(port, openBrowser) {
  // Per-run token, handed over only in the URL fragment of the link this command prints.
  const token = randomBytes(24).toString('hex');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { ...HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!hosts.has(req.headers.host)) return json(403, { error: 'bad host' }); // blocks DNS rebinding
    if (url.pathname === '/') {
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(PAGE));
    }
    const given = req.headers['x-crosstalk-token'] || url.searchParams.get('token');
    if (given !== token) return json(401, { error: 'This room was restarted. Open the link that `crosstalk ui` printed.' });

    try {
      if (url.pathname === '/api/state') {
        const agents = await core.list();
        for (const [agent, rows] of Object.entries(agents)) if (Array.isArray(rows)) agents[agent] = core.tree(rows.map(({ prior, ...r }) => r));
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
        return json(200, { to, delivery });
      }
      if (url.pathname === '/api/manage' && req.method === 'POST') {
        const { action, agent, target } = JSON.parse(await body(req));
        if (!['archive', 'unarchive', 'delete'].includes(action) || !core.APP_NAMES.includes(agent) || !target) return json(400, { error: 'action, agent and target required' });
        const row = await core.manage(action, agent, target, { actor: YOU });
        return json(200, { id: row.id, name: row.name });
      }
      if (url.pathname === '/events') return stream(req, res);
      json(404, { error: 'not found' });
    } catch (e) {
      json(500, { error: e.message });
    }
  });

  return new Promise((ok, bad) => {
    server.on('error', bad);
    server.listen(port, '127.0.0.1', () => {
      const link = `http://127.0.0.1:${port}/#${token}`;
      console.log(`crosstalk room: ${link}\n(Ctrl-C to stop; the link works until then)`);
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
  const onChange = () => tick(false);
  watchFile(log.FILE, { interval: 500 }, onChange);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
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
