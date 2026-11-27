#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../lib/core.js';
import * as log from '../lib/log.js';
import * as mail from '../lib/mail.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const HELP = `crosstalk ${VERSION}: let Claude, Antigravity, Codex and you message each other, live, in each app's own window.

  crosstalk list [app] [project] [--desktop|--cli]  sessions by project: desktop or terminal, forks under parents, newest first
  crosstalk send claude <session name> <text>    message an open Claude session
  crosstalk send antigravity <target> <text>     target: conversation id, its title, current or new
  crosstalk send codex <target> <text>           target: thread id, its title, current or new
  --wait [sec] waits for the reply to a send to Antigravity/Codex and prints it (1800 s if omitted)
  crosstalk send user <text>                     post to the person watching \`crosstalk ui\`
  crosstalk new <app> [--cli] [--cwd DIR] <text>  start a session: in the app, or in a terminal with --cli (Claude: always a background session)
  crosstalk archive|unarchive <app> <id>         hide or bring back a session by its id (Codex; Claude background sessions: stop)
  crosstalk delete <app> <id> --permanent        delete it (Codex, Antigravity desktop; Claude background: remove from the list)
  crosstalk read <app> <target> [-n 10] [--start K]  what you have not read yet (newest n), or n from message K
  crosstalk mail join [--cwd DIR] · who · watch   Agent Mail: link this session to a project mailbox; ring sessions on new mail
  crosstalk list --json · history <app> <target> [-n 60] [--start K] · send --json   the same, as JSON for programs
  crosstalk status <app> [target]                idle, busy or waiting for the user
  crosstalk ui [--port 4477] [--no-open]         chat window: open any session, read it, write in it
  crosstalk log [-n 20]                          recent messages
  crosstalk whoami                               who crosstalk thinks is sending
  crosstalk install | uninstall                  add or remove the agent skill

Options go before the text. --from <id>: your Antigravity conversation id when it is unavailable in the shell.
<text> as "-" reads the message from stdin.`;

const SKILL_LINKS = [
  join(homedir(), '.claude', 'skills', 'crosstalk'),
  join(homedir(), '.gemini', 'config', 'skills', 'crosstalk'),
  join(homedir(), '.codex', 'skills', 'crosstalk'),
  join(homedir(), '.config', 'opencode', 'skills', 'crosstalk'),
  join(homedir(), '.hermes', 'skills', 'crosstalk'),
];

// Options are read until the message text starts, so text like "fix the --port flag" stays intact.
function parse(argv) {
  const opt = { from: null, port: 4477, n: null, start: null, open: true, wait: null, surface: null, cwd: null, permanent: false, force: false, json: false, name: null, once: false };
  const words = [];
  const textStarts = () => (words[0] === 'send' && words.length >= (words[1] === 'user' ? 2 : 3)) || (words[0] === 'new' && words.length >= 2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `new <app>` still takes its own flags before the text: crosstalk new codex --cli --cwd DIR hi
    const newFlag = words[0] === 'new' && /^--(cli|desktop|cwd|wait|no-wait|from)$/.test(a);
    if (a === '--' || (textStarts() && !newFlag)) {
      words.push(...argv.slice(a === '--' ? i + 1 : i));
      break;
    }
    if (a === '--from') opt.from = argv[++i];
    else if (a === '--port') opt.port = Number(argv[++i]);
    else if (a === '-n') opt.n = Number(argv[++i]);
    else if (a === '--start') opt.start = Number(argv[++i]);
    else if (a === '--no-open') opt.open = false;
    else if (a === '--desktop' || a === '--cli') opt.surface = a.slice(2);
    else if (a === '--cwd') opt.cwd = argv[++i];
    else if (a === '--permanent') opt.permanent = true;
    else if (a === '--force') opt.force = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--name') opt.name = argv[++i];
    else if (a === '--once') opt.once = true;
    else if (a === '--wait') opt.wait = /^\d+$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 1800;
    else if (a === '--no-wait') opt.wait = 0;
    else if (a === '-h' || a === '--help') return { opt, words: ['help'] };
    else if (a === '-v' || a === '--version') return { opt, words: ['version'] };
    else words.push(a);
  }
  return { opt, words };
}

