// Every message crosstalk carries is appended here; `crosstalk ui` shows it as one timeline.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DIR = process.env.CROSSTALK_HOME || join(homedir(), '.crosstalk');
export const FILE = join(DIR, 'log.jsonl');

export function append(entry) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
}

export function readAll() {
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}
