// The thing that makes Woboo safe to hand a keyboard to.
//
// Three parts:
//   STOP      a latch that outlives the process. While engaged, nothing acts.
//   allowlist commands are classified before they run, never after.
//   approvals anything ambiguous stops and waits for the owner, then times out
//             into a denial rather than hanging forever.
//
// This is the software mirror of the physical STOP button on the hardware Woboo:
// one gesture that cuts input and halts work, and that the agent cannot undo.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { PATHS, loadSettings, ensureHome } from './config.mjs';
import { publish } from './bus.mjs';
import { record } from './journal.mjs';

export class Halted extends Error {
  constructor(reason) {
    super(reason || 'stopped by owner');
    this.name = 'Halted';
  }
}

export class Refused extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'Refused';
  }
}

const stopListeners = new Set();

export function onStop(fn) {
  stopListeners.add(fn);
  return () => stopListeners.delete(fn);
}

export function isStopped() {
  ensureHome();
  return fs.existsSync(PATHS.stop);
}

export function stopReason() {
  try {
    return fs.readFileSync(PATHS.stop, 'utf8').trim();
  } catch {
    return '';
  }
}

export function engageStop(reason = 'owner pressed STOP') {
  ensureHome();
  fs.writeFileSync(PATHS.stop, `${reason}\n`);
  record('stop', reason, { level: 'error' });
  publish({ type: 'guard', stopped: true, reason });
  // Deny everything already queued, then let subscribers kill their children.
  for (const [, pending] of approvals) pending.settle('deny', 'STOP engaged');
  for (const fn of stopListeners) {
    try {
      fn(reason);
    } catch {
      // A listener that throws must not block the rest of the halt.
    }
  }
  return reason;
}

export function clearStop() {
  ensureHome();
  try {
    fs.unlinkSync(PATHS.stop);
  } catch {
    // Already clear.
  }
  record('resume', 'STOP released by owner');
  publish({ type: 'guard', stopped: false, reason: '' });
}

export function assertLive(action) {
  if (isStopped()) throw new Halted(`${action} blocked: ${stopReason() || 'STOP engaged'}`);
}

// ── command classification ────────────────────────────────────────────────────
// Woboo runs builds, tests, and version control. It does not need to run
// anything else, so the default posture is: known-good verb, or ask.

const ALLOWED = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'git',
  'go', 'cargo', 'dotnet', 'mvn', 'gradle',
  'python', 'python3', 'py', 'pip', 'pytest', 'ruff', 'uv',
  'jest', 'vitest', 'tsc', 'eslint', 'prettier', 'make',
  'echo', 'where', 'which', 'dir', 'ls', 'cat', 'type',
  // Reading paths, and creating them. Deletion is deliberately absent: the
  // FORBIDDEN patterns below refuse recursive removal outright, and anything
  // else destructive still has to come and ask.
  'mkdir', 'test-path', 'new-item', 'get-content', 'get-childitem', 'get-item',
  'join-path', 'resolve-path', 'select-string', 'out-file', 'set-content',
  'get-date', 'measure-object', 'select-object', 'where-object', 'sort-object',
  'foreach-object', 'convertto-json', 'convertfrom-json', 'write-output',
]);

// PowerShell control flow and operators. Skipped when hunting for the verb —
// they are the sentence's grammar, not its verb. Deliberately does not include
// anything that runs something: no `&`, no `.`, no Invoke-Expression.
const KEYWORDS = new Set([
  'if', 'else', 'elseif', 'switch', 'foreach', 'for', 'while', 'do', 'until',
  'try', 'catch', 'finally', 'begin', 'process', 'end', 'return', 'exit',
  'break', 'continue', 'param', 'function', 'not', 'in', 'then', 'fi', 'esac',
]);

