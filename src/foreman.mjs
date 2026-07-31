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
import { route as reachRoute } from './capabilities.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './shell.mjs';

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
      const ok = await runStep(i, { cwd, member, task });
      if (!ok) {
        mission.state = 'failed';
        mission.report = `Stopped at step ${i + 1}: ${mission.steps[i].title}`;
        setFace('error', mission.steps[i].title);
        break;
      }
    }

    if (mission.state === 'running') {
      mission.state = 'done';
      const checked = mission.steps.filter((s) => s.verify).length;
      mission.report = checked
        ? `All ${mission.steps.length} steps done, ${checked} proven by a command.`
        : `All ${mission.steps.length} steps done. Nothing was independently checkable.`;
      setFace('happy', 'mission complete');
      record('mission', mission.report, { level: 'ok' });
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
  return String(command || '').replace(/'([^']*)'/g, (whole, inner) =>
    /[A-Za-z]:\\\\|\\\\\w/.test(inner) ? `'${inner.replace(/\\{2,}/g, '\\')}'` : whole,
  );
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

async function runStep(i, { cwd, member, task }) {
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
    if (step.kind === 'delegate') {
      work = await crew.delegate({
        instruction,
        cwd,
        member,
        onOutput: (chunk) => publish({ type: 'crew:output', step: i, chunk: chunk.slice(-2000) }),
      });
      if (work.missing) {
        setStep(i, { status: 'failed', output: work.out, ms: Date.now() - started });
        return false;
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
        return false;
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
      });

      // Keep what it read. A browser step is how Woboo finds things out, and
      // its report was being logged and then dropped — so the step after it,
      // asked to write a document from what was gathered, had nothing.
      const seen = String(work?.text || work?.out || '').trim();
      if (seen.length > 40) {
        findings.push({ file: `${step.title} (read from the web)`, text: seen });
      }
    } else if (step.kind === 'deliver') {
      // Hand the finished thing to the owner. One API call, with a token that
      // has been on disk the whole time.
      const named = String(instruction).match(/([-\w./\\: ]+\.(?:pdf|html?|txt|md|png|jpe?g|csv|docx?|zip))/i)?.[1];
      let file = named ? path.resolve(cwd, named.trim()) : null;

      // Send what was actually produced, not what the plan guessed would be.
      //
      // A research step names its document after the topic it researched, so
      // the planner's guess at the filename is nearly always wrong — it wanted
      // cloud_engineer_guide.pdf and the step had written
      // how-to-become-a-cloud-engineer-skills-certificatio.pdf. The right file
      // was on disk the whole time.
      const madeHere = artifacts.filter((f) => !named || path.extname(f) === path.extname(file || ''));
      if ((!file || !fs.existsSync(file)) && madeHere.length) {
        file = madeHere[madeHere.length - 1];
        record('step', `sending ${path.basename(file)}, which is what the earlier step actually produced`, {
          level: 'warn',
        });
      }

      if (!file) {
        work = { ok: false, out: `no file named in this step and no earlier step produced one: "${instruction}"` };
      } else {
        const telegram = await import('./telegram.mjs');
        const sent = await telegram.deliver(file, mission.summary || '');
        work = sent.ok
          ? { ok: true, out: `sent ${path.basename(file)} to you on Telegram` }
          : { ok: false, out: `could not send ${path.basename(file)}: ${sent.error}` };
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
        return {
          ok: false,
          out:
            `Nothing to write from. This step was meant to build a document out of ${wanted}, ` +
            `and there is no material there — the step that was supposed to gather it did not produce any. ` +
            `Writing something anyway would mean a document about whatever else happens to be in the folder.`,
        };
      }

      const out = String(instruction).match(/([-\w./\\]+\.html?)\b/i)?.[1];
      work = await scribe.compose({
        instruction,
        sources,
        outFile: path.resolve(cwd, out && !sources.some((s) => s.file.endsWith(out)) ? out : 'report.html'),
        write: brain.write,
      });
    } else if (step.kind === 'inspect') {
      const shot = await eyes.screenshot({ reason: step.title });
      work = { ok: shot.ok, out: shot.ok ? `screen captured (${shot.size || 'ok'})` : shot.error };
    } else {
      work = await run(unescapePaths(instruction), { cwd, label: step.title });
    }

    setStep(i, { output: work.out || '' });
    if (work.ok && work.file) artifacts.push(work.file);

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
    const DEFINITIVE = new Set(['deliver', 'compose', 'research', 'web']);
    if (!work.ok && (DEFINITIVE.has(step.kind) || !step.verify)) {
      setStep(i, { status: 'failed', ms: Date.now() - started });
      return false;
    }

    // ── prove it ──────────────────────────────────────────────────────────
    if (!step.verify) {
      setStep(i, { status: 'ok', ms: Date.now() - started });
      record('step', `step ${i + 1} done (nothing to verify)`, { level: 'warn' });
      return true;
    }

    setStep(i, { status: 'verifying' });
    setFace('testing', `checking: ${step.verify}`);

    // A check that cannot run proves nothing either way. Say so once and take
    // the step at its word, rather than failing it three times over a bracket.
    const broken = verifyIsMalformed(step.verify);
    if (broken) {
      record('step', `step ${i + 1}: the check itself is malformed (${broken}) — skipping it`, { level: 'warn' });
      setStep(i, { status: 'ok', ms: Date.now() - started, verifyOutput: `check not run: ${broken}` });
      return true;
    }

    const check = await run(asExitCode(unescapePaths(step.verify)), { cwd, label: `verify ${step.title}` });
    setStep(i, { verifyOutput: check.out });

    if (check.ok) {
      setStep(i, { status: 'ok', ms: Date.now() - started });
      record('step', `step ${i + 1} verified`, { level: 'ok' });
      return true;
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
  return false;
}

// Used by `wobo selftest`: a fixed mission that exercises plan → run → verify →
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
    const pass = first === true && second === false;
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
