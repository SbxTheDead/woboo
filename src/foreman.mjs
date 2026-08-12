// Foreman mode — the part that makes Woboo a workmate instead of a typist.
//
//   intake → plan → delegate → verify → repair → report
//
// The loop that matters is verify/repair. Most tools stop at "I wrote the code."
// Woboo runs the check, and when the check fails it hands the concrete error back
// to the crew and tries again. A step is only "done" when a command said so.

import crypto from 'node:crypto';
import { loadSettings } from './config.mjs';
import { publish } from './bus.mjs';
import { record } from './journal.mjs';
import { save as saveMission, load as loadMission } from './missions.mjs';
import { emit } from './plugins.mjs';
import { snapshot as takeSnapshot, rollback } from './snapshot.mjs';
import { setFace } from './face.mjs';
import { assertLive, isStopped, stopReason, Halted, Refused } from './guard.mjs';
import * as brain from './brain.mjs';
import * as crew from './crew.mjs';
import * as eyes from './eyes.mjs';
import * as pilot from './pilot.mjs';
import * as memory from './memory.mjs';
import * as scribe from './scribe.mjs';
import * as research from './research.mjs';
import * as webpilot from './webpilot.mjs';
import * as acceptance from './acceptance.mjs';
import { route as reachRoute } from './capabilities.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './shell.mjs';

// What a step is allowed to answer, and the only two ways to build it.
//
// runStep used to return a bare boolean, and one refusal path returned
// `{ ok: false, out }` — a truthy object, so a step that had refused to run
// was read as a success and the mission reported done. The contract is now an
// explicit `{ success: boolean, error?, data? }`, built here and nowhere else,
// so no call site can hand-roll a truthy failure again.
export function ok(data) {
  return data === undefined ? { success: true } : { success: true, data };
}

export function fail(error, data) {
  const result = { success: false, error: String(error || 'step failed') };
  if (data !== undefined) result.data = data;
  return result;
}

// Belt-and-braces for the same bug class. Everything leaving runStep passes
// through here, and a value that is not the strict shape can only become a
// failure — never a truthy pass — and is journaled, because a malformed
// result means a code path somewhere is answering a question it was not asked.
export function asStepResult(value) {
  if (value && typeof value === 'object' && typeof value.success === 'boolean') return value;
  record('step', 'a step produced a malformed result — failing closed', { level: 'error' });
  return fail('internal: malformed step result');
}

let mission = null;

// The files this mission has actually produced.
//
// A research step names its own document from the topic it researched — the
// planner cannot know in advance that it will be called
// how-to-become-a-cloud-engineer-skills-certificatio.pdf. It guessed
// cloud_engineer_guide.pdf, the step that was meant to send that PDF looked for
// a name nothing had created, and a perfectly good three-page document sat on
// disk while the mission reported failure.
let artifacts = [];

// What the steps of this mission have actually found out.
//
// A "web" step reads pages and reports what it saw. That report was logged and
// then dropped, so a later "compose" step -- asked to write a document from the
// gathered material -- had nothing, fell back to globbing the workspace, and
// produced a confident PDF about package-lock.json. Findings travel forward now.
let findings = [];
let running = false;

export function currentMission() {
  return mission;
}

export function isBusy() {
  return running;
}

function snapshot() {
  publish({ type: 'mission', mission });
  return mission;
}

function setStep(index, patch) {
  mission.steps[index] = { ...mission.steps[index], ...patch };
  snapshot();
}

