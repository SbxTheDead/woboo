#!/usr/bin/env node
// Woboo's front door.
//
//   woboo up          start the dashboard and leave it running
//   woboo run "…"     one mission, in this terminal, exit code says how it went
//   woboo doctor      what works on this machine and what does not
//
// The CLI and the dashboard drive exactly the same modules — the browser is a
// second face on one body, never a second implementation.

import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { PATHS, loadSettings, saveSettings, loadSecrets, saveSecret, ownerKey, ensureHome } from './src/config.mjs';
import * as memory from './src/memory.mjs';
import * as telegram from './src/telegram.mjs';
import { subscribe } from './src/bus.mjs';
import { tail, record } from './src/journal.mjs';
import { listen } from './src/server.mjs';
import * as guard from './src/guard.mjs';
import * as foreman from './src/foreman.mjs';
import * as crew from './src/crew.mjs';
import * as brain from './src/brain.mjs';
import * as eyes from './src/eyes.mjs';
import { handsMode } from './src/hands.mjs';

// ── terminal dressing ─────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const cyan = (t) => paint('36', t);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);

const LEVEL_PAINT = { ok: green, warn: yellow, error: red };

function say(text = '') {
  process.stdout.write(`${text}\n`);
}

const BANNER = `${bold(green('  ▄▄   ▄▄  '))}
${bold(green(' ( o   o ) '))}  ${bold('woboo')} ${dim('— a body for your AI')}
${bold(green('  \\  ‾  /  '))}
`;

// ── shared helpers ────────────────────────────────────────────────────────────

// Mirror the journal into the terminal, so a CLI mission reads like the
// dashboard's feed.
function mirrorJournal() {
  return subscribe((event) => {
    if (event.type !== 'log') return;
    const tint = LEVEL_PAINT[event.level] || dim;
    say(`${dim(new Date(event.at).toTimeString().slice(0, 8))} ${dim(event.kind.padEnd(8))} ${tint(event.msg)}`);
  });
}

