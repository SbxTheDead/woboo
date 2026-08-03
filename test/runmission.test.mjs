// The happy path, end to end: a two-step plan where a shell step gathers real
// material into the workspace, a compose step writes a document from it, every
// verify passes, and the acceptance check agrees the deliverable exists. The
// brain, the crew and the memory are stubbed exactly as in compose.test.mjs —
// what is real here is the foreman loop, the shell, the files on disk and the
// journal, which lives in a throwaway WOBOO_HOME so the run leaves no trace.
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

// gather() ignores sources under 200 characters, the compose step quotes the
// command through PowerShell, and the acceptance pass refuses placeholder
// prose — so the material is plain prose: long enough, no quotes, no dollars.
const NOTES =
  'Support mailbox notes gathered for the summary. Refund requests came mostly from annual plan ' +
  'subscribers and were answered within two days. Shipping questions peaked after the model launch. ' +
  'Account lockouts were rare but urgent. This material is the basis for the document the owner asked for.';

const SUMMARY_HTML =
  '<html><head><title>Support mailbox summary</title></head><body>' +
  '<h1>Support mailbox summary</h1>' +
  '<p>Refund requests were answered within two days, shipping questions peaked after the launch, ' +
  'and account lockouts were rare but urgent.</p></body></html>';

test('a planned mission runs end to end and delivers what was asked for', async () => {
  let writtenPrompt = '';
  mock.module('../src/brain.mjs', {
    namedExports: {
      hasCredentials: () => true,
      provider: () => 'anthropic',
      getClient: () => null,
      plan: async () => ({
        summary: 'Gather the support notes, then write the summary document',
        understanding: {
          asking_for: 'Summarise the support mailbox notes as an HTML document',
          deliverables: ['An HTML document summarising the support mailbox notes'],
          done_when: 'report.html exists and summarises the notes',
          care_about: [],
        },
        steps: [
          {
            title: 'Gather the notes',
            kind: 'shell',
            instruction: `node -e "require('fs').writeFileSync('notes.txt','${NOTES}')"`,
            verify: `node -e "require('fs').accessSync('notes.txt')"`,
          },
          {
            title: 'Write the summary document',
            kind: 'compose',
            instruction: 'Write report.html from notes.txt',
            verify: `node -e "require('fs').accessSync('report.html')"`,
          },
        ],
      }),
      // The acceptance check would ask the model to judge the deliverables;
      // the evidence on disk is real, the judge is not.
      ask: async () => ({
        verdicts: [
          {
            deliverable: 'An HTML document summarising the support mailbox notes',
            met: true,
            evidence: 'report.html exists and summarises the notes',
          },
        ],
        shortfall: '',
      }),
      write: async ({ prompt } = {}) => {
        writtenPrompt = prompt;
        return SUMMARY_HTML;
      },
      repair: async () => ({ diagnosis: '', instruction: '' }),
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

  const { runMission } = await import('../src/foreman.mjs');
  const mission = await runMission('Summarise the support mailbox notes', { workspace });

  assert.equal(mission.state, 'done', mission.report);
  assert.deepEqual(
    mission.steps.map((s) => s.status),
    ['ok', 'ok'],
  );
  assert.match(mission.report, /All 2 steps done, 2 proven by a command/);
  assert.match(mission.report, /1 deliverable\(s\) checked/);
  assert.equal(mission.verdicts.length, 1);
  assert.equal(mission.verdicts[0].met, true);

  // The files the mission owes are really on disk, in the temp workspace.
  const notes = path.join(workspace, 'notes.txt');
  const report = path.join(workspace, 'report.html');
  assert.ok(fs.existsSync(notes), 'the shell step did not leave notes.txt behind');
  assert.equal(fs.readFileSync(notes, 'utf8'), NOTES);
  assert.ok(fs.existsSync(report), 'the compose step did not leave report.html behind');
  assert.match(fs.readFileSync(report, 'utf8'), /Support mailbox summary/);

  // The writer was given the gathered material, not the whole folder.
  assert.match(writtenPrompt, /Refund requests/);

  // The journal in the throwaway home tells the same story the mission does.
  const entries = fs
    .readFileSync(path.join(home, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(entries.some((e) => e.kind === 'mission' && /new task/.test(e.msg)));
  assert.ok(entries.some((e) => e.kind === 'accept' && e.level === 'ok' && /✓/.test(e.msg)));
  assert.ok(
    entries.some((e) => e.kind === 'mission' && e.level === 'ok' && /deliverable\(s\) checked/.test(e.msg)),
    'the journal never recorded the mission as done',
  );
});