export async function runMission(task, { workspace } = {}) {
  if (running) throw new Error('Woboo is already on a mission. Let it finish, or press STOP.');
  assertLive('mission');

  const settings = loadSettings();
  const cwd = workspace || settings.workspace || process.cwd();

  findings = [];
  artifacts = [];
  mission = {
    id: crypto.randomBytes(5).toString('hex'),
    task,
    workspace: cwd,
    summary: '',
    steps: [],
    state: 'planning',
    startedAt: Date.now(),
    endedAt: null,
    offline: false,
    crew: null,
    report: '',
  };
  running = true;

  record('mission', `new task: ${task}`, { level: 'ok', missionId: mission.id });
  setFace('listening', 'taking the task');
  snapshot();

  try {
    const member = await crew.pick();
    mission.crew = member ? member.label : null;

    // ── plan ────────────────────────────────────────────────────────────────
    setFace('thinking', 'working out the steps');
    // Everything Woboo learned here before rides into the plan. First mission in
    // a new workspace this is empty and costs nothing.
    const remembered = memory.recall(cwd);
    if (remembered) record('memory', `recalled ${remembered.split('\n').length} line(s) about this workspace`);

    let plan;
    if (brain.hasCredentials()) {
      try {
        plan = await brain.plan({ task, workspace: cwd, crew: mission.crew, memory: remembered });
      } catch (err) {
        // A brain that is unreachable or declines should not end the mission —
        // fall back to the deterministic plan and say so.
        record('brain', `planning failed: ${err.message}`, { level: 'error' });
        // The deterministic fallback is only useful when there is a crew tool to
        // hand the whole task to. Without one it can do nothing real, and
        // running its placeholder step would report success for untouched work.
        plan = mission.crew
          ? brain.offlinePlan({
              task,
              workspace: cwd,
              crew: mission.crew,
              reason: `the brain was unreachable: ${err.message.slice(0, 90)}`,
            })
          : brain.unplannable({ task, reason: err.message });
      }
    } else {
      plan = brain.offlinePlan({ task, workspace: cwd, crew: mission.crew });
    }

    // No plan means no mission. Fail here rather than running a placeholder and
    // calling it done.
    if (plan.unplanned) {
      mission.summary = plan.summary;
      mission.state = 'failed';
      mission.report =
        `Couldn't reach the brain, so nothing was planned or done — ${plan.reason}. ` +
        `Your task is unchanged; try it again.`;
      setFace('error', 'could not reach the brain');
      record('mission', mission.report, { level: 'error' });
      snapshot();
      return mission;
    }

    mission.summary = plan.summary;
    mission.offline = Boolean(plan.offline);
    mission.steps = plan.steps.map((step, i) => ({
      i,
      title: step.title,
      kind: step.kind,
      instruction: step.instruction,
      // The exact body a write step puts on disk. Cherry-picking the step fields
      // here silently dropped it, so every write step wrote an empty file.
      content: typeof step.content === 'string' ? step.content : '',
      verify: step.verify || '',
      status: 'pending',
      attempts: 0,
      output: '',
      verifyOutput: '',
      ms: 0,
    }));
    mission.state = 'running';

    // Say what was understood before doing any of it. A misunderstanding is
    // cheap to correct now and expensive to discover in the finished work — and
    // the owner cannot correct one they were never shown.
    const grasp = plan.understanding;
    if (grasp) {
      mission.understanding = grasp;
      record('mission', `what you want: ${grasp.asking_for}`, { level: 'info' });
      for (const item of grasp.deliverables || []) record('mission', `  • ${item}`, { level: 'info' });
      if (grasp.done_when) record('mission', `done when: ${grasp.done_when}`, { level: 'info' });
      for (const care of grasp.care_about || []) record('mission', `  ⚠ ${care}`, { level: 'warn' });
    }
    record('mission', `plan: ${plan.summary}`, { level: 'info' });
    snapshot();

    // ── execute ─────────────────────────────────────────────────────────────
    for (let i = 0; i < mission.steps.length; i += 1) {
      assertLive('step');
      const result = await runStep(i, { cwd, member, task });
      // Strict comparison, on purpose: anything that is not an explicit
      // success fails the mission closed rather than passing on truthiness.
      if (result.success !== true) {
        mission.state = 'failed';
        mission.report = `Stopped at step ${i + 1}: ${mission.steps[i].title}`;
        setFace('error', mission.steps[i].title);
        break;
      }
    }

    if (mission.state === 'running') {
      // Every step ran. That is not the same as the owner having what they
      // asked for, and treating it as the same is how a PDF about
      // package-lock.json got reported as a finished piece of research.
      const checked = mission.steps.filter((s) => s.verify).length;
      const ran = checked
        ? `All ${mission.steps.length} steps done, ${checked} proven by a command.`
        : `All ${mission.steps.length} steps done.`;

      // What "done" has to look like depends on the kind of mission: "restart
      // the browser" owes verified commands and no files, a research mission
      // owes a report. Categorize first, then judge shortfalls against that.
      mission.category = acceptance.categorize(mission);
      let shortfall = acceptance.obviousShortfall(artifacts, mission.understanding?.deliverables, {
        category: mission.category,
        steps: mission.steps,
      });
      let verdicts = [];

      // A pure file operation proven by its own command verify does not go to
      // the model judge — the command already said so, and the judge, shown a
      // faithful copy of an empty file, will call it "not an exact copy". The
      // judge stays for authored content, where being shown the wrong subject
      // is exactly the failure it exists to catch.
      const provenByCommand = acceptance.provenByCommands(mission);
      // An operation mission — list, count, show, run the tests — owes verified
      // commands and no file. Its steps have each passed their own check; the
      // model judge only ever sees files and step outputs, so with no file to
      // look at it invents a delivery nobody asked for — "the owner did not
      // receive a file" for "tell me how many files are on the desktop". The
      // commands already answered the question.
      // A browser mission is judged the same way: its proof is the web step
      // having read the answer, and the model judge — which only ever sees files
      // and step outputs — fails "tell me the first paragraph" for not
      // delivering the paragraph "in any file or final output", though the
      // browser read it and it sits in the step's own output. When the cheap
      // check already passed for an operation or a browser mission, the judge
      // adds nothing but misfires.
      const stepsProvenCategory =
        (mission.category === 'operation' || mission.category === 'browser') && !shortfall;
      const skipJudge = provenByCommand || stepsProvenCategory;
      if (skipJudge) {
        record(
          'accept',
          provenByCommand
            ? 'a file operation proven by its command check — no second opinion needed'
            : `a ${mission.category} mission proven by its steps — no second opinion needed`,
          { level: 'ok' },
        );
      }
      if (!shortfall && !skipJudge && mission.understanding && brain.hasCredentials()) {
        setFace('testing', 'checking it is what you asked for');
        try {
          const result = await acceptance.check({
            understanding: mission.understanding,
            steps: mission.steps,
            artifacts,
            ask: brain.ask,
          });
          verdicts = result.verdicts || [];
          if (result.checked && !result.met) shortfall = result.shortfall || 'not everything asked for was produced';
        } catch (err) {
          // A checker that cannot run must not turn finished work into a
          // failure. Say it could not be checked and leave the verdict alone.
          record('accept', `could not check the deliverables (${err.message})`, { level: 'warn' });
        }
      }

      mission.verdicts = verdicts;
      if (shortfall) {
        mission.state = 'failed';
        mission.report = `${ran} But you did not get what you asked for: ${shortfall}`;
        setFace('confused', 'not what was asked for');
        record('mission', mission.report, { level: 'error' });
      } else {
        mission.state = 'done';
        mission.report = verdicts.length
          ? `${ran} ${verdicts.length} deliverable(s) checked against what you asked for.`
          : ran;
        setFace('happy', 'mission complete');
        record('mission', mission.report, { level: 'ok' });
      }
    }
  } catch (err) {
    if (err instanceof Halted) {
      mission.state = 'stopped';
      mission.report = stopReason() || 'stopped by owner';
      setFace('stopped', mission.report);
      record('mission', `halted: ${mission.report}`, { level: 'error' });
    } else {
      mission.state = 'failed';
      mission.report = err instanceof Refused ? err.message : `${err.message}`;
      setFace('error', mission.report);
      record('mission', `failed: ${mission.report}`, { level: 'error' });
    }
  } finally {
    mission.endedAt = Date.now();
    running = false;
    // Whatever happened, it is worth knowing next time — including the failures,
    // which are the entries that stop Woboo repeating itself.
    try {
      memory.learnFromMission(cwd, mission);
    } catch (err) {
      record('memory', `could not write memory: ${err.message}`, { level: 'warn' });
    }
    snapshot();
  }

  return mission;
}

