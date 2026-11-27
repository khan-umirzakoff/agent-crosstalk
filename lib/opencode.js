// OpenCode sessions: listed from OpenCode's own session database (read-only), read with `opencode export`,
// continued and started with `opencode run`, deleted with `opencode session delete`.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolve } from './antigravity.js';

const DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
// shortcut: CROSSTALK_OPENCODE_MODEL overrides OpenCode's own default model for runs crosstalk starts.
const model = () => (process.env.CROSSTALK_OPENCODE_MODEL ? ['-m', process.env.CROSSTALK_OPENCODE_MODEL] : []);

export async function list() {
  if (!existsSync(DB)) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare('SELECT id, title, directory, parent_id, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC').all()
      .map((s) => ({
        id: s.id, name: s.title || s.id, cwd: s.directory, project: basename(s.directory || ''), last: Number(s.time_updated) || null,
        parent: s.parent_id || null, kind: s.parent_id ? 'sub' : null, surface: 'cli', status: 'idle',
      }));
  } finally {
    db.close();
  }
}

async function row(target) {
  const all = await list();
  const id = target?.startsWith('ses_') ? target : resolve(all, target, 'OpenCode');
  return all.find((s) => s.id === id) || { id, name: id, surface: 'cli', status: 'idle' };
}
export const status = row;

// `opencode export` cuts long output short on a pipe, so it writes to a file.
export async function messages(target) {
  const s = await row(target);
  const dir = mkdtempSync(join(tmpdir(), 'crosstalk-oc-'));
  try {
    const fd = openSync(join(dir, 'session.json'), 'w');
    try {
      execFileSync('opencode', ['export', s.id], { cwd: s.cwd && existsSync(s.cwd) ? s.cwd : homedir(), stdio: ['ignore', fd, 'ignore'], timeout: 60000 });
    } finally {
      closeSync(fd);
    }
    const data = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    return {
      id: s.id, name: s.name,
      messages: (data.messages || []).flatMap((m) => {
        const text = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
        return text ? [{ role: m.info?.role === 'user' ? 'user' : 'opencode', text, ts: m.info?.time?.created }] : [];
      }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs are started and followed by crosstalk's follower (core.startRun, kind opencode).
const run = (args, cwd) => ({ kind: 'opencode', cmd: 'opencode', args: ['run', ...model(), '--format', 'json', ...args], cwd: cwd && existsSync(cwd) ? cwd : homedir() });
export async function send(target, buildText) {
  if (target === 'new') return startCli(buildText({ surface: 'cli' }), process.cwd());
  const s = await row(target);
  return { ...s, run: run(['-s', s.id, buildText(s)], s.cwd), delivery: 'submitted' };
}
export const startCli = (text, cwd) => ({ id: null, name: 'new opencode session', surface: 'cli', run: run([text], cwd), delivery: 'submitted' });

export async function remove(target) {
  const s = await row(target);
  execFileSync('opencode', ['session', 'delete', s.id], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return s;
}

// The answer of an `opencode run --format json`: the text of its first step, and the session it ran in.
export function runReply(output) {
  const events = output.split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const end = events.findIndex((e) => e.type === 'step_finish');
  const text = events.slice(0, end < 0 ? undefined : end).filter((e) => e.type === 'text').map((e) => e.part?.text || '').join('\n').trim();
  const error = events.find((e) => e.type === 'error');
  return { reply: text, id: events.find((e) => e.sessionID)?.sessionID || null, error: error ? JSON.stringify(error.error?.data?.message ?? error.error ?? error).slice(0, 300) : null };
}
