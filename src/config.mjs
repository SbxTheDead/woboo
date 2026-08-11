// Where Woboo keeps its brain-state on disk, and the knobs an owner can turn.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const HOME =
  process.env.WOBOO_HOME || process.env.WOBO_HOME || path.join(os.homedir(), '.woboo');

// Woboo used to keep its state in ~/.wobo. Move it rather than orphan it: the
// owner key, the paired Telegram chat, the secrets and everything Woboo has
// learned about your workspaces all live in there, and silently starting fresh
// would look exactly like amnesia.
(function migrateHome() {
  if (process.env.WOBOO_HOME || process.env.WOBO_HOME) return;
  const old = path.join(os.homedir(), '.wobo');
  try {
    if (fs.existsSync(old) && !fs.existsSync(HOME)) fs.renameSync(old, HOME);
  } catch {
    // A locked file or a cross-device link — Woboo starts fresh rather than
    // refusing to boot, and the old directory is left untouched for the owner.
  }
})();
export const PATHS = {
  home: HOME,
  journal: path.join(HOME, 'journal.jsonl'),
  audit: path.join(HOME, 'audit.jsonl'),
  ownerKey: path.join(HOME, 'owner.key'),
  stop: path.join(HOME, 'STOP'),
  settings: path.join(HOME, 'settings.json'),
  secrets: path.join(HOME, 'secrets.json'),
  shots: path.join(HOME, 'shots'),
  // One snapshot per mission, rewritten after every step transition, so a
  // crashed process leaves behind exactly what was proven and what was not.
  missions: path.join(HOME, 'missions'),
};

const DEFAULTS = {
  port: 4477,
  // Which brain plans: 'auto' (Anthropic, else NIM), 'anthropic', or 'nim'.
  provider: 'auto',
  // Which browser profile Woboo drives. 'own' is a scratch profile it cannot
  // take anything from — safe, but logged in to nothing. 'mine' uses your real
  // Chrome profile, so it acts as you: your Gmail, your sessions, your history.
  browserProfile: 'own',
  // Which of the owner's browser profiles to drive, by directory name. Null
  // means unchosen — Woboo asks rather than guessing, because the wrong
  // profile is the wrong person's inbox.
  chromeProfile: null,
  // How Woboo prefers to work. 'gui' makes it use the real mouse and keyboard
  // wherever a task could plausibly be done on screen — you watch it happen.
  // 'commands' keeps everything invisible and scriptable. 'auto' lets the plan
  // decide from the wording of the task.
  prefer: 'auto',
  // The NIM model that looks at the screen when Woboo drives it. Chosen by
  // benchmark: it read a real desktop correctly and fastest of the candidates.
  nimVisionModel: 'meta/llama-3.2-90b-vision-instruct',
  // The NVIDIA NIM model used when provider resolves to 'nim'.
  nimModel: 'nvidia/nemotron-3-super-120b-a12b',
  // The brain. Opus 5 is the default; effort is the intelligence/cost dial.
  model: 'claude-opus-5',
  effort: 'high',
  // Which installed coding tool Woboo delegates to. 'auto' picks the first found.
  crew: 'auto',
  // How much reach the delegated coding tool gets. 'guarded' briefs it with the
  // most restrictive flags that still let it work (Claude Code: acceptEdits with
  // destructive shell patterns denied; Codex: a workspace-write sandbox). 'full'
  // hands it the owner's whole session — bypassPermissions / danger-full-access.
  crewTrust: 'guarded',
  // Where missions run. null means "wherever woboo was started from".
  workspace: null,
  // How much rope the hands get: 'ask' (owner confirms each act), 'allow', 'off'.
  hands: 'ask',
  // How many times a failed verify may be handed back to the crew.
  maxRepairs: 2,
  // Seconds an approval request waits before it auto-denies.
  approvalTimeout: 120,
  // Extra executables the owner trusts, on top of the built-in allowlist.
  allowCommands: [],
  // The one Telegram chat allowed to drive Woboo. Set by pairing, not by hand.
  telegramChatId: null,
  // Multi-brain routing: 'auto' routes by complexity, 'fixed' uses provider.
  routing: 'auto',
  // Sandbox shell commands for isolation.
  sandbox: false,
  // Skin for the face.
  skin: 'default',
  // TTS voice.
  ttsVoice: 'alloy',
  // Webhooks.
  webhooks: [],
  // MCP servers.
  mcpServers: {},
  // Streaming output in dashboard.
  streaming: true,
  // Parallel step execution.
  parallel: false,
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(PATHS.shots, { recursive: true });
}