// A verify is judged only by its exit code, and PowerShell hands out 0 for a
// bare expression whatever it evaluates to — `Test-Path 'missing'` prints False
// and exits 0. That is a check which cannot fail, which is worse than no check
// at all: it makes Woboo confidently report proven work that was never proven.
//
// Planners are told to branch explicitly, and mostly do. This is the backstop
// for when they don't. Commands that already set an exit code (npm, git, tsc,
// anything containing its own `exit`) are left exactly as written, so their
// output still reaches the repair loop intact.
const SETS_OWN_EXIT =
  /^\s*(npm|npx|pnpm|yarn|bun|deno|node|git|go|cargo|dotnet|mvn|gradle|python3?|py|pip|pytest|ruff|uv|jest|vitest|tsc|eslint|prettier|make)\b/i;

// Paths that came through JSON with their separators doubled.
//
// The planner emitted `Test-Path 'D:\\wobo\\tmp'`. In a single-quoted PowerShell
// string a backslash is literal, so that is a path with doubled separators —
// which Windows sometimes tolerates and sometimes does not, and which is never
// what was meant. It is an artefact of the plan travelling as JSON, so it is
// fixed here rather than asked for politely in a prompt.
export function unescapePaths(command) {
  return String(command || '')
    // Windows PowerShell's Join-Path takes exactly two path parts — a third is a
    // parse error ("A positional parameter cannot be found that accepts argument
    // 'hello-world.html'"). The planner writes the natural three-part form for a
    // nested path; nest it into two-part calls so it runs. Only -AdditionalChildPath
    // in PowerShell 7 accepts more, and this machine runs 5.1.
    .replace(
      /\bJoin-Path\s+(\$env:\w+|'[^']*'|"[^"]*"|[^\s'"()]+)\s+('[^']*'|"[^"]*"|[^\s'"()]+)\s+('[^']*'|"[^"]*"|[^\s'"()]+)/gi,
      'Join-Path (Join-Path $1 $2) $3',
    )
    // A drive letter with no separator after it — D:wobo\file.txt — is a
    // dropped backslash, not a drive-relative path. The model meant
    // D:\wobo\file.txt; PowerShell reads D:wobo as "wobo, relative to drive D's
    // current directory", so from D:\wobo it resolves to D:\wobo\wobo\file.txt
    // and the write lands nowhere. Restore the separator. The lookbehind spares
    // multi-letter PowerShell drives (Env:, Variable:, HKLM:) — only a single
    // letter standing on its own is a filesystem drive — and the lookahead
    // spares a drive already followed by a separator (C:\Users).
    .replace(/(?<![A-Za-z])([A-Za-z]:)(?=[A-Za-z0-9_.\-])/g, '$1\\')
    // Fix doubled backslashes from JSON: 'D:\\\\woboo' -> 'D:\\woboo'
    .replace(/'([^']*)'/g, (whole, inner) =>
      /[A-Za-z]:\\\\|\\\\\w/.test(inner) ? `'${inner.replace(/\\{2,}/g, '\\')}'` : whole,
    )
    // Single-quoted paths containing $env: or $variable — PowerShell does not expand
    // variables inside single quotes, so '& '$env:TEMP\\installer.exe' tries to run a
    // file literally called "$env:TEMP". Switch to double quotes so the variable resolves.
    // Also fix forward slashes to backslashes inside those paths.
    .replace(/'([^']*)'/g, (whole, inner) => {
      if (/\$env:|\$[A-Z_]+/i.test(inner) && /[\/]/.test(inner)) {
        const fixed = inner.replace(/\//g, '\\');
        return `"${fixed}"`;
      }
      if (/\$env:|\$[A-Z_]+/i.test(inner)) {
        return `"${inner}"`;
      }
      return whole;
    })
    // Forward slashes in paths that are NOT inside quotes: $env:TEMP/installer.exe
    // Only fix when it looks like a path (contains a dot or extension after the slash).
    .replace(/(\$env:\w+|\$[A-Z_]+)(\/[\w.]+)/gi, (whole, variable, rest) =>
      variable + rest.replace(/\//g, '\\'),
    );
}

// The file that was actually produced, when the plan named one that was not.
//
// A step that writes a document names it after its own content — a research
// step wrote internship-opportunities-in-china-for-rayane-sbaac.pdf — while the
// plan, written before any of it existed, guessed internships.pdf. Three
// separate places now need the same answer: reading a file, sending one, and
// checking one. Guessing is the planner's job; knowing is this function's.
export function orArtifact(named, produced = artifacts) {
  if (!named || fs.existsSync(named)) return named;
  const wanted = path.extname(named).toLowerCase();
  const made = produced.filter((f) => path.extname(f).toLowerCase() === wanted && fs.existsSync(f));
  if (!made.length) return named;
  const chosen = made[made.length - 1];
  record('step', `using ${path.basename(chosen)} — the file an earlier step actually produced`, { level: 'warn' });
  return chosen;
}

// The files a shell step actually produced.
//
// `artifacts` was only ever filled by the steps that hand back the file they
// wrote — research, compose, read. A shell step hands back an exit code and
// nothing else, so "create five empty text files" created five files, proved it
// with a command that exited 0, and was then reported as a failure: the
// acceptance check looked at an empty artifact list and said no file was
// produced at all. The files were on the desktop the whole time. Nothing had
// asked the disk.
//
// The command names them, so read the names out of the command and keep the
// ones that are on disk and were written while this step was running. Anything
// merely read, or deleted, or named by a plan and never created, fails one of
// those two tests and is left out.
//
// PowerShell interpolation cannot be resolved from here — file$_.txt is five
// filenames the shell knew and this does not — so an environment variable is
// looked up, any other $variable becomes a wildcard, and the directory listing
// answers the question instead.
function resolveVariables(token) {
  return token
    .replace(/\$env:(\w+)/gi, (whole, name) => process.env[name] ?? whole)
    .replace(/%(\w+)%/g, (whole, name) => process.env[name] ?? whole)
    .replace(/\$\{[^}]*\}|\$\w+|\$_/g, '*');
}