// Patterns that are never worth asking about. Ordered roughly by how bad.
const FORBIDDEN = [
  [/\brm\s+-{1,2}[a-z]*[rf]/i, 'recursive delete'],
  [/\bRemove-Item\b[^\n]*-Recurse/i, 'recursive delete'],
  [/\bdel\s+\/[sq]/i, 'recursive delete'],
  [/\b(format|mkfs|diskpart)\b/i, 'disk formatting'],
  [/\b(shutdown|Restart-Computer|Stop-Computer|reboot)\b/i, 'power control'],
  [/\bgit\s+push\b[^\n]*--force/i, 'force push'],
  [/\bgit\s+reset\b[^\n]*--hard/i, 'hard reset'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sh|bash|iex|Invoke-Expression)/i, 'pipe-to-shell'],
  [/\breg\s+(add|delete)\b/i, 'registry write'],
  [/\bnetsh\b/i, 'network reconfiguration'],
  [/\b(takeown|icacls|chmod\s+777)\b/i, 'permission change'],
];

export function classifyCommand(raw) {
  const cmd = String(raw || '').trim();
  if (!cmd) return { verdict: 'deny', reason: 'empty command' };

  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(cmd)) return { verdict: 'deny', reason: `refused (${why})` };
  }

  const settings = loadSettings();
  const trusted = new Set([...ALLOWED, ...(settings.allowCommands || [])]);

  // Every place a command can start has to clear the bar on its own, otherwise
  // `npm test && <anything>` rides in on the first verb. Braces and parens count
  // as separators too: PowerShell control flow puts real commands inside them,
  // and a check that only ever looked at the first token would see `if` and wave
  // through whatever the block contained.
  const segments = cmd
    .split(/&&|\|\||[;|(){}\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const verb = (segment.match(/^"?([^\s"]+)"?/) || [])[1] || '';
    const bare = verb.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

    // Language, not commands: keywords, variables, operators, literals. These
    // cannot execute anything by themselves — whatever they guard or compare is
    // its own segment and gets classified on its own merits.
    if (!bare) continue;
    if (KEYWORDS.has(bare)) continue;
    // Variables, switches, quoted literals, numbers, array indexing.
    if (/^[$\-'"[\d]/.test(bare)) continue;
    // Property or method access such as `.Length`. A bare `.` is NOT skipped:
    // on its own it is PowerShell's dot-source operator, which runs a script.
    if (/^\.\w/.test(bare)) continue;

    if (!trusted.has(bare)) {
      return { verdict: 'ask', reason: `"${bare}" is not on the allowlist`, verb: bare };
    }
  }
  return { verdict: 'allow', reason: 'allowlisted' };
}

// ── owner approvals ───────────────────────────────────────────────────────────

const approvals = new Map();

export function pendingApprovals() {
  return [...approvals.values()].map(({ request }) => request);
}

export function requestApproval({ kind, detail, reason = '' }) {
  assertLive(kind);
  const settings = loadSettings();
  const id = crypto.randomBytes(6).toString('hex');
  const request = { id, kind, detail, reason, asked: Date.now(), timeout: settings.approvalTimeout };

  record('approval', `asking owner: ${kind} — ${detail}`, { level: 'warn' });

  return new Promise((resolve) => {
    let done = false;
    const settle = (decision, note = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      approvals.delete(id);
      const granted = decision === 'allow';
      record('approval', `owner ${granted ? 'allowed' : 'denied'}: ${kind}${note ? ` (${note})` : ''}`, {
        level: granted ? 'ok' : 'error',
      });
      publish({ type: 'approval:resolved', id, decision, note });
      resolve(granted);
    };

    const timer = setTimeout(() => settle('deny', 'timed out'), settings.approvalTimeout * 1000);
    // Never let a stuck approval keep the process alive.
    if (typeof timer.unref === 'function') timer.unref();

    approvals.set(id, { request, settle });
    publish({ type: 'approval', request });
  });
}

export function resolveApproval(id, decision) {
  const pending = approvals.get(id);
  if (!pending) return false;
  pending.settle(decision === 'allow' ? 'allow' : 'deny');
  return true;
}

// Convenience used by shell/hands: classify, then ask only if needed.
export async function clearToRun(cmd) {
  assertLive('command');
  const { verdict, reason } = classifyCommand(cmd);
  if (verdict === 'allow') return true;
  if (verdict === 'deny') throw new Refused(`${reason}: ${cmd}`);
  const granted = await requestApproval({ kind: 'run command', detail: cmd, reason });
  if (!granted) throw new Refused(`owner declined: ${cmd}`);
  return true;
}
