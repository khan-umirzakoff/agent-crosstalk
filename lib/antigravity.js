// Antigravity conversations, from the desktop app and from the agy command line.
// Desktop: the running app's language server (list, read, send, wait, start, delete), the calls its own window makes.
// Command line: each agy conversation's file to read, and `agy --conversation` to continue it.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sleep } from './cdp.js';

const DATABASE = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GEMINI = join(homedir(), '.gemini');
const STORES = [join(GEMINI, 'antigravity', 'conversations'), join(GEMINI, 'antigravity-cli', 'conversations')];
const AGY = existsSync(join(homedir(), '.local', 'bin', 'agy')) ? join(homedir(), '.local', 'bin', 'agy') : 'agy';

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
async function rpc(method, body, timeoutMs = 20000) {
  const hub = liveHub();
  const r = await fetch(`http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-codeium-csrf-token': hub.csrfToken },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Antigravity: ${out.message || r.status}`);
  return out;
}

const appRunning = () => {
  try {
    return !!liveHub();
  } catch {
    return false;
  }
};

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

// Live state of the app's conversations: status, last activity, parent, folder.
async function liveRows() {
  const { trajectorySummaries: all = {} } = await rpc('GetAllCascadeTrajectories', {});
  return new Map(Object.entries(all).map(([id, t]) => {
    const folder = t.workspaces?.[0]?.workspaceFolderAbsoluteUri;
    return [id, {
      id, surface: 'desktop', status: /RUNNING|BUSY|CANCELING/.test(t.status) ? 'busy' : 'idle',
      last: Date.parse(t.lastModifiedTime) || null, used: Date.parse(t.lastUserInputTime) || 0,
      parent: t.trajectoryMetadata?.parentConversationId || null,
      ...(folder?.startsWith('file://') ? { cwd: fileURLToPath(folder), project: basename(fileURLToPath(folder)) } : {}),
    }];
  }));
}

async function rows() {
  const [saved, live] = await Promise.all([savedRows(), appRunning() ? liveRows().catch(() => new Map()) : new Map()]);
  const all = new Map(saved.map((row) => [row.id, row]));
  for (const [id, row] of live) all.set(id, { name: id, ...all.get(id), ...row, kind: all.get(id)?.kind || (row.parent ? 'sub' : null) });
  return [...all.values()];
}
export const list = rows;

