// The crew: the coding tools already installed on this machine. Woboo does not
// write the code — it briefs one of these, waits, then checks the result.
//
// Instructions reach the tool as a single argv entry, never interpolated into a
// command string, so a spec containing quotes or shell metacharacters is inert.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSettings } from './config.mjs';
import { exec, isWindows } from './ps.mjs';
import { assertLive } from './guard.mjs';
import { record } from './journal.mjs';
import { publish } from './bus.mjs';

// Each driver knows how to run its tool headlessly: one prompt in, work done,
// transcript out. `args` returns the full argv after the binary.
const DRIVERS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    args: (instruction) => ['-p', instruction],
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    args: (instruction) => ['exec', instruction],
  },
};

let cache = null;

// PATH lookup plus the places these tools install themselves when they are not
// on PATH (which is the normal case for a desktop-app install).
function candidatePaths(bin) {
  const home = os.homedir();
  const exts = isWindows() ? ['.cmd', '.exe', '.ps1', ''] : [''];
  const dirs = isWindows()
    ? [
        path.join(process.env.APPDATA || home, 'npm'),
        path.join(process.env.LOCALAPPDATA || home, 'Programs', bin),
        path.join(home, '.local', 'bin'),
        path.join(home, `.${bin}`, 'local'),
      ]
    : [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, `.${bin}`, 'local'),
      ];

  const out = [];
  for (const dir of dirs) {
    for (const ext of exts) out.push(path.join(dir, bin + ext));
  }
  return out;
}

// Finding where a binary lives is inspection, not action — the same class of
// thing as reading the journal, and nothing here runs the tool. It has to keep
// working while STOP is engaged: the widget calls this to render itself, and a
// halt that blocks the status call blocks the very button that releases it.
async function locate(bin) {
  try {
    // Ask the OS first — it knows about PATH, aliases, and shims.
    const probe = isWindows() ? ['where.exe', [bin]] : ['/usr/bin/which', [bin]];
    const found = await exec(probe[0], probe[1], { timeout: 8000, action: 'locate crew' });
    if (found.ok && found.out) {
      const first = found.out.split(/\r?\n/)[0].trim();
      if (first) return first;
    }
  } catch {
    // Halted, or no shell to ask. Fall through to looking on disk, which needs
    // no child process and no permission.
  }
  for (const candidate of candidatePaths(bin)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function discover({ refresh = false } = {}) {
  if (cache && !refresh) return cache;

  const members = [];
  for (const [name, driver] of Object.entries(DRIVERS)) {
    const found = await locate(driver.bin);
    members.push({ name, label: driver.label, bin: driver.bin, path: found, available: Boolean(found) });
  }

  cache = members;
  const ready = members.filter((m) => m.available).map((m) => m.label);
  record('crew', ready.length ? `crew on hand: ${ready.join(', ')}` : 'no coding tool found on this machine', {
    level: ready.length ? 'ok' : 'warn',
  });
  return cache;
}

// Which member a mission should use: the owner's pick, or the first available.
export async function pick() {
  const wanted = loadSettings().crew;
  const members = await discover();
  if (wanted && wanted !== 'auto') {
    return members.find((m) => m.name === wanted && m.available) || null;
  }
  return members.find((m) => m.available) || null;
}

export async function delegate({ instruction, cwd, member, timeout = 900_000, onOutput }) {
  assertLive('delegate');
  const chosen = member || (await pick());
  if (!chosen) {
    return {
      ok: false,
      out: 'No coding tool is installed. Woboo delegates the building — install Claude Code or Codex, then re-run.',
      missing: true,
    };
  }

  const driver = DRIVERS[chosen.name];
  record('crew', `briefing ${chosen.label} (${instruction.length} chars)`, { level: 'info' });
  publish({ type: 'crew', member: chosen.label, state: 'working' });

  const started = Date.now();
  const result = await exec(chosen.path, driver.args(instruction), {
    cwd,
    timeout,
    action: 'delegate',
    onOutput,
  });

  publish({ type: 'crew', member: chosen.label, state: result.ok ? 'done' : 'failed' });
  record('crew', `${chosen.label} exited ${result.code} after ${Math.round((Date.now() - started) / 1000)}s`, {
    level: result.ok ? 'ok' : 'error',
  });

  return { ...result, member: chosen.label, ms: Date.now() - started };
}

export function invalidate() {
  cache = null;
}
