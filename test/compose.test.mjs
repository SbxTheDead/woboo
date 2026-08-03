// Writing a document from material that is not there.
//
// Asked to summarise a support mailbox, Woboo produced a well-formatted PDF
// about package-lock.json, the README, and a leftover file about elephants. The
// step that was meant to gather the emails had produced a 3-byte file, so the
// writer fell back to globbing the whole workspace and wrote confidently about
// whatever it found.
//
// A document that looks finished and is about the wrong thing is the one
// failure an owner cannot see at a glance. Refusing is the correct answer.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as scribe from '../src/scribe.mjs';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-compose-'));
test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

test('an empty gathered file is not material', () => {
  // Exactly what the failing run produced: a file with a byte-order mark in it.
  fs.writeFileSync(path.join(workspace, 'emails.txt'), '﻿');
  const gathered = scribe.gather(workspace, ['emails.txt']);
  const usable = gathered.filter((s) => String(s.text || '').trim().length > 40);
  assert.equal(usable.length, 0, 'a 3-byte file was treated as something to write from');
});

test('naming a source that is empty does not silently widen to the folder', () => {
  // The bug: patterns were given, they yielded nothing, and the writer fell
  // back to ['.'] — every file in the workspace, none of them relevant. Those
  // files are real and substantial in a real project, which is exactly why the
  // fallback produced a confident document about package-lock.json.
  fs.writeFileSync(path.join(workspace, 'README.md'), '# A readme with nothing to do with the task.\n'.repeat(20));

  const named = scribe.gather(workspace, ['emails.txt']).filter((s) => String(s.text || '').trim().length > 40);
  assert.equal(named.length, 0, 'the named source is empty and must yield nothing');

  const everything = scribe.gather(workspace, ['.']);
  assert.ok(everything.length > 0, 'the folder does hold readable files — that is what made the fallback dangerous');
  assert.ok(
    everything.every((s) => !/higgsfield/i.test(s.text)),
    'and none of them is what the owner asked about',
  );
});

test('real material is accepted', () => {
  const real = 'From: support@higgsfield.ai\nSubject: Refund\n\n'.repeat(6);
  fs.writeFileSync(path.join(workspace, 'emails.txt'), real);
  const usable = scribe.gather(workspace, ['emails.txt']).filter((s) => String(s.text || '').trim().length > 40);
  assert.equal(usable.length, 1);
  assert.match(usable[0].text, /higgsfield/);
});

test('a compose step with nothing to write from fails the step', async () => {
  // The refusal did `return { ok: false, out }` from runStep, whose contract is
  // a boolean — a truthy object, so the step was treated as SUCCEEDED: no
  // failure recorded, no document produced, mission reported done.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-compose-empty-'));
  try {
    mock.module('../src/brain.mjs', {
      namedExports: {
        hasCredentials: () => true,
        provider: () => 'anthropic',
        getClient: () => null,
        plan: async () => ({
          summary: 'Write a document from material that does not exist',
          understanding: {
            asking_for: 'Summarise the support mailbox as a PDF',
            deliverables: ['A PDF summarising the support thread'],
            done_when: 'The owner has the PDF',
            care_about: [],
          },
          steps: [
            {
              title: 'Write the summary',
              kind: 'compose',
              instruction: 'Write summary.html from support-emails.txt',
              verify: '',
            },
          ],
        }),
        ask: async () => ({ verdicts: [], shortfall: '' }),
        write: async () => '',
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
    const mission = await runMission('Summarise the support mailbox', { workspace: empty });

    assert.equal(mission.steps[0].status, 'failed', 'the refusal must fail the step, not return a truthy object');
    assert.match(mission.steps[0].output, /Nothing to write from/);
    assert.equal(mission.state, 'failed', 'a refused compose step must not be reported as success');
    assert.match(mission.report, /Stopped at step 1/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