// Without a dashboard there is nobody to answer an approval, and guard.mjs
// times those out into denials. On a TTY, ask right here instead.
function terminalApprovals() {
  if (!process.stdin.isTTY) return () => {};

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queue = [];
  let asking = false;

  const pump = async () => {
    if (asking || !queue.length) return;
    asking = true;
    const request = queue.shift();
    say('');
    say(yellow(`  ${request.kind.toUpperCase()} — ${request.reason}`));
    say(`  ${bold(request.detail)}`);
    let allow = false;
    try {
      const answer = await rl.question(dim(`  allow? [y/N] `));
      allow = /^y/i.test(answer.trim());
    } catch {
      // stdin closed mid-question; a denial is the safe reading.
    }
    guard.resolveApproval(request.id, allow ? 'allow' : 'deny');
    asking = false;
    pump();
  };

  const off = subscribe((event) => {
    if (event.type === 'approval') {
      queue.push(event.request);
      pump();
    }
    if (event.type === 'approval:resolved') {
      // Answered elsewhere (a timeout, or STOP); drop it from our queue.
      const at = queue.findIndex((r) => r.id === event.id);
      if (at >= 0) queue.splice(at, 1);
    }
  });

  return () => {
    off();
    rl.close();
  };
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

function openBrowser(url) {
  const [file, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    // The URL travels as its own argv entry, so the key never touches a shell.
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser opener here; the printed URL still works.
  }
}

// ── commands ──────────────────────────────────────────────────────────────────

async function cmdUp(flags) {
  ensureHome();
  // A named port means a named port — don't quietly serve somewhere else.
  const { server, url, port, host } = await listen({ port: flags.port, strict: true });
  const stopIdle = foreman.startIdleWatch();

  say(BANNER);
  say(`  dashboard  ${cyan(url)}`);
  say(`  bound to   ${host}:${port} ${dim('(loopback only)')}`);
  say(`  home       ${dim(PATHS.home)}`);

  const members = await crew.discover();
  const ready = members.filter((m) => m.available);
  say(`  crew       ${ready.length ? green(ready.map((m) => m.label).join(', ')) : yellow('none found')}`);
  say(`  brain      ${brain.hasCredentials() ? green(loadSettings().model) : yellow('offline — deterministic plans')}`);
  if (guard.isStopped()) say(`  ${red('STOP is engaged')} ${dim(guard.stopReason())}`);
  say('');
  say(dim('  open the URL above (it carries your owner key). Ctrl+C to shut down.'));

  if (flags.open) openBrowser(url);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    say('');
    say(dim('  shutting down…'));
    stopIdle();
    record('server', 'dashboard stopped');
    server.close(() => process.exit(0));
    // Don't let a wedged socket hold the process hostage.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise(() => {}); // run until interrupted
}

// Hand Woboo the mouse and keyboard. This is the one command that takes over the
// machine, so it says so plainly first and `--dry` proves the wiring without
// moving anything.
async function cmdDrive(goal, flags) {
  if (!goal) {
    say(red('  give it a goal: woboo drive "open Edge and search for elephant population 2024"'));
    say(dim('  add --dry to see what it would do without touching the mouse.'));
    return 2;
  }

  const pilot = await import('./src/pilot.mjs');
  const offMirror = mirrorJournal();
  const offApprovals = terminalApprovals();

  try {
    if (flags.dry) {
      say(dim('  dry run — looking at the screen, deciding one action, touching nothing.'));
      const result = await pilot.drive({ goal, dryRun: true });
      say('');
      say(`  screen  ${dim(result.screen || '')}`);
      say(`  ${bold(result.out)}`);
      return result.ok ? 0 : 1;
    }

    say('');
    say(yellow('  Woboo is about to take your mouse and keyboard.'));
    say(dim('  Press STOP in the widget, or Ctrl+C here, to stop it at any point.'));
    say('');

    const result = await pilot.drive({
      goal,
      onProgress: (note) => say(dim(`  ${note}`)),
    });
    say('');
    say(result.ok ? green(`  ✓ ${result.out}`) : red(`  ✗ ${result.out}`));
    return result.ok ? 0 : 1;
  } catch (err) {
    say(red(`  ${err.message}`));
    return 1;
  } finally {
    offMirror();
    offApprovals();
  }
}

// The browser Woboo drives, and which profile it uses.
async function cmdBrowser(args, flags) {
  const browser = await import('./src/browser.mjs');
  const { browserPath } = await import('./src/toolbox.mjs');
  const { script } = await import('./src/ps.mjs');

  // The scripts below run through ps.mjs, which hands the source to
  // powershell.exe as a single argv entry — no shell ever re-reads it. But
  // PowerShell itself still parses the string, and the profile path goes in
  // twice: a user named `o'hara` breaks a single-quoted string, and one named
  // `a[b]` turns a -like pattern into a wildcard match on the wrong processes.
  const psLiteral = (value) => String(value).replace(/'/g, "''");
  const psPattern = (value) => psLiteral(value).replace(/[`[\]*?]/g, '`$&');

  const exe = browserPath();
  const which = exe && /chrome\.exe$/i.test(exe) ? 'Chrome' : 'Edge';

  // Woboo drives a browser profile of its own — Chrome refuses a debugging port
  // on the real one, and has since Chrome 136, because that is exactly how
  // session-stealing malware works. So signing in is a one-time thing the owner
  // does by hand, in Woboo's browser, once per account.
  if (args[0] === 'signin' || args[0] === 'login') {
    const where = args[1] || 'https://accounts.google.com';
    const opened = await browser.open();
    if (!opened.ok) return say(red(`  ${opened.error}`)) || 1;
    await browser.goto(where);
    say(green(`  ${which} is open on ${where}.`));
    say(dim("  sign in there by hand — it is Woboo's own profile, and it stays signed in."));
    say(dim('  Woboo never types passwords or one-time codes itself.'));
    return 0;
  }

  if (args[0] === 'reset') {
    await browser.close().catch(() => {});
    await script(`Remove-Item -LiteralPath '${psLiteral(browser.profileDir())}' -Recurse -Force -ErrorAction SilentlyContinue`, {
      action: 'reset browser profile',
      timeout: 30_000,
    });
    say(green("  Woboo's browser profile is wiped — every account signed out."));
    return 0;
  }

  if (flags.restart) {
    say(yellow(`  closing Woboo's ${which} and reopening it with debugging enabled…`));
    await browser.close().catch(() => {});
    await script(
      `Get-CimInstance Win32_Process -Filter "Name='${which === 'Chrome' ? 'chrome.exe' : 'msedge.exe'}'" | ` +
        `Where-Object { $_.CommandLine -like '*${psPattern(browser.profileDir())}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      { action: 'close browser', timeout: 20_000 },
    );
    await new Promise((r) => setTimeout(r, 2000));
    const opened = await browser.open();
    say(opened.ok ? green(`  ${which} is up and Woboo is attached.`) : red(`  ${opened.error}`));
    return opened.ok ? 0 : 1;
  }

  say(`  browser   ${cyan(exe || 'none found')}`);
  say(`  profile   ${bold(browser.profileDir())}`);
  const state = await browser.open();
  say(`  attached  ${state.ok ? green('yes') : red('no')}`);
  if (!state.ok) {
    say('');
    say(dim(`  ${state.error}`));
  }
  say('');
  say(dim('  woboo  browser signin [url]  open it so you can sign in to an account'));
  say(dim('  woboo  browser reset         wipe the profile and sign out of everything'));
  say(dim('  woboo  browser --restart     reopen the browser with debugging enabled'));
  return 0;
}

// Reachable from your phone. Long polling, so no public URL and no inbound port.
async function cmdTelegram() {
  const secrets = loadSecrets();
  const token = secrets.telegramToken || process.env.WOBOO_TELEGRAM_TOKEN || process.env.WOBO_TELEGRAM_TOKEN;
  if (!token) {
    say(red('  no Telegram token stored.'));
    say(dim('  get one from @BotFather, then: woboo secret telegram <token>'));
    return 2;
  }

  const offMirror = mirrorJournal();
  try {
    const bot = await telegram.start({
      token,
      onPairCode: (code, username) => {
        say('');
        say(`  ${bold('Pair your phone:')} message ${cyan(`@${username}`)} with`);
        say(`  ${bold(green(`/pair ${code}`))}`);
        say(dim('  until then, Woboo ignores every message it receives.'));
        say('');
      },
    });
    if (bot.paired()) say(dim(`  paired with chat ${bot.paired()} — send it a task.`));
    say(dim('  Ctrl+C to stop.'));
    await new Promise(() => {}); // run until interrupted
    return 0;
  } catch (err) {
    say(red(`  ${err.message}`));
    return 1;
  } finally {
    offMirror();
  }
}

// The free brain. Browse what NIM offers, or point Woboo at one.
async function cmdNim(args) {
  const nim = await import('./src/nim.mjs');
  if (args[0] && args[0] !== 'list') {
    const next = saveSettings({ nimModel: args[0], provider: 'nim' });
    say(green(`  brain = NIM / ${next.nimModel}`));
    return 0;
  }

  const stored = nim.hasCredentials();
  say(`  key stored  ${stored ? green('yes') : red('no — woboo secret nvidia nvapi-...')}`);
  say(`  using       ${cyan(nim.model())}`);
  say(`  get a key   ${dim('build.nvidia.com — sign in, pick a model, "Get API Key"')}`);
  say('');
  say(dim('  suggested for planning:'));
  for (const s of nim.SUGGESTED) {
    const mark = s.id === nim.model() ? green(' *') : '  ';
    say(`${mark} ${s.id.padEnd(38)} ${dim(s.note)}`);
  }

  if (args[0] === 'list') {
    try {
      const all = await nim.listModels();
      say('');
      say(dim(`  all ${all.length} models NIM hosts:`));
      for (const id of all) say(`    ${id}`);
    } catch (err) {
      say(red(`  ${err.message}`));
    }
  }
  say('');
  say(dim('  woboo  nim <model-id>   point Woboo at one'));
  say(dim('  woboo  nim list         every model NIM hosts'));
  return 0;
}

function cmdMemory(args) {
  const target = args[0] && args[0] !== '--forget' ? path.resolve(args[0]) : process.cwd();

  if (args.includes('--forget')) {
    say(memory.forget(target) ? yellow(`  forgot everything about ${target}`) : dim('  nothing to forget'));
    return 0;
  }
  if (args[0] === '--all') {
    const all = memory.workspaces();
    if (!all.length) return say(dim('  no memories yet.')) || 0;
    for (const w of all) say(`  ${dim(new Date(w.updatedAt).toISOString().slice(0, 10))}  ${w.workspace}`);
    return 0;
  }

  const digest = memory.recall(target);
  const stats = memory.summary(target);
  const stored =
    stats.lessons + stats.corrections + stats.checks + stats.missions + stats.facts;

  say(`  ${bold(target)}`);
  say(
    dim(
      `  ${stats.missions} mission(s), ${stats.lessons} lesson(s), ` +
        `${stats.corrections} correction(s), ${stats.checks} check(s) tracked`,
    ),
  );
  say('');

  if (digest) {
    say(digest.split('\n').map((line) => `  ${line}`).join('\n'));
  } else if (stored) {
    // The store has content, it just has nothing a planner would benefit from —
    // successful missions and checks that have never failed are not guidance.
    say(dim('  nothing worth telling the planner yet — no corrections, no'));
    say(dim('  failures, and no check has caught anything here.'));
  } else {
    say(dim('  nothing remembered here yet.'));
  }
  say('');
  say(dim(`  ${stats.file}`));
  return 0;
}

// The desktop companion: a frameless, always-on-top Woboo that lives on your
// desktop. It runs the same modules this CLI does, in an Electron main process.
async function cmdWidget() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, 'desktop', 'main.mjs');

  // Starting a widget that cannot think is a worse first impression than one
  // question. Offer setup rather than launching something that blinks and does
  // nothing — but only when there is a terminal to answer in.
  const setup = await import('./src/setup.mjs');
  if (!setup.isConfigured() && process.stdin.isTTY) {
    say(yellow('  Woboo has no brain configured yet.'));
    const result = await setup.run({ say, colors: { bold, dim, green, yellow, cyan, red } });
    if (!result.ok) return 1;
    say('');
  }

  let electron;
  try {
    electron = createRequire(import.meta.url)('electron');
  } catch {
    electron = null;
  }
  if (typeof electron !== 'string') {
    say(red('  the widget needs Electron.'));
    say(dim('  run `npm install` inside the woboo folder, then try again.'));
    return 1;
  }

  // VS Code and other Electron hosts export ELECTRON_RUN_AS_NODE=1, and a child
  // inherits it — which makes electron.exe boot as a plain Node runtime with no
  // app, no windows, and a very confusing "app is undefined". Strip it.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  say(dim('  woboo is on your desktop — drag the head to move it, hover to open the panel.'));
  const child = spawn(electron, [entry], { stdio: 'inherit', windowsHide: false, env });
  return new Promise((resolve) => {
    child.on('error', (err) => {
      say(red(`  could not start the widget: ${err.message}`));
      resolve(1);
    });
    child.on('close', (code) => resolve(code === 0 ? 0 : 1));
  });
}

async function cmdRun(task, flags) {
  if (!task) {
    say(red('  give it a task: woboo run "add a health endpoint and test it"'));
    return 2;
  }

  const offMirror = mirrorJournal();
  const offApprovals = terminalApprovals();
  const workspace = flags.workspace ? path.resolve(flags.workspace) : undefined;

  try {
    const mission = await foreman.runMission(task, { workspace });
    say('');
    const proven = mission.steps.filter((s) => s.status === 'ok' && s.verify).length;
    const headline =
      mission.state === 'done'
        ? green(`  ✓ ${mission.report}`)
        : mission.state === 'stopped'
          ? yellow(`  ■ ${mission.report}`)
          : red(`  ✗ ${mission.report}`);
    say(headline);
    say(dim(`    ${mission.steps.length} step(s), ${proven} proven by a command, ` +
      `${Math.round(((mission.endedAt || Date.now()) - mission.startedAt) / 1000)}s`));
    return mission.state === 'done' ? 0 : 1;
  } catch (err) {
    say(red(`  ✗ ${err.message}`));
    return 1;
  } finally {
    offMirror();
    offApprovals();
  }
}

async function cmdSelfTest() {
  const offMirror = mirrorJournal();
  try {
    const { pass, mission } = await foreman.selfTest();
    say('');
    say(pass ? green(`  ✓ ${mission.report}`) : red(`  ✗ ${mission.report}`));
    return pass ? 0 : 1;
  } finally {
    offMirror();
  }
}

async function cmdDoctor() {
  const settings = loadSettings();
  const rows = [];
  let hardFailures = 0;

  const check = (label, level, detail) => {
    if (level === 'bad') hardFailures += 1;
    rows.push({ label, level, detail });
  };

  const major = Number(process.versions.node.split('.')[0]);
  check('node', major >= 22 ? 'ok' : 'bad', `v${process.versions.node}${major >= 22 ? '' : ' — Woboo needs 22+'}`);
  check('home', 'ok', PATHS.home);

  const sdk = brain.installed();
  check('brain sdk', sdk ? 'ok' : 'warn', sdk ? '@anthropic-ai/sdk present' : 'missing — run `npm install`');

  const creds = brain.hasCredentials();
  check(
    'brain auth',
    creds ? 'ok' : 'warn',
    creds ? `${settings.model} @ ${settings.effort} effort` : 'no credentials — Woboo will use offline plans',
  );

  const members = await crew.discover({ refresh: true });
  for (const member of members) {
    check(`crew: ${member.name}`, member.available ? 'ok' : 'warn', member.path || 'not installed');
  }
  if (!members.some((m) => m.available)) {
    check('crew', 'warn', 'no coding tool found — delegate steps cannot run');
  }

  const free = await portFree(settings.port);
  check('port', free ? 'ok' : 'warn', free ? `${settings.port} available` : `${settings.port} in use (Woboo already up?)`);

  const shot = await eyes.screenshot({ reason: 'doctor' });
  check('eyes', shot.ok ? 'ok' : 'warn', shot.ok ? `captured ${shot.size || ''}`.trim() : shot.error);

  const handsOn = process.platform === 'win32';
  check('hands', handsOn ? 'ok' : 'warn', handsOn ? `mode: ${handsMode()}` : 'Windows only');

  const stopped = guard.isStopped();
  check('stop latch', stopped ? 'warn' : 'ok', stopped ? `engaged: ${guard.stopReason()}` : 'clear');

  // The four things that failed silently in front of the owner. A check that
  // does not cover the way something actually broke is decoration.
  const secrets = loadSecrets();
  const browser = await import('./src/browser.mjs');
  const nim = await import('./src/nim.mjs');

  // Telegram: not "is there a token" but "is anyone listening, and who".
  if (!secrets.telegramToken) {
    check('telegram', 'warn', 'no token — run `woboo secret telegram <token>`');
  } else {
    const holder = telegram.lockHolder();
    const live = await telegram.reachable().catch((err) => ({ ok: false, error: err.message }));
    check(
      'telegram',
      live.ok ? (holder ? 'ok' : 'warn') : 'bad',
      live.ok
        ? holder
          ? `@${live.username}, polled by pid ${holder.pid}`
          : `@${live.username} reachable, but nothing is polling — start the app`
        : `unreachable: ${live.error}`,
    );
    check(
      'telegram pairing',
      settings.telegramChatId ? 'ok' : 'warn',
      settings.telegramChatId ? `paired with chat ${settings.telegramChatId}` : 'not paired — send /pair from your phone',
    );
  }

  // The browser: does the debugging port actually open? Chrome refuses it on the
  // default profile, which is how every browser mission failed for a day.
  const attached = await browser.open().then(
    (r) => r,
    (err) => ({ ok: false, error: err.message }),
  );
  check('browser', attached.ok ? 'ok' : 'bad', attached.ok ? browser.profileDir() : attached.error);
  browser.close();

  // The brain Woboo is actually configured to use.
  if (settings.provider === 'nim' || nim.hasCredentials()) {
    const key = nim.hasCredentials();
    check('nim', key ? 'ok' : 'bad', key ? nim.model() : 'no NVIDIA key — run `woboo secret nvidia nvapi-...`');
  }

  check(
    'search',
    secrets.tavilyApiKey ? 'ok' : 'warn',
    secrets.tavilyApiKey ? 'Tavily' : 'no Tavily key — falling back to scraped results',
  );

  // Anything Woboo already complained about and nobody read.
  const recentErrors = tail(200).filter(
    (entry) => entry.level === 'error' && Date.now() - new Date(entry.t).getTime() < 86_400_000,
  );
  if (recentErrors.length) {
    check('recent errors', 'warn', `${recentErrors.length} in the last day — ${recentErrors.at(-1).msg.slice(0, 60)}`);
  }

  say(BANNER);
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    const mark = row.level === 'ok' ? green('✓') : row.level === 'warn' ? yellow('!') : red('✗');
    say(`  ${mark} ${row.label.padEnd(width)}  ${dim(row.detail)}`);
  }
  say('');
  if (hardFailures) {
    say(red(`  ${hardFailures} thing(s) Woboo cannot work around.`));
    return 1;
  }
  const warnings = rows.filter((r) => r.level === 'warn').length;
  say(warnings ? yellow(`  usable, with ${warnings} limitation(s) above.`) : green('  everything Woboo needs is here.'));
  return 0;
}

function cmdSet(key, value) {
  if (!key) {
    const settings = loadSettings();
    for (const [name, current] of Object.entries(settings)) {
      say(`  ${name.padEnd(16)} ${dim(JSON.stringify(current))}`);
    }
    say('');
    say(dim(`  settings file: ${PATHS.settings}`));
    return 0;
  }
  if (!(key in loadSettings())) {
    say(red(`  "${key}" is not a Woboo setting. Run \`woboo set\` to see them all.`));
    return 2;
  }

  // Let numbers stay numbers and null stay null; anything else is a string.
  let parsed = value;
  if (value === 'null') parsed = null;
  else if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  else if (value !== '' && !Number.isNaN(Number(value))) parsed = Number(value);

  const next = saveSettings({ [key]: parsed });
  if (key === 'crew') crew.invalidate();
  say(green(`  ${key} = ${JSON.stringify(next[key])}`));
  return 0;
}

function cmdLog(count) {
  const entries = tail(Number(count) || 40);
  if (!entries.length) {
    say(dim('  nothing in the journal yet.'));
    return 0;
  }
  for (const entry of entries) {
    const tint = LEVEL_PAINT[entry.level] || dim;
    say(`${dim(entry.t.slice(11, 19))} ${dim(String(entry.kind).padEnd(8))} ${tint(entry.msg)}`);
  }
  return 0;
}

async function cmdLook() {
  const shot = await eyes.screenshot({ reason: 'cli' });
  if (!shot.ok) {
    say(red(`  ${shot.error}`));
    return 1;
  }
  say(green(`  ${shot.path}`));
  return 0;
}

function help() {
  say(BANNER);
  say(`  ${bold('usage')}  woboo <command> [options]`);
  say('');
  say(`  ${bold('setup')}              set Woboo up from scratch ${dim('(start here; --again to redo)')}`);
  say(`  ${bold('widget')}             put Woboo on your desktop ${dim('(the companion)')}`);
  say(`  ${bold('drive')} "<goal>"     hand it the mouse and keyboard ${dim('(--dry to preview)')}`);
  say(`  ${bold('telegram')}           reach Woboo from your phone`);
  say(`  ${bold('up')}                 start the browser panel ${dim('(--port N, --open)')}`);
  say(`  ${bold('memory')} [dir]       what Woboo remembers ${dim('(--all, --forget)')}`);
  say(`  ${bold('secret')} <name> <v>  store a key: anthropic, nvidia, telegram, tavily`);
  say(`  ${bold('nim')} [model|list]   use NVIDIA NIM as the brain ${dim('(free tier)')}`);
  say(`  ${bold('browser')} [signin]   Woboo's own browser profile ${dim('(reset, --restart)')}`);
  say(`  ${bold('run')} "<task>"       run one mission here ${dim('(--workspace DIR)')}`);
  say(`  ${bold('selftest')}           prove the foreman loop verifies and catches failures`);
  say(`  ${bold('doctor')}             check what works on this machine`);
  say(`  ${bold('stop')} [reason]      engage the STOP latch — kills work, blocks new work`);
  say(`  ${bold('resume')}             release STOP`);
  say(`  ${bold('look')}               take a screenshot`);
  say(`  ${bold('log')} [n]            tail the journal`);
  say(`  ${bold('set')} [key] [value]  show or change settings`);
  say(`  ${bold('key')}                print the dashboard URL with the owner key`);
  say('');
  say(dim('  Woboo delegates coding to Claude Code or Codex, then proves the work'));
  say(dim('  with real commands before reporting it done.'));
  return 0;
}

// ── entry ─────────────────────────────────────────────────────────────────────

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--open') flags.open = true;
    else if (token === '--port') flags.port = Number(argv[++i]);
    else if (token === '--workspace') flags.workspace = argv[++i];
    else if (token === '--dry') flags.dry = true;
    else if (token === '--restart') flags.restart = true;
    else if (token === '--help' || token === '-h') flags.help = true;
    else rest.push(token);
  }
  return { flags, rest };
}

async function main() {
  loadEnv();
  // Run data cleanup on boot — old screenshots, audit rotation.
  try { const { runAll } = await import('./src/cleanup.mjs'); runAll(); } catch {}
  const { flags, rest } = parse(process.argv.slice(2));
  const [command, ...args] = rest;

  if (flags.help || !command || command === 'help') return help();

  // Credentials stored by `woboo secret` reach the SDK through the environment.
  loadSecrets();

  switch (command) {
    case 'widget':
    case 'desktop':
      return cmdWidget();
    case 'drive':
      return cmdDrive(args.join(' ').trim(), flags);
    case 'browser':
      return cmdBrowser(args, flags);
    case 'telegram':
      return cmdTelegram();
    case 'memory':
      return cmdMemory(args);
    case 'nim':
      return cmdNim(args);
    case 'secret': {
      const [name, ...value] = args;
      const known = { anthropic: 'anthropicApiKey', telegram: 'telegramToken', nvidia: 'nvidiaApiKey', tavily: 'tavilyApiKey' };
      if (!known[name]) {
        say(red('  usage: woboo secret <anthropic|nvidia|telegram|tavily> <value>'));
        return 2;
      }
      const raw = value.join(' ').trim();
      const stored = saveSecret(known[name], raw || null);
      say(green(`  ${raw ? 'stored' : 'cleared'} ${name}`));
      say(dim(`  ${PATHS.secrets} now holds: ${stored.join(', ') || 'nothing'}`));
      return 0;
    }
    case 'setup': {
      const setup = await import('./src/setup.mjs');
      const result = await setup.run({
        say,
        colors: { bold, dim, green, yellow, cyan, red },
        force: Boolean(flags.force || flags.again),
      });
      return result.ok ? 0 : 1;
    }
    case 'up':
      return cmdUp(flags);
    case 'run':
      return cmdRun(args.join(' ').trim(), flags);
    case 'selftest':
      return cmdSelfTest();
    case 'doctor':
      return cmdDoctor();
    case 'stop':
      say(red(`  STOP engaged: ${guard.engageStop(args.join(' ') || 'owner pressed STOP (cli)')}`));
      say(dim('  release it with `woboo resume`.'));
      return 0;
    case 'resume':
      guard.clearStop();
      say(green('  STOP released.'));
      return 0;
    case 'look':
      return cmdLook();
    case 'log':
      return cmdLog(args[0]);
    case 'set':
      return cmdSet(args[0], args.slice(1).join(' '));
    case 'key':
      say(`  ${cyan(`http://127.0.0.1:${flags.port || loadSettings().port}/?key=${ownerKey()}`)}`);
      say(dim(`  key file: ${PATHS.ownerKey}`));
      return 0;
    default:
      say(red(`  unknown command "${command}"`));
      return help() || 2;
  }
}

main()
  .then((code) => {
    // `up` never resolves; everything else reports through its exit code.
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    say(red(`  ${err.message}`));
    process.exitCode = 1;
  });
