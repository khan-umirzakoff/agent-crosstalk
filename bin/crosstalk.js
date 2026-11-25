#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as antigravity from '../lib/antigravity.js';
import * as codex from '../lib/codex.js';
import * as core from '../lib/core.js';
import * as log from '../lib/log.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const HELP = `crosstalk ${VERSION}: let Claude, Antigravity, Codex and you message each other, live, in each app's own window.

  crosstalk list [claude|antigravity|codex]      sessions you can message, and whether they are free
  crosstalk send claude <session name> <text>    message an open Claude session
  crosstalk send antigravity <target> <text>     target: conversation id, its title, current or new
  crosstalk send codex <target> <text>           target: thread id, its title, current or new
  crosstalk send --wait [sec] <app> <target> <text>  Antigravity/Codex: wait for the answer and print it
  crosstalk send user <text>                     post to the person watching \`crosstalk ui\`
  crosstalk read antigravity|codex [target]      last reply
  crosstalk status antigravity|codex [target]    idle, busy or waiting for the user
  crosstalk open antigravity|codex               restart the app so crosstalk can reach it (Codex: in Codex mode)
  crosstalk ui [--port 4477] [--no-open]         chat room: every message in one timeline
  crosstalk log [-n 20]                          recent messages
  crosstalk whoami                               who crosstalk thinks is sending
  crosstalk install | uninstall                  add or remove the agent skill

Options go before the text. --from <id>: your conversation id when you are an Antigravity agent.
<text> as "-" reads the message from stdin.`;

const SKILL_LINKS = [
  join(homedir(), '.claude', 'skills', 'crosstalk'),
  join(homedir(), '.gemini', 'config', 'skills', 'crosstalk'),
  join(homedir(), '.codex', 'skills', 'crosstalk'),
];

// Options are read until the message text starts, so text like "fix the --port flag" stays intact.
function parse(argv) {
  const opt = { from: null, port: 4477, n: 20, open: true, wait: 0 };
  const words = [];
  const textStarts = () => words[0] === 'send' && words.length >= (words[1] === 'user' ? 2 : 3);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' || textStarts()) {
      words.push(...argv.slice(a === '--' ? i + 1 : i));
      break;
    }
    if (a === '--from') opt.from = argv[++i];
    else if (a === '--port') opt.port = Number(argv[++i]);
    else if (a === '-n') opt.n = Number(argv[++i]);
    else if (a === '--no-open') opt.open = false;
    else if (a === '--wait') opt.wait = /^\d+$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 900;
    else if (a === '-h' || a === '--help') return { opt, words: ['help'] };
    else if (a === '-v' || a === '--version') return { opt, words: ['version'] };
    else words.push(a);
  }
  return { opt, words };
}

// Strips terminal control characters from text that came from other agents or apps.
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const readStdin = () => readFileSync(0, 'utf8').trim();

async function main() {
  const { opt, words } = parse(process.argv.slice(2));
  const [cmd, ...args] = words;
  switch (cmd) {
    case 'list': {
      const all = await core.list(args[0]);
      for (const [agent, rows] of Object.entries(all)) {
        console.log(`${agent}:`);
        if (rows.error) console.log(`  (${rows.error})`);
        else if (!rows.length) console.log('  (none open)');
        else for (const r of rows) {
          console.log(`  ${(r.status || (r.open ? 'open' : '')).padEnd(8)} ${clean(r.name)} | ${clean(r.project || basename(r.cwd || ''))} | ${r.id}`);
          if (r.note) console.log(`  ${''.padEnd(8)} ${clean(r.note)}`);
        }
      }
      console.log('\nidle = ready · busy = working (a Claude session reads your message after its turn) · waiting = needs the user, do not answer for them');
      return;
    }
    case 'send': {
      const [agent, ...rest] = args;
      const target = agent === 'user' ? null : rest.shift();
      let text = rest.join(' ');
      if (text === '-') text = readStdin();
      if (!agent || (agent !== 'user' && !target) || !text) throw new Error('Usage: crosstalk send <claude|antigravity|codex|user> [target] <text>');
      const sent = await core.send(agent, target, text, core.whoami(opt.from), opt.wait > 0);
      const { to } = sent;
      console.log(`sent to ${to.agent} ${JSON.stringify(clean(to.name))}${to.id ? ` (${to.id})` : ''}${to.status === 'busy' ? ': it is busy and reads it after its current turn' : ''}`);
      if (opt.wait) console.log(`\n${clean(await core.waitReply(sent, opt.wait * 1000))}`);
      return;
    }
    case 'read':
    case 'status': {
      const app = { antigravity, codex }[args[0]];
      if (!app) throw new Error(`Usage: crosstalk ${cmd} antigravity|codex [target]`);
      if (cmd === 'read') console.log(clean(await app.read(args[1])) || '(no reply yet)');
      else {
        const s = await app.status(args[1]);
        console.log(`${s.status} | ${clean(s.name)} | ${s.id || '(new)'}${s.note ? `\n${clean(s.note)}` : ''}`);
      }
      return;
    }
    case 'open': {
      const app = { antigravity, codex }[args[0]];
      if (!app) throw new Error('Usage: crosstalk open antigravity|codex');
      console.log(await app.open());
      return;
    }
    case 'ui': {
      const { serve } = await import('../lib/ui.js');
      await serve(opt.port, opt.open);
      return;
    }
    case 'log':
      for (const m of log.readAll().slice(-opt.n)) {
        const who = (p) => clean(`${p?.agent || '?'}:${p?.name || ''}`);
        const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        console.log(`${time} ${who(m.from)} -> ${who(m.to)}\n  ${clean(m.text).replace(/\n/g, '\n  ')}`);
      }
      return;
    case 'whoami':
      console.log(JSON.stringify(core.whoami(opt.from)));
      return;
    case 'install':
      for (const link of SKILL_LINKS) {
        if (!exists(dirname(dirname(link)))) continue; // that agent is not installed
        mkdirSync(dirname(link), { recursive: true });
        if (exists(link)) rmSync(link); // replace an old or dangling link
        symlinkSync(join(ROOT, 'skill'), link);
        console.log(`skill: ${link}`);
      }
      return;
    case 'uninstall':
      for (const link of SKILL_LINKS) {
        if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
          rmSync(link);
          console.log(`removed: ${link}`);
        }
      }
      return;
    case 'version':
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

// True for files, folders and symlinks, dangling ones included; a real folder at a skill path is left alone by install.
function exists(p) {
  const s = lstatSync(p, { throwIfNoEntry: false });
  if (s && !s.isSymbolicLink() && p.endsWith(join('skills', 'crosstalk'))) throw new Error(`${p} exists and is not a crosstalk link; remove it first.`);
  return !!s;
}

main().catch((e) => {
  console.error(clean(e.message));
  process.exit(1);
});
