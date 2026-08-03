// The journal is the audit trail and the dashboard's live feed, and it lives
// for the whole installation. Two bounds keep it honest: tail() reads only the
// end of the file, and record() caps the file once it passes half a megabyte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// HOME is fixed at import time in config.mjs, so point it at a scratch dir
// before any Woboo module is loaded — never at the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-journal-'));
process.env.WOBOO_HOME = home;

const { record, tail } = await import('../src/journal.mjs');
const { PATHS } = await import('../src/config.mjs');

test('what was recorded is what the tail returns', () => {
  record('test', 'first line');
  record('test', 'second line', { level: 'warn' });
  const entries = tail(10);
  assert.ok(entries.length >= 2);
  const last = entries.at(-1);
  assert.equal(last.msg, 'second line');
  assert.equal(last.kind, 'test');
  assert.equal(last.level, 'warn');
});

test('tail reads the end of a large file, not all of it', () => {
  // 3,000 lines is past the 64 KB read window, so a whole-file read and a
  // seek-from-the-end read only agree if the seek is right.
  for (let i = 1; i <= 3000; i += 1) record('fill', `line ${i} of many`);
  const entries = tail(50);
  assert.equal(entries.length, 50, 'asked for 50, the file has thousands');
  assert.equal(entries.at(-1).msg, 'line 3000 of many');
  assert.equal(entries[0].msg, 'line 2951 of many');
});

test('a missing journal tails to nothing rather than throwing', () => {
  fs.rmSync(PATHS.journal, { force: true });
  assert.deepEqual(tail(20), []);
});

test('the journal is capped, and the cap lands on a line boundary', () => {
  fs.rmSync(PATHS.journal, { force: true });
  // ~260 bytes a line: 2,400 of them pass the 512 KB cap and force rotation.
  const filler = 'x'.repeat(200);
  for (let i = 1; i <= 2400; i += 1) record('cap', `${filler} ${i}`);

  const { size } = fs.statSync(PATHS.journal);
  assert.ok(size < 512 * 1024 + 300, `the journal grew past its cap: ${size} bytes`);
  assert.ok(size > 100 * 1024, `the cap kept far too little: ${size} bytes`);

  // Every surviving line must still parse — a mid-line cut would corrupt one.
  for (const line of fs.readFileSync(PATHS.journal, 'utf8').trim().split('\n')) {
    assert.doesNotThrow(() => JSON.parse(line), 'rotation cut a line in half');
  }

  const entries = tail(5);
  assert.equal(entries.length, 5);
  assert.ok(entries.at(-1).msg.endsWith(' 2400'), 'the newest entries survived the cap');
});
