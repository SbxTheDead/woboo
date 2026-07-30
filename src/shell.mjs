// Running commands is the one capability everything else is built on, so it is
// the one place that must never skip the guard. Nothing in Woboo spawns a child
// process except through here.

import { spawn } from 'node:child_process';
import { clearToRun, onStop, Halted } from './guard.mjs';
import { record } from './journal.mjs';

const live = new Set();

// When STOP is engaged, kill what is already mid-flight. A halt that only
// prevented *future* work would not be worth trusting.
onStop(() => {
  for (const child of live) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

const OUT_LIMIT = 24_000;

function trim(text) {
  if (text.length <= OUT_LIMIT) return text;
  return `${text.slice(0, OUT_LIMIT)}\n… [${text.length - OUT_LIMIT} more characters trimmed]`;
}

// Windows gets PowerShell because that is also what eyes/hands drive; elsewhere
// a POSIX shell. Either way the command string is classified before it runs.
function launcher(cmd) {
  if (process.platform === 'win32') {
    // PowerShell writes in the console's legacy codepage unless told otherwise,
    // which turns any non-ASCII in a tool's output into mojibake. That output is
    // what Woboo hands back to the crew as repair context, so it has to survive
    // the trip. The prefix is a fixed string added after classification.
    return [
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${cmd}`],
    ];
  }
  return ['/bin/sh', ['-c', cmd]];
}

export async function run(cmd, { cwd = process.cwd(), timeout = 600_000, label = '' } = {}) {
  await clearToRun(cmd);

  const started = Date.now();
  record('shell', label ? `${label}: ${cmd}` : cmd, { cwd });

  const [file, args] = launcher(cmd);
  return new Promise((resolve) => {
    let out = '';
    let settled = false;

    const child = spawn(file, args, { cwd, windowsHide: true });
    live.add(child);

    const timer = setTimeout(() => {
      out += `\n… [timed out after ${Math.round(timeout / 1000)}s]`;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited between the timeout firing and the kill.
      }
    }, timeout);

    const collect = (chunk) => {
      out += chunk;
      if (out.length > OUT_LIMIT * 2) out = out.slice(-OUT_LIMIT * 2);
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
      const result = {
        ok: code === 0,
        code,
        out: trim(out.trim()),
        ms: Date.now() - started,
        cmd,
      };
      record('shell', `exit ${code} in ${result.ms}ms`, {
        level: result.ok ? 'ok' : 'error',
      });
      resolve(result);
    };

    child.on('error', (err) => {
      out += `\n${err.message}`;
      finish(-1);
    });
    child.on('close', finish);
  });
}

// Same thing, but a non-zero exit is an exception. Used where a failure means
// the whole mission is over rather than something to repair.
export async function runOrThrow(cmd, opts) {
  const result = await run(cmd, opts);
  if (!result.ok) throw new Error(`command failed (${result.code}): ${cmd}\n${result.out}`);
  return result;
}

export { Halted };
