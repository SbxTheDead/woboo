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
import { evidenceFor, obviousShortfall, check, categorize, provenByCommands, readDecoded } from '../src/acceptance.mjs';

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

test('a UTF-16 file (PowerShell > redirect) reads back as its real text', () => {
  // `Get-ComputerInfo | Format-List > info.txt` writes UTF-16LE with a BOM;
  // read as UTF-8 it is a wall of nulls and a correct report is judged garbage.
  const le = path.join(dir, 'info-le.txt');
  fs.writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Windows 10 Pro', 'utf16le')]));
  assert.equal(readDecoded(le), 'Windows 10 Pro');
  // A plain UTF-8 file still reads normally, BOM or not.
  assert.equal(readDecoded(file('u8.txt', 'hello world')), 'hello world');
  assert.match(evidenceFor(le), /Windows 10 Pro/);
});

test('a browser read is its own proof — no shell verify required', () => {
  // "go to hacker news and tell me the top 5" — the web step navigated and read
  // the answer, which is the verification. It has no shell verify and never
  // will; failing it for that scored every "tell me from a website" task a loss.
  const webRead = { category: 'browser', steps: [{ kind: 'web', status: 'ok', verify: null }] };
  assert.equal(obviousShortfall([], [], webRead), null);
  // A browser mission that drove but read nothing (all steps failed) is still
  // unproven.
  const drovenothing = { category: 'browser', steps: [{ kind: 'web', status: 'failed', verify: null }] };
  assert.match(obviousShortfall([], [], drovenothing) || '', /never verified/i);
});

test('an empty file is a shortfall — unless an empty file is what was asked for', () => {
  const blank = file('file1.txt', '');
  assert.match(obviousShortfall([blank], ['A summary of the thread in file1.txt']) || '', /empty/i);
  // Task 2 of the suite: "create 5 empty text files named file1.txt through
  // file5.txt". Nought bytes is the requirement, and it was being reported as
  // the failure.
  assert.equal(obviousShortfall([blank], ['Five empty text files: file1.txt … file5.txt on the Desktop']), null);
  assert.equal(obviousShortfall([blank], ['A blank file1.txt']), null);
});

test('a faithful copy or rename of an empty file is not a shortfall', () => {
  // "rename file2.txt to file2_renamed.txt" and "copy file3.txt to
  // file3_backup.txt": the sources were empty, so the outputs are empty, and
  // that is the operation done correctly — not a report that came out blank.
  const renamed = file('file2_renamed.txt', '');
  const backup = file('file3_backup.txt', '');
  assert.equal(obviousShortfall([renamed], ['The file file2.txt is renamed to file2_renamed.txt']), null);
  assert.equal(obviousShortfall([backup], ['file3.txt copied to file3_backup.txt']), null);
  // But an empty *document* is still caught.
  assert.match(obviousShortfall([file('r.md', '')], ['A report on the findings in r.md']) || '', /empty/i);
});

test('prose "file names" does not count as owing a file', () => {
  // Task 8: "list all files on my desktop and tell me how many there are" — a
  // console-output task. Its deliverables mention "file names" and "files", but
  // nothing is owed on disk, and demanding one failed a correct job.
  assert.equal(obviousShortfall([], ['A list of file names on the desktop', 'A count of the number of files']), null);
  // But "a PDF", "the document", "an image" still owe their artifact.
  assert.match(obviousShortfall([], ['A PDF of the summary']) || '', /no file/i);
  assert.match(obviousShortfall([], ['The document with the findings']) || '', /no file/i);
  // "the file path to python" is a locator, not an owed file.
  assert.equal(obviousShortfall([], ['The file path(s) to the Python executable(s) found on the system']), null);
  assert.equal(obviousShortfall([], ['The file name of the newest download']), null);
});

test('a delete or move owes no file left behind', () => {
  // "delete file5.txt" and "move file4.txt to Documents" end with nothing in
  // the workspace, and that is the job done — not "no file was produced".
  assert.equal(obviousShortfall([], ['file5.txt deleted from the test_output folder']), null);
  assert.equal(obviousShortfall([], ['file4.txt moved to my Documents folder']), null);
  // A copy or a report still owes its file.
  assert.match(obviousShortfall([], ['file3.txt copied to file3_backup.txt']) || '', /no file/i);
  assert.match(obviousShortfall([], ['A summary in report.pdf']) || '', /no file/i);
});