// "current" is the desktop conversation the person wrote in last.
async function row(target) {
  const all = await rows();
  if (!target || target === 'current') {
    const last = all.filter((r) => r.surface === 'desktop').sort((a, b) => (b.used || 0) - (a.used || 0))[0];
    if (!last) throw new Error('No Antigravity conversation yet.');
    return last;
  }
  const id = resolve(all, target);
  return all.find((r) => r.id === id) || { id, name: id, surface: existsSync(join(STORES[1], `${id}.db`)) ? 'cli' : 'desktop' };
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

const steps = async (id) => (await rpc('GetCascadeTrajectorySteps', { cascadeId: id }, 60000)).steps || [];

export async function status(target) {
  const r = await row(target);
  // An approval or question the person must answer shows as a waiting step.
  const waiting = r.status === 'busy' && r.surface === 'desktop' && (await steps(r.id).catch(() => [])).some((s) => s.status === 'CORTEX_STEP_STATUS_WAITING');
  return waiting ? { ...r, status: 'waiting', note: 'has a pending question or approval in Antigravity' } : r;
}

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

// A step as a chat message: the person's input, Antigravity's reply, or a message another agent sent.
function stepMessage(s) {
  const ts = s.metadata?.createdAt;
  const one = (role, text, from) => (text?.trim() ? [{ role, text: text.trim(), ts, ...(from ? { from } : {}) }] : []);
  if (s.userInput) return one('user', s.userInput.items?.map((i) => i.text || '').join('') || s.userInput.userResponse);
  if (s.plannerResponse) return one('antigravity', s.plannerResponse.modifiedResponse || s.plannerResponse.response);
  if (s.systemMessage?.agentMessage) {
    const m = s.systemMessage.agentMessage;
    return one('peer', m.content ?? m.text ?? m.message, m.sender ?? m.senderName);
  }
  return [];
}

export async function messages(target) {
  const r = await row(target);
  const live = r.surface === 'desktop' && appRunning() ? await steps(r.id).then((all) => all.flatMap(stepMessage)).catch(() => null) : null;
  return { id: r.id, name: r.name, messages: live ?? (await fileMessages(r.id)) ?? [] };
}

// Deletes a desktop conversation the way the app's own delete does. agy conversations live outside the app.
export async function remove(target, { force = false } = {}) {
  const r = await row(target);
  if (r.surface === 'cli') throw new Error(`"${r.name}" is an agy (terminal) conversation; crosstalk can delete only desktop conversations.`);
  if (!force && r.status !== 'idle') throw new Error(`Antigravity "${r.name}" is ${r.status}. Add --force to delete it anyway.`);
  await rpc('DeleteCascadeTrajectory', { cascadeId: r.id });
  return r;
}

// A new agy (terminal) conversation in cwd; its id arrives with the answer.
export const startCli = (text, cwd) => ({ id: null, name: 'new agy conversation', surface: 'cli', run: agyRun(['-p', text], cwd), delivery: 'submitted' });

// A command-line conversation continues in a headless `agy` run, which crosstalk starts and follows (core.startRun).
const agyRun = (args, cwd) => ({ kind: 'agy', cmd: AGY, args: [...args, '--output-format', 'json'], cwd: cwd && existsSync(cwd) ? cwd : homedir() });
const sendCli = (row, text) => ({ ...row, run: agyRun(['--conversation', row.id, '-p', text], row.cwd), delivery: 'submitted' });

// The model settings to send with: the conversation's own, else those of the conversation used last.
async function plannerConfig(id) {
  const recent = (await rows()).filter((r) => r.surface === 'desktop' && r.id !== id).sort((a, b) => (b.used || 0) - (a.used || 0)).slice(0, 5);
  for (const cascadeId of [id, ...recent.map((r) => r.id)]) {
    const meta = await rpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId }).catch(() => null);
    const config = meta?.generatorMetadata?.findLast?.((g) => g.plannerConfig?.planModel)?.plannerConfig;
    if (config) return { planModel: config.planModel, plannerTypeConfig: config.plannerTypeConfig, planExecuteConfig: config.planExecuteConfig };
  }
  throw new Error('No Antigravity model setting found. Send one message in the app first.');
}

async function sendDesktop(r, text) {
  const receipt = { id: randomUUID() };
  await rpc('SendUserCascadeMessage', { cascadeId: r.id, clientMessageId: receipt.id, items: [{ text }], cascadeConfig: { plannerConfig: await plannerConfig(r.id) } });
  return { ...r, receipt, delivery: r.status === 'busy' ? 'queued' : undefined };
}

export async function send(target, buildText) {
  if (target === 'new') {
    liveHub();
    const { cascadeId } = await rpc('StartCascade', { source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', workspaceUris: [pathToFileURL(process.cwd()).href] });
    const r = { id: cascadeId, name: 'new conversation', surface: 'desktop', status: 'idle' };
    return sendDesktop(r, buildText(r));
  }
  const r = await row(target);
  if (r.surface === 'cli') return sendCli(r, buildText(r));
  liveHub();
  return sendDesktop(r, buildText(r));
}

// Waits until the turn our message started is over, then returns Antigravity's last reply in it.
export async function waitReply(id, receipt, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await rpc('WaitForConversationFullyIdle', { conversationId: id }, Math.max(1000, end - Date.now())).catch(() => {});
    const all = await steps(id);
    const at = all.findIndex((s) => s.userInput?.clientMessageId === receipt.id);
    if (at >= 0) {
      const rest = all.slice(at + 1);
      const next = rest.findIndex((s) => s.userInput);
      const turn = next < 0 ? rest : rest.slice(0, next);
      const r = await row(id);
      if (next >= 0 || r.status === 'idle') {
        const error = turn.findLast((s) => s.errorMessage)?.errorMessage?.error;
        const reply = turn.flatMap(stepMessage).findLast((m) => m.role === 'antigravity')?.text;
        if (reply) return { state: r, reply };
        throw new Error(`Antigravity turn ended without a reply${error ? `: ${error.userErrorMessage || error.shortError}` : ''}. Open the chat for details.`);
      }
    }
    await sleep(2000);
  }
  throw new Error(`Antigravity has no reply after ${Math.round(timeoutMs / 1000)} s. Check the conversation ${id}.`);
}

export async function open() {
  return 'Antigravity needs no restart: crosstalk talks to the running app directly.';
}
