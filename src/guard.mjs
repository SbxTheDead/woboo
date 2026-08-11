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
import { audit } from './audit.mjs';

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
  // Download-and-run, in all the spellings people actually use. `irm ... | iex`
  // is the canonical PowerShell one-liner and was missing, so it came through as
  // a merely-unfamiliar command the owner could wave past.
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sh|bash|iex|Invoke-Expression)/i, 'pipe-to-shell'],
  // Running a string as code, whatever built it. There is no task that needs
  // this and every injection attempt wants it.
  [/(^|[\s;|(])(iex|Invoke-Expression)\b/i, 'executing a string as code'],
  // Base64 hides the payload from this classifier, and decoding-then-
  // classifying is exactly the hole the encoding exists to open. PowerShell
  // takes any unambiguous prefix of -EncodedCommand (-e, -ec, -enc ...), so a
  // base64-looking argument after any of them is refused without decoding.
  [/(?:^|\s)-(?:e|ec|en|enc\w*)\s+[A-Za-z0-9+/=]{16,}/i, 'encoded command'],
  // cmd /c hands a whole second command line to a shell this classifier never
  // sees: quoting makes the inner segment boundaries unreliable, so the inner
  // command would escape classification. Woboo's launcher is PowerShell and
  // never needs the legacy shell, so the wrapper itself is refused rather
  // than unwrapped — even when the inner command would have been innocent.
  [/\bcmd(?:\.exe)?\s+\/[ck]\b/i, 'cmd wrapper'],
  // Compiling C# from a string at the prompt. Add-Type with -Path or
  // -AssemblyName has legitimate uses and only has to ask; -TypeDefinition
  // and -MemberDefinition (P/Invoke) are pure code execution.
  [/\bAdd-Type\b[^\n]*\s-(TypeDefinition|MemberDefinition)\b/i, 'compiling inline C#'],
  // Living off the land: signed Microsoft binaries whose whole purpose here is
  // running attacker code under a trusted signature. rundll32, regsvr32 and
  // mshta proxy script execution; the script hosts run .vbs/.js. None of them
  // builds, tests or commits anything.
  [/\b(rundll32|regsvr32|mshta)(\.exe)?\b/i, 'proxy execution'],
  [/\b(wscript|cscript)(\.exe)?\b/i, 'script host'],
  // Dual-use tools refused only in their weaponised spellings: certutil
  // downloading or writing binaries, BITS moving a file, WMI spawning a
  // process. Every other use still has to come and ask.
  [/\bcertutil\b[^\n]*\s-(urlcache|decode)\b/i, 'certutil download or decode'],
  [/\bbitsadmin\b[^\n]*\s\/(transfer|create|addfile)\b/i, 'BITS transfer'],
  [/\bwmic\b[^\n]*\bprocess\s+call\s+create\b/i, 'WMI process creation'],
  [/\breg\s+(add|delete)\b/i, 'registry write'],
  [/\bnetsh\b/i, 'network reconfiguration'],
  [/\b(takeown|icacls|chmod\s+777)\b/i, 'permission change'],
];

// The state directory holds settings.json (the allowlist itself), the owner
// key, the secrets and the STOP latch. A shell write into it — however
// allowlisted the verb doing the writing — is the agent editing its own
// permissions. The owner may legitimately want that done by a mission, so the
// answer is not "never" but "stop and ask, loudly, and audit the answer".
// Matched in every spelling: `~/.woboo`, the expanded absolute path, the
// environment-variable forms `$env:USERPROFILE\.woboo` and `$HOME/.woboo`,
// either separator, any case (Windows paths are case-insensitive and
// PowerShell takes both slashes).
const STATE_DIR = new RegExp(
  `(?:${[PATHS.home, PATHS.home.replace(/\\/g, '/'), '~/.woboo', '~\\.woboo']
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')}|\\$env:USERPROFILE[/\\\\]\\.woboo|\\$HOME[/\\\\]\\.woboo)(?=[/\\\\]|$)`,
  'i'
);
// Verbs that put bytes in a file and are on the allowlist, plus redirection,
// which rides on any verb at all (`echo ... > settings.json`).
const STATE_WRITE = /\b(set-content|out-file)\b|>>?/i;
// The files a self-configuration write must name out loud: the allowlist
// itself, the secrets, the owner key, and anything that smells like policy.
const STATE_FILE = /settings\.json|secrets\.json|owner\.key|[\w.-]*(allowlist|policy)[\w.-]*/i;

export function classifyCommand(raw) {
  const cmd = String(raw || '').trim();
  if (!cmd) return { verdict: 'deny', reason: 'empty command' };

  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(cmd)) return { verdict: 'deny', reason: `refused (${why})` };
  }

  if (STATE_WRITE.test(cmd) && STATE_DIR.test(cmd)) {
    // Self-configuration: ask, never silently allow and never silently deny.
    // The sensitive files get named so the owner knows exactly which door is
    // being knocked on; clearToRun audits the ask and the answer.
    const target = cmd.match(STATE_FILE)?.[0];
    const reason = target
      ? `wants to modify ${target} — Woboo's own configuration — needs your explicit approval`
      : `wants to modify Woboo's own configuration (${PATHS.home}) — needs your explicit approval`;
    return { verdict: 'ask', reason, selfConfig: true };
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
    // A type literal driving a static method — [System.IO.File]::WriteAllText,
    // [System.Diagnostics.Process]::Start — executes with no cmdlet verb at
    // all, so there is nothing for the allowlist to say yes or no to. It is
    // the same class of hole as `iex`: no legitimate task needs it and every
    // bypass wants it, so deny rather than ask. The whole segment is checked,
    // not just the first token: PowerShell tolerates whitespace before the
    // `::` ([Type] ::Method), and a variable holding a type ($t::Start) is the
    // same invocation wearing a name. Any spelling of the type matches —
    // [Diagnostics.Process], lowercase — because only the shape is tested.
    // Casts and indexing without the `::` — [char]65, [int]$x, $x[0] — run
    // nothing and fall through.
    if (/^\[[\w.]+\]\s*::/.test(segment) || /^\$[\w.]+\s*::/.test(segment)) {
      return { verdict: 'deny', reason: 'refused (type-static method invocation)' };
    }
    // Variables, switches, quoted literals, numbers, casts, array indexing.
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
      // Every resolution lands here — the API, Telegram, a timeout, the STOP
      // latch all settle through this one function — so this is the one place
      // the audit log has to be written to catch them all.
      audit('approval', `${kind} — ${detail}`, granted ? 'allowed' : `denied${note ? ` (${note})` : ''}`);
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
  const { verdict, reason, selfConfig } = classifyCommand(cmd);
  if (verdict === 'allow') return true;
  if (verdict === 'deny') throw new Refused(`${reason}: ${cmd}`);
  // A knock on Woboo's own configuration is audited when it is asked; the
  // owner's answer is audited by requestApproval's settle.
  if (selfConfig) audit('self-config write', cmd, 'asked');
  const granted = await requestApproval({ kind: 'run command', detail: cmd, reason });
  if (!granted) throw new Refused(`owner declined: ${cmd}`);
  return true;
}
