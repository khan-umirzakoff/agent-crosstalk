// Hermes sessions: listed and read from Hermes's session store (read-only),
// continued and started with `hermes chat -Q`, deleted with `hermes sessions delete`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolve } from './antigravity.js';

const DB = join(homedir(), '.hermes', 'state.db');

export async function list() {
  if (!existsSync(DB)) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare('SELECT id, title, cwd, source, parent_session_id, last_activity_at, started_at FROM sessions WHERE archived = 0 AND hidden = 0 ORDER BY last_activity_at DESC').all()
      .map((s) => ({
        id: s.id, name: s.title || s.id, cwd: s.cwd || null, project: basename(s.cwd || ''),
        last: Math.round(Number(s.last_activity_at || s.started_at) * 1000) || null,
        parent: s.parent_session_id || null, kind: s.parent_session_id ? 'sub' : null,
        surface: s.source === 'desktop' ? 'desktop' : 'cli', status: 'idle',
      }));
  } finally {
    db.close();
  }
}

async function row(target) {
  const all = await list();
  const id = all.some((s) => s.id === target) ? target : resolve(all, target, 'Hermes');
  return all.find((s) => s.id === id) || { id, name: id, surface: 'cli', status: 'idle' };
}
export const status = row;

// Read from the session store: `hermes sessions export` refuses very long sessions.
export async function messages(target) {
  const s = await row(target);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const list = db.prepare("SELECT role, content, timestamp FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY id").all(s.id)
      .flatMap((m) => (String(m.content || '').trim()
        ? [{ role: m.role === 'user' ? 'user' : 'hermes', text: String(m.content).trim(), ts: m.timestamp ? Math.round(Number(m.timestamp) * 1000) : undefined }] : []));
    return { id: s.id, name: s.name, messages: list };
  } finally {
    db.close();
  }
}

// Runs are started and followed by crosstalk's follower (core.startRun, kind hermes); -Q prints only the answer.
const run = (args, cwd) => ({ kind: 'hermes', cmd: 'hermes', args: ['chat', '-Q', ...args], cwd: cwd && existsSync(cwd) ? cwd : homedir() });
export async function send(target, buildText) {
  if (target === 'new') return startCli(buildText({ surface: 'cli' }), process.cwd());
  const s = await row(target);
  return { ...s, run: run(['-q', buildText(s), '--resume', s.id], s.cwd), delivery: 'submitted' };
}
export const startCli = (text, cwd) => ({ id: null, name: 'new hermes session', surface: 'cli', run: run(['-q', text], cwd), delivery: 'submitted' });

export async function remove(target) {
  const s = await row(target);
  execFileSync('hermes', ['sessions', 'delete', s.id, '--yes'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  return s;
}
