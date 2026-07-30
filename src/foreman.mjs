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
import path from 'node:path';
import { run } from './shell.mjs';

let mission = null;
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

export function asExitCode(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed || process.platform !== 'win32') return trimmed;
  if (/\bexit\b/i.test(trimmed) || SETS_OWN_EXIT.test(trimmed)) return trimmed;
  // Anything else is treated as a condition: true passes, false fails.
  return `if (${trimmed}) { exit 0 } else { exit 1 }`;
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
      work = await webpilot.browse({
        goal: instruction,
        url: reach.url,
        ask: brain.ask,
        onProgress: (note) => publish({ type: 'crew:output', step: i, chunk: note }),
      });
    } else if (step.kind === 'compose') {
      // The step that turns gathered material into something worth reading.
      // Sources come from whatever paths the instruction names; failing that,
      // whatever the earlier steps left in the workspace.
      const named = String(instruction).match(/(?:^|[\s:'"(])([.\w][-\w./\\]*\.(?:html?|txt|md|json))\b/gi) || [];
      const folders = String(instruction).match(/(?:^|[\s:'"(])(\.?[\w][-\w./\\]*\/)(?=[\s,'")]|$)/g) || [];
      const patterns = [...named, ...folders].map((s) => s.trim().replace(/^['"(:]+/, ''));
      const sources = scribe.gather(cwd, patterns.length ? patterns : ['.']);

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
      work = await run(instruction, { cwd, label: step.title });
    }

    setStep(i, { output: work.out || '' });

    // A hard failure with nothing to verify against ends the step. If there is
    // a verify command, run it anyway — the tool may have succeeded despite a
    // noisy exit code.
    if (!work.ok && !step.verify) {
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
    const check = await run(asExitCode(step.verify), { cwd, label: `verify ${step.title}` });
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
    }
    // Shell and inspect steps simply run again: a flaky check deserves one more
    // try, but there is nothing to re-brief.
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
