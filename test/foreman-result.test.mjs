// The strict step-result contract.
//
// runStep used to return a bare boolean, and one refusal path returned
// `{ ok: false, out }` — truthy, so a refused step was read as a success and
// the mission reported done. These tests pin the `{ success, error?, data? }`
// shape and the paths that must fail closed: a refused command, a verify that
// cannot be repaired into passing, and a result that is not the strict shape.
//
// The stubbing pattern is the one from runmission.test.mjs: a throwaway
// WOBOO_HOME fixed before any src import, the brain/crew/memory mocked, and
// everything else — the foreman loop, the shell, the guard — real.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set before anything under src/ is imported: config.mjs fixes HOME at
// load time. All src imports below are dynamic for exactly this reason.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-mission-'));
process.env.WOBOO_HOME = home;
test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

// Each mission test needs the brain to behave differently, and a module mock
// is registered once — so the mocks delegate through here and the tests set
// the behavior.
const behavior = {
  plan: async () => ({ unplanned: true, summary: '', reason: 'unset', steps: [] }),
  ask: async () => ({ verdicts: [], shortfall: '' }),
  write: async () => '',
  repair: async () => ({ diagnosis: '', instruction: '' }),
};

mock.module('../src/brain.mjs', {
  namedExports: {
    hasCredentials: () => true,
    provider: () => 'anthropic',
    getClient: () => null,
    plan: (...args) => behavior.plan(...args),
    ask: (...args) => behavior.ask(...args),
    write: (...args) => behavior.write(...args),
    repair: (...args) => behavior.repair(...args),
    offlinePlan: () => ({ unplanned: true, summary: '', reason: 'test', steps: [] }),
    unplannable: () => ({ unplanned: true, summary: '', reason: 'test', steps: [] }),
  },
});
mock.module('../src/crew.mjs', {
  namedExports: { pick: async () => null, delegate: async () => ({ ok: false, out: '' }) },
});
mock.module('../src/memory.mjs', {
  namedExports: { recall: () => '', learnFromMission: () => {}, learnFromRepair: () => {} },
});

const foreman = await import('../src/foreman.mjs');

