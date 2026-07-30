// Raw script execution for Woboo's *own* vetted scripts — screen capture and
// input synthesis. These bypass the command allowlist on purpose: the scripts
// are fixed strings written here, not text a model produced. They still respect
// STOP, and they are still killed when the halt fires.

import { spawn } from 'node:child_process';
import { assertLive, onStop } from './guard.mjs';

const live = new Set();

onStop(() => {
  for (const child of live) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

export function isWindows() {
  return process.platform === 'win32';
}

// Runs a binary with an argv array — no shell, so nothing in `args` can be
// reinterpreted as syntax. This is how model-authored text reaches the crew
// tools: as a single argument, never as part of a command string.
export function exec(file, args, { timeout = 30_000, action = 'exec', cwd, onOutput } = {}) {
  assertLive(action);

  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn(file, args, { windowsHide: true, cwd });
    live.add(child);

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Raced with a normal exit.
      }
    }, timeout);

    const collect = (chunk) => {
      out += chunk;
      // Long-running crew tools stream progress; surface it as it arrives.
      if (onOutput) {
        try {
          onOutput(chunk);
        } catch {
          // A noisy listener must not kill the child.
        }
      }
      if (out.length > 200_000) out = out.slice(-200_000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      resolve({ ok: code === 0, code, out: out.trim() });
    };

    child.on('error', (err) => {
      out += err.message;
      finish(-1);
    });
    child.on('close', finish);
  });
}

// Runs one of Woboo's own fixed scripts through the platform shell.
export function script(source, opts = {}) {
  // Same UTF-8 pin as shell.mjs: window titles and error text come back through
  // here, and the console codepage would otherwise garble anything non-ASCII.
  const [file, args] = isWindows()
    ? [
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${source}`],
      ]
    : ['/bin/sh', ['-c', source]];
  return exec(file, args, { action: 'script', ...opts });
}