// Only the last segment may be a wildcard: a listing needs a real directory to
// list. `file*.txt` is answered; `*/report.txt` is not, and is left alone.
function expandWildcard(full) {
  const dir = path.dirname(full);
  const name = path.basename(full);
  if (dir.includes('*')) return [];
  const pattern = new RegExp(`^${name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => pattern.test(entry))
      .map((entry) => path.join(dir, entry));
  } catch {
    // The directory does not exist, so neither do the files it would hold.
    return [];
  }
}

const LOOKS_LIKE_A_FILE = /\.[A-Za-z0-9]{1,6}$/;
const TOKENS = /'([^']*)'|"([^"]*)"|([^\s;,()|&<>'"]+)/g;

export function filesTouched(command, cwd, since = 0) {
  const text = String(command || '');
  const found = [];
  const seen = new Set();

  // Directories the command names through an environment variable. A file
  // written with `Join-Path $env:TEMP 'woboo_test.txt'` lives in TEMP, but the
  // filename literal on its own resolves against cwd and the file is missed —
  // so the directories those variables point at are candidate homes too.
  const bases = [cwd];
  for (const m of text.matchAll(/\$env:(\w+)|%(\w+)%/gi)) {
    const dir = process.env[m[1] || m[2]];
    try {
      if (dir && fs.statSync(dir).isDirectory() && !bases.includes(dir)) bases.push(dir);
    } catch {
      // The variable is unset or not a directory — nothing to add.
    }
  }

  for (const match of text.matchAll(TOKENS)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim().replace(/^[`~]+/, '');
    if (!raw || !LOOKS_LIKE_A_FILE.test(raw)) continue;

    const token = resolveVariables(raw);
    const expanded = [];
    for (const base of bases) {
      let full;
      try {
        full = path.resolve(base, token);
      } catch {
        continue;
      }
      for (const c of full.includes('*') ? expandWildcard(full) : [full]) expanded.push(c);
      // An absolute token ignores the base, so trying more bases is wasted.
      if (path.isAbsolute(token)) break;
    }

    for (const candidate of expanded) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const stat = fs.statSync(candidate);
        // The newest of the three, because no single one survives every way a
        // step can produce a file. Windows preserves a file's LastWriteTime
        // through a rename and a copy, so a renamed file keeps the mtime it was
        // born with — 22:46, long before a step that renames it at 22:48 — and
        // the mtime gate threw it away as "not mine". The change-time does move
        // on a rename, and a copy gets a fresh birth-time; a command that only
        // *reads* a file moves none of them, so the gate still refuses to claim
        // what was merely read. The tolerance covers a filesystem whose idea of
        // "now" is coarser than ours.
        const touched = Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs || 0);
        if (stat.isFile() && touched >= since - 2000) found.push(candidate);
      } catch {
        // Named but not on disk: a file that was deleted, or one the plan
        // guessed at and nothing ever wrote. Neither is an artifact.
      }
    }
    // A command that names a hundred files is a listing, not a delivery.
    if (found.length >= 50) break;
  }
  return found;
}

// The command inside the explanation, if the model wrapped one in prose.
//
// A repair came back as "Use a properly escaped single-quoted string with
// backtick-n for newlines: powershell -Command ..." and was executed verbatim,
// so the shell tried to run the word "Use". Returning the original unchanged is
// better than running an English sentence — at least the failure is the one
// already diagnosed rather than a new and stranger one.
const COMMAND_START =
  /^\s*(?:[$&.\\/]|[A-Za-z]:|if\b|foreach\b|try\b|npm\b|npx\b|node\b|git\b|py(?:thon3?)?\b|pip\b|dotnet\b|cargo\b|go\b|make\b|[A-Z][a-z]+-[A-Z][a-z]+\b|[a-z][\w.-]*\s+[-\w])/;

export function stripAdvice(instruction) {
  const text = String(instruction || '').trim();
  if (!text || COMMAND_START.test(text)) return text;

  // Prose first, command after a colon or on a later line.
  for (const candidate of [text.split(/:\s+/).slice(1).join(': '), text.split('\n').slice(1).join('\n')]) {
    const trimmed = candidate.trim();
    if (trimmed && COMMAND_START.test(trimmed)) return trimmed;
  }
  return '';
}

export function asExitCode(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || process.platform !== 'win32') return trimmed;
  if (/\bexit\b/i.test(trimmed) || SETS_OWN_EXIT.test(trimmed)) return trimmed;
  // Anything else is treated as a condition: true passes, false fails.
  return `if (${trimmed}) { exit 0 } else { exit 1 }`;
}

// A verify that cannot parse is not a failing step.
//
// The planner wrote `if (Test-Path 'x') -and ((Get-Item 'x').Length -gt 0)) {
// exit 0 } else { exit 1 }` — one bracket too many. PowerShell refused to parse
// it and exited 1, so the step was declared unproven, handed to the repair loop,
// and run twice more with the identical broken command. Three failures, three
// identical errors, and a report blaming work that may have been done perfectly.
//
// Unbalanced brackets are the whole of it in practice, and they cost nothing to
// see without running anything.
export function verifyIsMalformed(command) {
  const text = String(command || '');
  if (!text.trim()) return null;
  // Brackets inside quotes are data, not syntax — a path may contain anything.
  const bare = text.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  for (const [open, close, name] of [
    ['(', ')', 'parenthesis'],
    ['{', '}', 'brace'],
    ['[', ']', 'bracket'],
  ]) {
    let depth = 0;
    for (const ch of bare) {
      if (ch === open) depth += 1;
      else if (ch === close) depth -= 1;
      if (depth < 0) return `an unmatched closing ${name}`;
    }
    if (depth > 0) return `${depth} unclosed ${name}${depth > 1 ? 's' : ''}`;
  }
  return null;
}