export function loadSettings() {
  ensureHome();
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(PATHS.settings, 'utf8'));
  } catch {
    // First run, or a hand-edited file that no longer parses. Defaults are safe.
  }
  return { ...DEFAULTS, ...onDisk };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(PATHS.settings, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// Lock a file to its owner.
//
// POSIX mode bits are theatre on Windows — every file reports 666, chmod only
// toggles the read-only flag, and writeFileSync's mode option applies solely at
// creation. So a file holding API keys looked world-readable no matter what was
// asked for. NTFS is what actually decides, so say it in NTFS: break inheritance
// and grant the current user alone.
//
// In practice %USERPROFILE% is already restricted to its owner, SYSTEM and
// administrators, so this narrows an already-narrow door. It is cheap, and a
// file with a bot token in it deserves the explicit grant.
function harden(file) {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Filesystem refused it; the file is still inside the owner's home.
    }
    return;
  }
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    // /inheritance:r drops inherited ACEs, then grant only this account.
    execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      timeout: 8000,
    });
  } catch {
    // icacls missing, or the path is on a filesystem without ACLs. Nothing is
    // made worse by failing here.
  }
}

// ── secrets ───────────────────────────────────────────────────────────────────
// Credentials live in one 0600 file rather than scattered across environment
// variables, so "set this up once" is a real thing rather than a shell ritual.
// Never settings.json — that file is meant to be readable and hand-editable.

export function loadSecrets() {
  ensureHome();
  let secrets = {};
  try {
    secrets = JSON.parse(fs.readFileSync(PATHS.secrets, 'utf8'));
  } catch {
    // None stored; environment variables may still supply them.
  }
  // The SDK looks at the environment, so put the key where it will be found —
  // without clobbering a key the owner exported deliberately.
  if (secrets.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = secrets.anthropicApiKey;
  }
  return secrets;
}

export function saveSecret(name, value) {
  ensureHome();
  let secrets = {};
  try {
    secrets = JSON.parse(fs.readFileSync(PATHS.secrets, 'utf8'));
  } catch {
    // First secret.
  }
  if (value === null) delete secrets[name];
  else secrets[name] = value;

  // The mode option on writeFileSync only applies when the file is created, so
  // a file that already existed keeps whatever permissions it had — which is how
  // this ended up world-readable despite asking for 0600 every time. Set it
  // explicitly afterwards. On Windows the POSIX bits are largely cosmetic (ACLs
  // on the profile directory do the real work), but it costs nothing and it is
  // correct everywhere else.
  fs.writeFileSync(PATHS.secrets, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  harden(PATHS.secrets);
  return Object.keys(secrets);
}

// The owner lock. One secret, generated once, that every API call must carry.
// Without it a process on this machine could drive Woboo; with it, only you can.
export function ownerKey() {
  ensureHome();
  try {
    const existing = fs.readFileSync(PATHS.ownerKey, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Not minted yet.
  }
  const minted = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(PATHS.ownerKey, `${minted}\n`, { mode: 0o600 });
  return minted;
}


// Loading .env from the current working directory. Lets the owner set
// ANTHROPIC_API_KEY, TAVILY_API_KEY, NVIDIA_API_KEY, TELEGRAM_BOT_TOKEN,
// HTTP_PROXY, HTTPS_PROXY without touching secrets.json.
export function loadEnv() {
  const envPath = process.cwd() + '/.env';
  try {
    const data = fs.readFileSync(envPath, 'utf8');
    for (const line of data.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, raw] = match;
      const value = raw.replace(/^['"]|['"]$/g, '').trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // No .env file — that is fine.
  }
}

// Resolving the proxy URL from environment or settings.
export function resolveProxy() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    loadSettings().proxy ||
    null
  );
}

// Default settings additions for cost tracking and scheduling.
export function applyDefaults(settings) {
  if (settings.totalCost === undefined) settings.totalCost = 0;
  if (!settings.templates) settings.templates = [];
  if (!settings.schedule) settings.schedule = [];
  if (settings.notifications === undefined) settings.notifications = true;
  return settings;
}