// Strips terminal control characters from text that came from other agents or apps.
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const readStdin = () => readFileSync(0, 'utf8').trim();
const ago = (ms) => {
  if (!ms) return '';
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

async function main() {
  const { opt, words } = parse(process.argv.slice(2));
  const [cmd, ...args] = words;
  switch (cmd) {
    case 'list': {
      const app = core.APP_NAMES.includes(args[0]) ? args[0] : null;
      const project = (app ? args[1] : args[0])?.toLowerCase();
      const all = await core.list(app);
      if (opt.json) {
        // Programs (the Paradev host, scripts) get the same tree as JSON: { app: [{ project, rows }] | { error } }.
        const tree = (rows) => core.tree(rows.map(({ prior, ...r }) => r).filter((r) => !opt.surface || r.surface === opt.surface));
        console.log(JSON.stringify(Object.fromEntries(Object.entries(all).map(([a, rows]) => [a, Array.isArray(rows) ? tree(rows) : rows]))));
        return;
      }
      for (const [agent, rows] of Object.entries(all)) {
        console.log(`${agent}:`);
        if (rows.error) {
          console.log(`  (${rows.error})`);
          continue;
        }
        const groups = core.tree(rows.filter((r) => !opt.surface || r.surface === opt.surface)).filter((g) => !project || g.project.toLowerCase().includes(project));
        if (!groups.length) console.log(project ? '  (no sessions in that project)' : '  (none)');
        for (const g of groups) {
          console.log(`  ${clean(g.project) || '(no folder)'}`);
          for (const r of g.rows) {
            const branch = r.depth ? `${'  '.repeat(r.depth - 1)}└ ${r.kind ? `(${clean(r.kind)}) ` : ''}` : '';
            console.log(`    ${branch}${(r.status || (r.open ? 'open' : '')).padEnd(7)} ${ago(r.last).padStart(4)}  ${(r.surface || '').padEnd(7)} ${clean(r.name)} | ${r.id}`);
            if (r.note) console.log(`    ${' '.repeat(branch.length + 14)}${clean(r.note)}`);
          }
        }
      }
      console.log('\nidle = ready · busy = working (a Claude session reads your message after its turn) · waiting = needs the user, do not answer for them'
        + ' · closed = not running: read it, or ask the user to open it to message it\ndesktop = in the app\'s window · cli = a terminal session · ide = an editor · exec = a one-off run'
        + '\nTime = since its last activity, newest first. └ = started from the session above (fork, side session or subagent).');
      return;
    }
    case 'send': {
      const [agent, ...rest] = args;
      const target = agent === 'user' ? null : rest.shift();
      let text = rest.join(' ');
      if (text === '-') text = readStdin();
      if (!agent || (agent !== 'user' && !target) || !text) throw new Error(`Usage: crosstalk send <${core.APP_NAMES.join('|')}|user> [target] <text>`);
      const from = core.whoami(opt.from);
      const wait = opt.wait ?? 0;
      if (!wait && agent !== 'user' && from.agent === 'antigravity' && !from.id) {
        throw new Error('Antigravity conversation ID unavailable. Use --from <your conversation ID> so replies reach you.');
      }
      if (wait && (agent === 'claude' || agent === 'user')) throw new Error('--wait does not apply to Claude: its sessions answer you directly.');
      const sent = await core.send(agent, target, text, from, wait > 0);
      if (opt.json && !wait) return console.log(JSON.stringify({ to: sent.to, delivery: sent.delivery ?? null }));
      const { to, delivery } = sent;
      const recipient = `${to.agent} ${JSON.stringify(clean(to.name))}${to.id ? ` (${to.id})` : ''}`;
      if (delivery === 'held') console.log(`held by ${recipient}. Check Claude's inbound message settings.`);
      else if (delivery === 'submitted') console.log(`submitted to ${recipient}. Delivery unconfirmed.`);
      else if (delivery === 'queued') console.log(`queued to ${recipient}${wait ? ', waiting for the answer' : ''}`);
      else console.log(`sent to ${recipient}${wait ? ', waiting for the answer' : ''}`);
      if (wait) console.log(`\n${clean(await core.waitReply(sent, wait * 1000))}`);
      return;
    }
    case 'new': {
      const [agent, ...rest] = args;
      let text = rest.join(' ');
      if (text === '-') text = readStdin();
      if (!core.APP_NAMES.includes(agent) || !text) throw new Error(`Usage: crosstalk new ${core.APP_NAMES.join('|')} [--cli] [--cwd DIR] [--wait] <first message>`);
      const wait = opt.wait ?? 0;
      const sent = await core.create(agent, text, { cli: opt.surface === 'cli', cwd: opt.cwd, sender: core.whoami(opt.from), waiting: wait > 0 });
      const { to } = sent;
      console.log(`started ${to.agent} ${JSON.stringify(clean(to.name))}${to.id ? ` (${to.id})` : ' (its id appears in crosstalk list once it starts)'}`);
      if (wait) console.log(`\n${clean(await core.waitReply(sent, wait * 1000))}`);
      return;
    }
    case '__run': // internal: follows a headless terminal-session run started by send or new
      await core.finishRun(args[0]);
      return;
    case 'archive':
    case 'unarchive':
    case 'delete': {
      const [agent, target, ...extra] = args;
      if (!agent || !target || extra.length) throw new Error(`Usage: crosstalk ${cmd} ${core.APP_NAMES.join('|')} <id>${cmd === 'delete' ? ' --permanent' : ''} [--force]`);
      if (cmd === 'delete' && !opt.permanent) throw new Error('delete cannot be undone: add --permanent. To hide a session but keep it, use: crosstalk archive');
      const row = await core.manage(cmd, agent, target, { force: opt.force, actor: core.whoami(opt.from) });
      console.log(`${cmd}d ${agent} ${JSON.stringify(clean(row.name))} (${row.id})`);
      return;
    }
    case 'mail': {
      const sub = args[0];
      if (sub === 'join') {
        const project = resolvePath(opt.cwd || process.cwd());
        const me = core.whoami(opt.from);
        const name = mail.join(me, { project, name: opt.name });
        console.log(`${me.agent} session ${JSON.stringify(clean(me.name || me.id))} is "${name}" in the mailbox of ${project}.`);
        console.log(`Send:  am mail send -p ${core.shellQuote(project)} --from ${name} --to <Name> -s '<subject>' -b '<text>' [--thread-id ID] [--ack-required]`);
        console.log(`Read:  am mail inbox -p ${core.shellQuote(project)} --agent ${name} --include-bodies`);
        console.log('New mail rings this session while crosstalk mail watch runs.');
        return;
      }
      if (sub === 'who') {
        for (const m of mail.members()) console.log(`${m.agent.padEnd(16)} ${m.app.padEnd(12)} ${clean(m.label)} | ${m.session} | ${m.project}`);
        return;
      }
      if (sub === 'watch') {
        const q = core.shellQuote;
        console.log(opt.once ? 'Ringing for mail delivered so far…' : 'Ringing sessions when mail arrives (Ctrl-C to stop)…');
        await mail.watch(async (m, e) => {
          const sender = { agent: 'mail', name: `Agent Mail (${e.from})`, reply: `am mail reply -p ${q(m.project)} --from ${m.agent} --message-id ${e.message_id} -b '<reply>'` };
          const text = `New mail for ${m.agent} from ${e.from}: ${JSON.stringify(e.subject)}${e.importance && e.importance !== 'normal' ? ` [${e.importance}]` : ''}`
            + `${e.ack_required ? ', and it asks for an acknowledgement' : ''}.\nRead it: am mail inbox -p ${q(m.project)} --agent ${m.agent} --include-bodies`
            + `${e.ack_required ? `\nAcknowledge: am mail ack -p ${q(m.project)} --agent ${m.agent} ${e.message_id}` : ''}`;
          const { delivery } = await core.send(m.app, m.session, text, sender, false, { replyBack: true });
          console.log(`rang ${m.agent} (${m.app}) for mail ${e.message_id}${delivery ? ` · ${delivery}` : ''}`);
        }, { once: opt.once, onError: (m, err) => console.error(`${m.agent}: ${err.message}`) });
        return;
      }
      throw new Error('Usage: crosstalk mail join [--cwd DIR] [--name NAME] | who | watch [--once]');
    }
    case 'history': {
      // The plain history for programs: no read markers move, so a UI can show it as often as it likes.
      const h = await core.history(args[0], args[1], { n: opt.n ?? 60, start: opt.start });
      console.log(JSON.stringify({ id: h.id, name: h.name, total: h.total, messages: h.messages }));
      return;
    }
    case 'read': {
      for (const v of [opt.n, opt.start]) if (v !== null && !(Number.isInteger(v) && v > 0)) throw new Error('-n and --start take a whole number from 1.');
      const n = opt.n ?? 10;
      const h = await core.read(args[0], args[1], { n, start: opt.start, reader: core.whoami(opt.from) });
      const first = h.messages[0]?.n;
      const last = h.messages.at(-1)?.n;
      const cmd = (start, count) => `crosstalk read ${args[0]} ${h.id} --start ${start} -n ${count}`;
      const range = first ? `messages ${first}-${last} of ${h.total}` : `${h.total} messages`;
      console.log(`${args[0]} ${JSON.stringify(clean(h.name))} (${h.id}): ${opt.start ? range
        : h.changed ? `history changed since your last read · newest ${range}`
        : !h.seen ? range
        : !h.unread ? `nothing new since your last read (message ${h.seen} of ${h.total})`
        : `${h.unread} new since your last read · ${range}`}`);
      if (first > 1) {
        const unreadAbove = opt.start ? 0 : first - 1 - h.seen;
        const from = Math.max(unreadAbove > 0 ? h.seen + 1 : 1, first - n);
        console.log(unreadAbove > 0 ? `↑ ${unreadAbove} more unread above: ${cmd(from, first - from)}` : `↑ ${first - 1} earlier: ${cmd(from, first - from)}`);
      }
      if (last < h.total) console.log(`↓ ${h.total - last} later: ${cmd(last + 1, n)}`);
      if (!first && h.total) console.log(`To reread the newest: ${cmd(Math.max(1, h.total - n + 1), n)}`);
      for (const m of h.messages) {
        const time = m.ts ? ` · ${new Date(m.ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
        console.log(`\n#${m.n} ${m.role}${m.from ? ` (${clean(m.from)})` : ''}${time}\n  ${clean(m.text).replace(/\n/g, '\n  ')}`);
      }
      return;
    }
    case 'status': {
      const app = args[0] !== 'claude' && core.APPS[args[0]];
      if (!app) throw new Error(`Usage: crosstalk status ${core.APP_NAMES.filter((a) => a !== 'claude').join('|')} [target]`);
      const s = await app.status(args[1]);
      console.log(`${s.status} | ${clean(s.name)} | ${s.id || '(new)'}${s.note ? `\n${clean(s.note)}` : ''}`);
      return;
    }
    case 'open': {
      const app = core.APPS[args[0]]?.open && core.APPS[args[0]];
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
      for (const m of log.readAll().slice(-(opt.n ?? 20))) {
        const who = (p) => clean(`${p?.agent || '?'}:${p?.name || ''}`);
        const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        console.log(`${time} ${who(m.from)} -> ${who(m.to)}${m.delivery ? ` (${clean(m.delivery)})` : ''}\n  ${clean(m.text).replace(/\n/g, '\n  ')}`);
      }
      return;
    case 'whoami':
      console.log(JSON.stringify(await core.describeSender(opt.from)));
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