// A check that reads $LASTEXITCODE or $? proves nothing here.
//
// Every command and its verify run in separate PowerShell processes, so the
// exit code of the step's command does not exist in the verify's world —
// $LASTEXITCODE is $null, `$null -eq 0` is false, and the check fails a step
// that actually succeeded. "show me PATH" ran `Write-Output $env:PATH` (exit 0)
// and was then failed three times by `if ($LASTEXITCODE -eq 0)`. The command's
// own exit code, which Woboo already holds, is the real answer — unless the
// verify also inspects real state (a file, a value), in which case that part is
// genuine and the whole check is run as written.
// A content check that compares a whole file to a literal, byte for byte.
//
// `Set-Content -Encoding UTF8` writes a byte-order mark and a trailing CRLF, so
// a file holding exactly "hello world" reads back as 13 characters, not 11, and
// `$content -eq 'hello world'` is false. The write was perfect; the comparison
// was too literal, and the step was failed three times over an invisible BOM.
// Trimming both sides asks the question that was actually meant — does the file
// say this — while still failing on genuinely wrong content.
export function tolerateWhitespaceInComparison(command) {
  const text = String(command || '');
  // Only touch a raw whole-file comparison; a -match, -like or .Contains is
  // already tolerant, and a comparison of a computed value is not ours to touch.
  if (!/-Raw\b/i.test(text) || !/-eq\s*['"]/.test(text)) return text;
  return (
    text
      // A variable holding the content: `$content -eq 'hello world'`.
      .replace(/(\$\w+)\s+-eq\s+(['"])/g, '$1.Trim() -eq $2')
      // The inline form, which the planner uses just as often:
      // `(Get-Content -Path 'x' -Raw) -eq 'hello world'`. Trim the closing
      // parenthesis of the -Raw read before the comparison.
      .replace(/(\([^()]*-Raw\s*\))\s*-eq\s+(['"])/gi, '$1.Trim() -eq $2')
  );
}

export function verifyReliesOnExitState(command) {
  const text = String(command || '');
  if (!/\$LASTEXITCODE\b|\$\?(?![\w])/.test(text)) return false;
  return !/(Test-Path|Get-|Select-|Measure-|Compare-|Resolve-Path|\.Length|\.Count|-match|-contains|-eq\s+['"])/i.test(
    text,
  );
}

// Every result a step can produce funnels through the guard, so a code path
// that answers with a bare boolean or a truthy `{ ok: false }` fails closed
// instead of passing on truthiness — the original bug, structurally refused.
export async function runStep(i, opts) {
  return asStepResult(await executeStep(i, opts));
}

async function executeStep(i, { cwd, member, task }) {
  const step = mission.steps[i];
  const settings = loadSettings();
  const started = Date.now();

  setStep(i, { status: 'running' });
  setFace('working', step.title);
  record('step', `step ${i + 1}/${mission.steps.length} — ${step.title}`, { level: 'info' });

  let instruction = step.instruction;

  for (let attempt = 1; attempt <= settings.maxRepairs + 1; attempt += 1) {
    assertLive('step');
    setStep(i, { attempts: attempt, status: 'running' });

    // ── do the work ───────────────────────────────────────────────────────
    let work;
    // Set only by the shell path, and only to what was actually run: the files
    // a command produced are read back out of the command that produced them.
    let command = null;
    if (step.kind === 'delegate') {
      work = await crew.delegate({
        instruction,
        cwd,
        member,
        onOutput: (chunk) => publish({ type: 'crew:output', step: i, chunk: chunk.slice(-2000) }),
      });
      if (work.missing) {
        setStep(i, { status: 'failed', output: work.out, ms: Date.now() - started });
        return fail(work.out || 'the crew tool could not do this step');
      }
    } else if (step.kind === 'computer') {
      // The one step kind where Woboo does the work itself, with its own eyes and
      // hands, because there is no command that would do it.
      work = await pilot.drive({
        goal: instruction,
        onProgress: (note) => publish({ type: 'crew:output', step: i, chunk: note }),
      });
      if (work.missing) {
        setStep(i, { status: 'failed', output: work.out, ms: Date.now() - started });
        return fail(work.out || 'the hands could not do this step');
      }
    } else if (step.kind === 'research') {
      // One step, one loop: search, read, notice the gaps, look again, write,
      // critique, revise, render. It owns its own iteration because the shape of
      // research cannot be known before any of it has been read.
      work = await research.investigate({
        question: instruction,
        workspace: cwd,
        ask: brain.ask,
        write: brain.write,
        onProgress: (note) => publish({ type: 'crew:output', step: i, chunk: note }),
      });
    } else if (step.kind === 'web') {
      // Browser work through the DOM: real elements, real clicks, no guessing.
      const reach = reachRoute(instruction);
      // Gathering ten things takes more moves than reading one page. A budget
      // of fourteen steps meant a step asked for ten internships got one look
      // at a results page and had to stop.
      const wanted = Number(String(instruction).match(/\b(\d{1,2})\b(?=[^.]{0,40}\b(offers?|results?|items?|jobs?|listings?|links?|messages?|emails?|sources?)\b)/i)?.[1] || 0);
      work = await webpilot.browse({
        goal: instruction,
        url: reach.url,
        ask: brain.ask,
        maxSteps: wanted > 1 ? Math.min(40, 8 + wanted * 3) : 14,
        onProgress: (note) => publish({ type: 'crew:output', step: i, chunk: note }),
        // So a "take a screenshot" goal can write its PNG where the mission
        // looks for artifacts, instead of leaving nothing on disk.
        workspace: cwd,
      });

      // Keep what it read. A browser step is how Woboo finds things out, and
      // its report was being logged and then dropped — so the step after it,
      // asked to write a document from what was gathered, had nothing.
      const seen = String(work?.text || work?.out || '').trim();
      if (seen.length > 40) {
        findings.push({ file: `${step.title} (read from the web)`, text: seen });
      }
    } else if (step.kind === 'write') {
      // Create a file with exact content, without a shell in the middle. The
      // planner kept trying to write a JSON array or a CSV through
      // `powershell -Command @'...'@ | Set-Content`, and the here-string, the
      // quotes and the escaping broke it every time. A write step carries the
      // body as data, so Woboo puts it on disk verbatim — nothing to escape.
      const named = String(instruction).match(/([^\s'"<>|]+\.[A-Za-z0-9]{1,8})/)?.[1] || String(instruction).trim();
      const target = path.resolve(cwd, named.replace(/^['"]|['"]$/g, ''));
      const body = typeof step.content === 'string' ? step.content : '';
      try {
        if (!body) {
          work = { ok: false, out: `write step for ${path.basename(target)} had no content to write` };
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, body, 'utf8');
          work = { ok: true, out: `wrote ${path.basename(target)} — ${body.length} characters`, file: target };
          record('write', `${path.basename(target)} — ${body.length} characters`, { level: 'ok' });
        }
      } catch (err) {
        work = { ok: false, out: `could not write ${path.basename(target)}: ${err.message}` };
      }
    } else if (step.kind === 'read') {
      // Text out of a document, without a shell, a package, or three levels of
      // quoting. "path/in.pdf" or "path/in.pdf -> path/out.txt".
      const [from, to] = String(instruction)
        .split('->')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
      let source = path.resolve(cwd, (from.match(/[^\s'"]+\.\w{2,5}/) || [from])[0]);

      // Read what an earlier step actually produced, not the name the plan
      // guessed. The research step wrote
      // internship-opportunities-in-china-for-rayane-sbaac.pdf; this step was
      // told to read internships.pdf, which nothing had ever created.
      source = orArtifact(source);
      try {
        const text = await research.readLocal(source);
        if (!text || text.length < 20) {
          work = { ok: false, out: `${path.basename(source)} yielded no readable text` };
        } else {
          if (to) {
            const target = path.resolve(cwd, (to.match(/[^\s'"]+\.\w{2,5}/) || [to])[0]);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, text, 'utf8');
            work = { ok: true, out: `read ${path.basename(source)} — ${text.length} characters`, file: target, text };
          } else {
            work = { ok: true, out: text.slice(0, 4000), text };
          }
          findings.push({ file: source, text });
          record('read', `${path.basename(source)} — ${text.length} characters`, { level: 'ok' });
        }
      } catch (err) {
        work = { ok: false, out: `could not read ${path.basename(source)}: ${err.message}` };
      }
    } else if (step.kind === 'deliver') {
      // Hand the finished thing to the owner. One API call, with a token that
      // has been on disk the whole time.
      const named = String(instruction).match(/([-\w./\\: ]+\.(?:pdf|html?|txt|md|png|jpe?g|csv|docx?|zip))/i)?.[1];
      // Send what was actually produced, not what the plan guessed would be.
      let file = named ? orArtifact(path.resolve(cwd, named.trim())) : artifacts[artifacts.length - 1] || null;

      // Did the owner actually ask for something to be sent? "tell me", "show
      // me", "what is", "list" want an answer they are already looking at, not
      // a file pushed to their phone. The brain plans a deliver step for these
      // anyway — for a file no step ever wrote — and the mission was failing on
      // a delivery nobody requested. When no send was asked for and there is no
      // real file, the answer the browser gathered is already in the step
      // output; treat the phantom deliver as the no-op it is.
      const askedToSend = /\b(send|message|text|e-?mail|telegram|deliver|share|notify)\b/i.test(String(task || ''));
      const haveFile = file && fs.existsSync(file);

      if (haveFile) {
        const telegram = await import('./telegram.mjs');
        const sent = await telegram.deliver(file, mission.summary || '');
        work = sent.ok
          ? { ok: true, out: `sent ${path.basename(file)} to you on Telegram` }
          : { ok: false, out: `could not send ${path.basename(file)}: ${sent.error}` };
      } else if (!askedToSend) {
        work = {
          ok: true,
          out: 'nothing was asked to be sent; the answer is in the results above',
        };
        record('step', `step ${i + 1}: no delivery was asked for — the answer is shown, not sent`, { level: 'warn' });
      } else {
        work = {
          ok: false,
          out: `you asked for this to be sent, but no file was produced to send: "${instruction}"`,
        };
      }
    } else if (step.kind === 'compose') {
      // The step that turns gathered material into something worth reading.
      const named = String(instruction).match(/(?:^|[\s:'"(])([.\w][-\w./\\]*\.(?:html?|txt|md|json))\b/gi) || [];
      const folders = String(instruction).match(/(?:^|[\s:'"(])(\.?[\w][-\w./\\]*\/)(?=[\s,'")]|$)/g) || [];
      const patterns = [...named, ...folders].map((s) => s.trim().replace(/^['"(:]+/, ''));

      // What the earlier steps actually found, first. A "web" step reads pages
      // and reports what it saw; that report was going nowhere, so the document
      // written from it had nothing to be written from.
      const sources = [...findings];
      const onDisk = scribe.gather(cwd, patterns.length ? patterns : sources.length ? [] : ['.']);
      sources.push(...onDisk.filter((s) => String(s.text || '').trim().length > 40));

      // Refuse rather than invent.
      //
      // With no usable material this fell back to globbing the whole workspace
      // and produced a confident, well-formatted PDF about package-lock.json,
      // the README and a leftover file about elephants — for a task that asked
      // about a support mailbox. A document that looks finished and is about
      // the wrong thing is worse than no document: it is the one failure the
      // owner cannot see at a glance.
      if (!sources.length) {
        const wanted = patterns.length ? patterns.join(', ') : 'anything from the earlier steps';
        work = {
          ok: false,
          out:
            `Nothing to write from. This step was meant to build a document out of ${wanted}, ` +
            `and there is no material there — the step that was supposed to gather it did not produce any. ` +
            `Writing something anyway would mean a document about whatever else happens to be in the folder.`,
        };
      } else {
        const out = String(instruction).match(/([-\w./\\]+\.html?)\b/i)?.[1];
        work = await scribe.compose({
          instruction,
          sources,
          outFile: path.resolve(cwd, out && !sources.some((s) => s.file.endsWith(out)) ? out : 'report.html'),
          write: brain.write,
        });
      }
    } else if (step.kind === 'inspect') {
      const shot = await eyes.screenshot({ reason: step.title });
      work = { ok: shot.ok, out: shot.ok ? `screen captured (${shot.size || 'ok'})` : shot.error };
    } else {
      command = unescapePaths(instruction);
      work = await run(command, { cwd, label: step.title });
    }

    setStep(i, { output: work.out || '' });
    if (work.ok && work.file) artifacts.push(work.file);

    // A shell step reports an exit code and no filename, so the files it made
    // were invisible to the acceptance check and every mission whose
    // deliverable was a file written by a command was reported as delivering
    // nothing. The verify is read alongside the command because it names the
    // same files from the other direction: `Test-Path 'report.txt'`.
    if (work.ok && command) {
      for (const file of filesTouched(`${command} ${step.verify || ''}`, cwd, started)) {
        if (!artifacts.includes(file)) artifacts.push(file);
      }
    }

    // When a step says it failed, say why.
    //
    // The reason went into the step record and never into the journal, so a
    // deliver step that reported "cloud_engineer_guide.pdf does not exist" left
    // no trace at all — what the owner saw was a verify failing three times for
    // no stated reason. The most useful sentence Woboo had was the one it threw
    // away.
    if (!work.ok && work.out) {
      record('step', `step ${i + 1}: ${String(work.out).slice(0, 200)}`, { level: 'error' });
    }

    // Some steps know. A shell command can exit noisily and still have done the
    // job, so its verify is worth running anyway. But a deliver step that could
    // not find the file, or a compose step with no material, is not being
    // pessimistic — it is reporting a fact, and running a check afterwards only
    // replaces a clear reason with a vaguer one.
    // A "read" belongs here too: a file that is not on disk will not be on disk
    // the second and third time either, and running the identical step three
    // times produced three identical ENOENTs and a step reported as unprovable.
    const DEFINITIVE = new Set(['deliver', 'compose', 'research', 'web', 'read', 'write']);
    if (!work.ok && (DEFINITIVE.has(step.kind) || !step.verify)) {
      setStep(i, { status: 'failed', ms: Date.now() - started });
      return fail(work.out);
    }

    // A deliver step settles its own question: it either sent the file (the API
    // said so) or there was nothing to send. The planner sometimes bolts a
    // Test-Path onto a deliver of a file that was never written — "give me the
    // first paragraph" became browse + deliver + a verify that failed the whole
    // errand even though the browsing had the answer. A successful deliver is
    // its own proof; it does not also face a shell check.
    if (work.ok && (step.kind === 'deliver' || step.kind === 'write')) {
      // A write step already put the exact bytes on disk and registered the
      // file; a Test-Path the planner bolted on would only add a way to fail a
      // step that plainly worked.
      setStep(i, { status: 'ok', ms: Date.now() - started });
      record('step', `step ${i + 1} done`, { level: 'ok' });
      return ok();
    }

    // ── prove it ──────────────────────────────────────────────────────────
    if (!step.verify) {
      setStep(i, { status: 'ok', ms: Date.now() - started });
      record('step', `step ${i + 1} done (nothing to verify)`, { level: 'warn' });
      return ok();
    }

    setStep(i, { status: 'verifying' });
    setFace('testing', `checking: ${step.verify}`);

    // A check that cannot run proves nothing either way. Say so once and take
    // the step at its word, rather than failing it three times over a bracket.
    const broken = verifyIsMalformed(step.verify);
    if (broken) {
      record('step', `step ${i + 1}: the check itself is malformed (${broken}) — skipping it`, { level: 'warn' });
      setStep(i, { status: 'ok', ms: Date.now() - started, verifyOutput: `check not run: ${broken}` });
      return ok();
    }

    // A $LASTEXITCODE check cannot see the command's exit code from a separate
    // shell, so the command's own result is the proof: exited 0 means done,
    // non-zero means failed, and re-running the check would only fail it again.
    if (verifyReliesOnExitState(step.verify)) {
      record(
        'step',
        `step ${i + 1}: its check reads $LASTEXITCODE, which a fresh shell never has — trusting the command's own exit code`,
        { level: 'warn' },
      );
      if (work.ok) {
        setStep(i, { status: 'ok', ms: Date.now() - started, verifyOutput: 'check not run: relies on a prior exit code' });
        return ok();
      }
      setStep(i, { status: 'failed', ms: Date.now() - started });
      return fail(work.out || `step ${i + 1} command exited non-zero`);
    }

    // Check the file that was made, not the one the plan guessed at.
    //
    // A research step names its document after the topic it researched. The
    // verify was written against a guessed name, so it failed, so the whole
    // step ran again — three complete research runs, twelve minutes, three
    // perfectly good PDFs rendered and thrown away, because the check was
    // looking at a path nothing had ever written.
    let verifyCommand = tolerateWhitespaceInComparison(unescapePaths(step.verify));
    if (work.file && fs.existsSync(work.file)) {
      verifyCommand = verifyCommand.replace(/'([^']*\.[a-z0-9]{2,5})'/gi, (whole, named) => {
        const guessed = path.resolve(cwd, named);
        if (fs.existsSync(guessed)) return whole;
        if (path.extname(guessed).toLowerCase() !== path.extname(work.file).toLowerCase()) return whole;
        record('step', `checking ${path.basename(work.file)} — the file this step actually produced`, {
          level: 'warn',
        });
        return `'${work.file}'`;
      });
    }

    // A check looking for something this step does not make is a broken plan,
    // not a failed step.
    //
    // A research step writes a cited PDF. This one was checked with "does
    // internships.txt exist and have ten lines" — which could never pass, so
    // the step was retried, and retried: three complete research runs,
    // eighteen minutes, three good PDFs rendered and thrown away, over a check
    // that was asking about a file nothing in the plan ever writes. Repeating
    // expensive work cannot fix a question that has no right answer.
    const wants = (verifyCommand.match(/'[^']*\.(\w{2,5})'/) || [])[1];
    if (work.file && wants && wants.toLowerCase() !== path.extname(work.file).slice(1).toLowerCase()) {
      record(
        'step',
        `step ${i + 1} produced ${path.basename(work.file)}, but its check asks for a .${wants} — not retrying`,
        { level: 'error' },
      );
      setStep(i, { status: 'failed', ms: Date.now() - started });
      return fail(`step ${i + 1} produced ${path.basename(work.file)}, but its check asks for a .${wants}`);
    }

    const check = await run(asExitCode(verifyCommand), { cwd, label: `verify ${step.title}` });
    setStep(i, { verifyOutput: check.out });

    if (check.ok) {
      setStep(i, { status: 'ok', ms: Date.now() - started });
      record('step', `step ${i + 1} verified`, { level: 'ok' });
      return ok();
    }

    // ── repair ────────────────────────────────────────────────────────────
    if (attempt > settings.maxRepairs) break;

    setFace('confused', `verify failed, retry ${attempt}`);
    record('step', `verify failed on step ${i + 1}, handing the error back`, { level: 'warn' });

    if (step.kind === 'delegate' && brain.hasCredentials()) {
      try {
        const fix = await brain.repair({ task, step: { ...step, instruction }, failure: check.out, attempt });
        instruction = fix.instruction;
        setStep(i, { diagnosis: fix.diagnosis });
        // The diagnosis is the expensive part of this loop. Keep it.
        memory.learnFromRepair(cwd, {
          step: step.title,
          verify: step.verify,
          diagnosis: fix.diagnosis,
          fix: fix.instruction,
        });
      } catch (err) {
        // No diagnosis available — retry with the error appended, which is
        // still more than the crew had the first time.
        record('brain', `could not diagnose (${err.message}); retrying with raw error`, { level: 'warn' });
        instruction = `${step.instruction}\n\nThe check \`${step.verify}\` failed with:\n${check.out.slice(0, 4000)}\n\nFix that.`;
      }
    } else if (step.kind === 'delegate') {
      instruction = `${step.instruction}\n\nThe check \`${step.verify}\` failed with:\n${check.out.slice(0, 4000)}\n\nFix that.`;
    } else if (step.kind === 'shell' && brain.hasCredentials()) {
      // A broken command is not a flaky one.
      //
      // This used to re-run shell steps unchanged, on the theory that there was
      // nothing to re-brief. But the command that failed was
      //   $html = "<html><body><pre>$content</pre></body></html>\);
      // — a stray bracket. It failed identically three times, three seconds
      // apart, and the step was reported as unprovable. A command with a syntax
      // error will fail the same way forever; the only useful move is to write
      // a different command.
      try {
        const fix = await brain.repair({ task, step: { ...step, instruction }, failure: check.out, attempt });

        // A sentence is not a command.
        //
        // One repair came back as "Use a properly escaped single-quoted string
        // with backtick-n for newlines: powershell -Command ..." — advice with
        // the command bolted on the end — and it was run verbatim, so the shell
        // tried to execute the word "Use". Take the command out of the advice,
        // or refuse it.
        if (fix.instruction) fix.instruction = stripAdvice(fix.instruction);

        if (fix.instruction && fix.instruction.trim() !== instruction.trim()) {
          instruction = fix.instruction;
          setStep(i, { diagnosis: fix.diagnosis });
          record('step', `rewrote the command: ${fix.diagnosis}`.slice(0, 160), { level: 'warn' });
          memory.learnFromRepair(cwd, {
            step: step.title,
            verify: step.verify,
            diagnosis: fix.diagnosis,
            fix: fix.instruction,
          });
        } else {
          record('step', 'the brain returned the same command; not retrying it a third time', { level: 'warn' });
          break;
        }
      } catch (err) {
        record('brain', `could not diagnose the failed command (${err.message})`, { level: 'warn' });
        break;
      }
    }
    // An inspect step simply runs again: a flaky look deserves one more try.
  }

  setStep(i, { status: 'failed', ms: Date.now() - started });
  record('step', `step ${i + 1} could not be proven after ${settings.maxRepairs + 1} attempts`, {
    level: 'error',
  });
  return fail(`step ${i + 1} could not be proven after ${settings.maxRepairs + 1} attempts`);
}

// Used by `woboo selftest`: a fixed mission that exercises plan → run → verify →
// report without a brain, a crew tool, or anything to break.
export async function selfTest() {
  if (running) throw new Error('Woboo is busy.');
  assertLive('selftest');

  const steps = [
    {
      title: 'Check the runtime answers arithmetic',
      kind: 'shell',
      instruction: 'node -e "console.log(2+2)"',
      verify: 'node -e "process.exit(2+2===4?0:1)"',
    },
    {
      title: 'Check a failing verify is caught',
      kind: 'shell',
      instruction: 'node -e "console.log(\'this step is expected to fail its check\')"',
      verify: 'node -e "process.exit(1)"',
    },
  ];

  mission = {
    id: crypto.randomBytes(5).toString('hex'),
    task: 'self-test: prove the foreman loop works',
    workspace: process.cwd(),
    summary: 'Two steps: one that must pass its check, one that must fail it.',
    steps: steps.map((s, i) => ({ ...s, i, status: 'pending', attempts: 0, output: '', verifyOutput: '', ms: 0 })),
    state: 'running',
    startedAt: Date.now(),
    endedAt: null,
    offline: true,
    crew: null,
    report: '',
    selftest: true,
  };
  running = true;
  snapshot();

  try {
    const first = await runStep(0, { cwd: process.cwd(), member: null, task: mission.task });
    const second = await runStep(1, { cwd: process.cwd(), member: null, task: mission.task });
    // The second step is *supposed* to fail — that is what proves the loop
    // actually checks instead of assuming.
    const pass = first.success === true && second.success === false;
    mission.state = pass ? 'done' : 'failed';
    mission.report = pass
      ? 'Loop verified: a good step passed, a bad step was caught and retried.'
      : 'Self-test did not behave as expected.';
    setFace(pass ? 'happy' : 'error', mission.report);
    record('mission', mission.report, { level: pass ? 'ok' : 'error' });
    return { pass, mission };
  } finally {
    // Deliberately no memory write here: the self-test's second step is *built*
    // to fail its check, so recording it would teach Woboo that a check which
    // always fails is load-bearing. Synthetic runs must not shape real planning.
    mission.endedAt = Date.now();
    running = false;
    snapshot();
  }
}

// Face upkeep: after a long quiet spell Woboo dozes off, which is both honest
// about its state and the thing that makes it feel alive.
export function startIdleWatch() {
  const timer = setInterval(() => {
    if (running || isStopped()) return;
    const idleFor = Date.now() - (mission?.endedAt || mission?.startedAt || Date.now());
    if (!mission || idleFor > 5 * 60_000) setFace('asleep', 'waiting for a task');
  }, 30_000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