test('a file operation proven by its command check needs no model judge', () => {
  const op = (deliverable, status = 'ok') => ({
    steps: [{ kind: 'shell', verify: "Test-Path 'x'", status }],
    understanding: { deliverables: [deliverable] },
  });
  assert.equal(provenByCommands(op('file3.txt copied to file3_backup.txt')), true);
  assert.equal(provenByCommands(op('The file file2.txt is renamed to file2_renamed.txt')), true);
  assert.equal(provenByCommands(op('file5.txt deleted from the folder')), true);
  // A step whose check did not pass is not proven — the judge is not skipped.
  assert.equal(provenByCommands(op('file3.txt copied to file3_backup.txt', 'failed')), false);
  // Authored content always faces the judge, however it was produced.
  assert.equal(provenByCommands(op('A report on flight prices in report.html')), false);
  // A research step is not a shell command, so it is never waved through.
  assert.equal(
    provenByCommands({ steps: [{ kind: 'research', verify: null, status: 'ok' }], understanding: { deliverables: ['file copied'] } }),
    false,
  );
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

test('an explicit category wins over inference, an unknown one is ignored', () => {
  assert.equal(categorize({ category: 'operation', steps: [{ kind: 'delegate' }] }), 'operation');
  assert.equal(
    categorize({ understanding: { category: 'research', deliverables: [] }, steps: [{ kind: 'shell' }] }),
    'research',
  );
  // A category nobody knows is not trusted — fall back to the plan's shape.
  assert.equal(
    categorize({ category: 'magic', steps: [{ kind: 'shell' }], understanding: { deliverables: [] } }),
    'operation',
  );
});

test('categorize infers each category from the shape of the plan', () => {
  // Gathering material and writing it up.
  assert.equal(
    categorize({ steps: [{ kind: 'web' }, { kind: 'compose' }], understanding: { deliverables: ['The findings'] } }),
    'research',
  );
  assert.equal(
    categorize({ steps: [{ kind: 'shell' }], understanding: { deliverables: ['A report on flight prices'] } }),
    'research',
  );
  // Building something: files owed, or a coding tool doing the building.
  assert.equal(
    categorize({ steps: [{ kind: 'delegate' }], understanding: { deliverables: ['The bug fixed'] } }),
    'coding',
  );
  assert.equal(
    categorize({ steps: [{ kind: 'shell' }], understanding: { deliverables: ['The results in out.csv'] } }),
    'coding',
  );
  // The machine's state is the deliverable.
  assert.equal(
    categorize({ steps: [{ kind: 'web' }], understanding: { deliverables: ['The form submitted'] } }),
    'browser',
  );
  assert.equal(
    categorize({ steps: [{ kind: 'computer' }], understanding: { deliverables: ['The window closed'] } }),
    'browser',
  );
  // Commands and nothing else.
  assert.equal(
    categorize({
      steps: [{ kind: 'shell' }, { kind: 'shell' }],
      understanding: { deliverables: ['The browser restarted with the profile loaded'] },
    }),
    'operation',
  );
});

test('shortfalls are judged against the category', () => {
  // An operation mission owes verified commands, not files: "restart the
  // browser" ends with zero artifacts and is done.
  assert.equal(obviousShortfall([], ['The browser restarted with the profile loaded'], { category: 'operation' }), null);
  assert.equal(obviousShortfall([], ['The test suite passing'], { category: 'operation' }), null);

  // Research owes a report; coding owes its files.
  assert.match(obviousShortfall([], ['A PDF summarising the support thread'], { category: 'research' }) || '', /no file/i);
  assert.match(obviousShortfall([], ['The results in out.csv'], { category: 'coding' }) || '', /no file/i);

  // A browser mission owes a verified state, not a file.
  assert.match(
    obviousShortfall([], ['The form submitted'], {
      category: 'browser',
      steps: [{ kind: 'web', verify: '', status: 'ok' }],
    }) || '',
    /never verified/i,
  );
  assert.equal(
    obviousShortfall([], ['The form submitted'], {
      category: 'browser',
      steps: [{ kind: 'web', verify: 'Test-Path x', status: 'ok' }],
    }),
    null,
  );
});
