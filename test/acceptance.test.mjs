// Did Woboo deliver what it said it would?
//
// Every case here is a real failure from one day of use, and in every one the
// mission reported success — because "all steps ran" was the only question
// anyone asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceFor, obviousShortfall, check } from '../src/acceptance.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-accept-'));
const file = (name, body) => {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  return full;
};
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a placeholder is caught without asking anyone', () => {
  // The real one: "Summary of emails from support@higgsfield.ai: [placeholder]"
  const f = file('summary.txt', 'Summary of emails from support@example.com: [placeholder]');
  assert.match(obviousShortfall([f]) || '', /placeholder/i);
});

test('a file that was reported but never written is caught', () => {
  assert.match(obviousShortfall([path.join(dir, 'never-created.pdf')]) || '', /not on disk/i);
});

test('producing nothing at all is caught when a file was owed', () => {
  assert.match(obviousShortfall([], ['A PDF summarising the support thread']) || '', /no file/i);
  assert.match(obviousShortfall([], ['The summary in summary.pdf']) || '', /no file/i);
});

test('producing no file is fine when no file was asked for', () => {
  // "Run the tests", "restart the browser", a question answered in chat — these
  // legitimately end with zero artifacts and were always reported failed.
  assert.equal(obviousShortfall([], []), null);
  assert.equal(obviousShortfall([], ['The test suite passing']), null);
  assert.equal(obviousShortfall([], ['The browser restarted with the profile loaded']), null);
  assert.equal(obviousShortfall([], ['An answer to the question, in chat']), null);
});

test('a real document passes the cheap checks', () => {
  const f = file('real.md', '# Support summary\n\nThe thread began with a refund request.\n'.repeat(10));
  assert.equal(obviousShortfall([f]), null);
});

test('evidence describes what is actually in a file', () => {
  const f = file('report.html', '<html><body><h1>Elephants</h1><p>Forest elephants are elusive.</p></body></html>');
  const seen = evidenceFor(f);
  assert.match(seen, /report\.html/);
  assert.match(seen, /Elephants/, 'the evidence must show the subject, or the wrong subject cannot be spotted');
  assert.ok(!/<h1>/.test(seen), 'markup is not content');
});

test('evidence flags an empty file rather than describing it as a document', () => {
  assert.match(evidenceFor(file('empty.txt', '')), /EMPTY/);
  // The real one was three bytes: a byte-order mark and nothing else.
  assert.match(evidenceFor(file('bom.txt', '﻿')), /only \d+ characters/);
});

test('evidence says plainly when a file is not there', () => {
  assert.match(evidenceFor(path.join(dir, 'absent.pdf')), /DOES NOT EXIST/);
});

test('the wrong subject fails even when every step passed', async () => {
  // The exact failure: asked for a summary of a support mailbox, handed a
  // well-formed document about a project's package manifest.
  const wrong = file('support_summary.html', '<html><body><pre>Project woboo version 0.1.0. Dependency: electron.</pre></body></html>');

  const asked = [];
  const result = await check({
    understanding: {
      asking_for: 'Summarise the emails from support@higgsfield.ai as an organised PDF',
      deliverables: ['A PDF summarising the emails received from support@higgsfield.ai'],
      done_when: 'The owner has a PDF about that correspondence',
    },
    steps: [{ kind: 'compose', title: 'Write summary', output: 'wrote support_summary.html' }],
    artifacts: [wrong],
    // Stand in for the brain so the test is about the evidence we hand it.
    ask: async ({ prompt }) => {
      asked.push(prompt);
      return { verdicts: [{ deliverable: 'A PDF', met: false, evidence: 'the file is about a package manifest' }], shortfall: 'no summary of the support emails' };
    },
  });

  assert.equal(result.met, false);
  assert.match(result.shortfall, /support/i);
  // The judgement is only as good as what it was shown.
  assert.match(asked[0], /package manifest|woboo version/i, 'the evidence must include what the file actually says');
  assert.match(asked[0], /support@higgsfield\.ai/, 'and what was asked for');
});

test('no deliverables means nothing to check, not a failure', async () => {
  const result = await check({ understanding: {}, artifacts: [], ask: async () => ({}) });
  assert.equal(result.checked, false);
  assert.equal(result.met, true);
});