const journal = () =>
  fs
    .readFileSync(path.join(home, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('ok and fail build the only shapes a step may return', () => {
  assert.deepEqual(foreman.ok(), { success: true });
  assert.deepEqual(foreman.ok({ file: 'x' }), { success: true, data: { file: 'x' } });
  assert.deepEqual(foreman.fail('boom'), { success: false, error: 'boom' });
  assert.deepEqual(foreman.fail('boom', { n: 1 }), { success: false, error: 'boom', data: { n: 1 } });
  // An empty reason still produces a failure that says something.
  assert.deepEqual(foreman.fail(''), { success: false, error: 'step failed' });
});

test('a malformed result fails closed, and is journaled', () => {
  // The original bug class, in every spelling: truthy values where a verdict
  // was expected, including the `{ ok: false }` that once passed as success.
  for (const bad of [true, { ok: false, out: 'refused' }, 'done', 1, null, undefined]) {
    const result = foreman.asStepResult(bad);
    assert.equal(result.success, false, `${JSON.stringify(bad)} passed as a step result`);
    assert.equal(result.error, 'internal: malformed step result');
  }
  // A strict result passes through untouched, identity included.
  const good = foreman.ok();
  assert.equal(foreman.asStepResult(good), good);
  const bad = foreman.fail('x');
  assert.equal(foreman.asStepResult(bad), bad);

  assert.ok(
    journal().some((e) => e.kind === 'step' && e.level === 'error' && /malformed result/.test(e.msg)),
    'a malformed result left no trace in the journal',
  );
});

test('a refused command stops the mission before anything else runs', async () => {
  // The guard is real here, not mocked: this command classifies as deny
  // (a type-static method invocation aimed at the state directory).
  behavior.plan = async () => ({
    summary: 'Two steps, the first of which must be refused',
    understanding: {
      asking_for: 'Write into the state directory, then write a marker',
      deliverables: ['A marker file'],
      done_when: 'marker.txt exists',
      care_about: [],
    },
    steps: [
      {
        title: 'Write into the state directory',
        kind: 'shell',
        instruction: `[System.IO.File]::WriteAllText('~/.woboo/x','y')`,
        verify: '',
      },
      {
        title: 'Write the marker',
        kind: 'shell',
        instruction: `node -e "require('fs').writeFileSync('marker.txt','ran')"`,
        verify: '',
      },
    ],
  });

  const mission = await foreman.runMission('try to write into the state directory', { workspace });

  assert.equal(mission.state, 'failed');
  assert.match(mission.report, /refused/);
  assert.equal(mission.steps[1].status, 'pending', 'a step after a refused one must never run');
  assert.ok(!fs.existsSync(path.join(workspace, 'marker.txt')), 'the second step ran anyway');
  assert.ok(!fs.existsSync(path.join(home, 'x')), 'the refused write happened');
});

test('a verify that fails, with repair failing too, ends the mission failed', async () => {
  behavior.plan = async () => ({
    summary: 'A step whose check cannot pass, then a marker',
    understanding: {
      asking_for: 'Run the checks',
      deliverables: ['The checks passing'],
      done_when: 'the check exits 0',
      care_about: [],
    },
    steps: [
      {
        title: 'Run the check',
        kind: 'shell',
        instruction: `node -e "console.log('working')"`,
        verify: `node -e "process.exit(1)"`,
      },
      {
        title: 'Write the marker',
        kind: 'shell',
        instruction: `node -e "require('fs').writeFileSync('marker.txt','ran')"`,
        verify: '',
      },
    ],
  });
  // The brain has no fix: repair returns nothing usable, so the step must not
  // be retried forever and the mission must not continue past it.
  behavior.repair = async () => ({ diagnosis: 'cannot be fixed', instruction: '' });

  const mission = await foreman.runMission('run the checks', { workspace });

  assert.equal(mission.state, 'failed');
  assert.match(mission.report, /Stopped at step 1/);
  assert.equal(mission.steps[0].status, 'failed');
  assert.equal(mission.steps[1].status, 'pending', 'execution continued past a step that could not be proven');
  assert.ok(!fs.existsSync(path.join(workspace, 'marker.txt')), 'the step after the failure ran anyway');

  // And runStep answers the strict shape for the failure, with the reason.
  const again = await foreman.runStep(0, { cwd: workspace, member: null, task: 'run the checks' });
  assert.equal(again.success, false);
  assert.equal(typeof again.error, 'string');
  assert.match(again.error, /could not be proven/);
});

test('successful steps continue, and every result carries the strict shape', async () => {
  behavior.plan = async () => ({
    summary: 'Two verifiable shell steps',
    understanding: {
      asking_for: 'Restart the thing and prove it',
      deliverables: ['The service restarted'],
      done_when: 'both checks pass',
      care_about: [],
    },
    steps: [
      { title: 'Do the first thing', kind: 'shell', instruction: `node -e "console.log('one')"`, verify: `node -e "process.exit(0)"` },
      { title: 'Do the second thing', kind: 'shell', instruction: `node -e "console.log('two')"`, verify: `node -e "process.exit(0)"` },
    ],
  });
  behavior.ask = async () => ({
    verdicts: [{ deliverable: 'The service restarted', met: true, evidence: 'both checks exited 0' }],
    shortfall: '',
  });

  const mission = await foreman.runMission('restart the thing', { workspace });

  assert.equal(mission.state, 'done', mission.report);
  assert.deepEqual(
    mission.steps.map((s) => s.status),
    ['ok', 'ok'],
  );
  // Pure shell steps and no file owed: an operation, done with zero artifacts.
  assert.equal(mission.category, 'operation');

  // runStep answers the strict shape for a success too.
  const again = await foreman.runStep(0, { cwd: workspace, member: null, task: 'restart the thing' });
  assert.equal(again.success, true);
  assert.ok(
    Object.keys(again).every((k) => ['success', 'error', 'data'].includes(k)),
    `unexpected fields on a step result: ${Object.keys(again)}`,
  );
});
