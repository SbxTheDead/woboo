// The files a shell step produced.
//
// The real failure: "create 5 empty text files named file1.txt through
// file5.txt". Five files were created on the desktop, a command proved they
// were there, and the mission was reported as a failure — "no file was produced
// at all" — because a shell step hands back an exit code and no filename, so
// nothing was ever added to the mission's list of artifacts. The acceptance
// check was reading an empty list and telling the truth about it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filesTouched } from '../src/foreman.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-artifacts-'));
const make = (name, body = '') => {
  const full = path.join(dir, name);
  fs.writeFileSync(full, body);
  return full;
};
const names = (found) => found.map((f) => path.basename(f)).sort();
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the five files a loop created are found, interpolation and all', () => {
  // The command as it was actually run. $_ is five filenames the shell knew
  // and this does not, so the directory is asked instead.
  for (const n of [1, 2, 3, 4, 5]) make(`file${n}.txt`);
  const command = `1..5 | ForEach-Object { New-Item -ItemType File -Path "${dir}\\file$_.txt" -Force | Out-Null }`;

  assert.deepEqual(names(filesTouched(command, dir, 0)), [
    'file1.txt',
    'file2.txt',
    'file3.txt',
    'file4.txt',
    'file5.txt',
  ]);
});

test('a file named by the check counts too', () => {
  const wanted = make('report.txt', 'a real report');
  const found = filesTouched(`Test-Path '${wanted}'`, dir, 0);
  assert.deepEqual(names(found), ['report.txt']);
});

test('a relative name is resolved against the step working directory', () => {
  make('notes.md', '# notes');
  assert.deepEqual(names(filesTouched("Set-Content notes.md 'x'", dir, 0)), ['notes.md']);
});

test('a file the step did not write is not claimed as its own', () => {
  // The point of the mtime gate: `Get-Content resume.txt` reads a file that was
  // already there. Claiming it would let a mission that produced nothing report
  // an artifact — the exact failure this list exists to catch.
  make('resume.txt', 'an existing document');
  const inTheFuture = Date.now() + 10_000;
  assert.deepEqual(filesTouched('Get-Content resume.txt', dir, inTheFuture), []);
});

test('a file that was named but never created is not an artifact', () => {
  assert.deepEqual(filesTouched("New-Item -Path 'nothing-wrote-this.pdf'", dir, 0), []);
});

test('a deleted file is not an artifact', () => {
  const doomed = make('temporary.txt', 'x');
  fs.rmSync(doomed);
  assert.deepEqual(filesTouched(`Remove-Item '${doomed}'`, dir, 0), []);
});

test('a directory is not a file', () => {
  fs.mkdirSync(path.join(dir, 'folder.v2'), { recursive: true });
  assert.deepEqual(filesTouched("New-Item -ItemType Directory 'folder.v2'", dir, 0), []);
});

test('an environment variable is looked up rather than guessed at', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-env-'));
  const previous = process.env.WOBOO_TEST_DIR;
  process.env.WOBOO_TEST_DIR = temp;
  try {
    fs.writeFileSync(path.join(temp, 'woboo_test.txt'), 'hello');
    const found = filesTouched('Set-Content "$env:WOBOO_TEST_DIR\\woboo_test.txt" hello', dir, 0);
    assert.deepEqual(names(found), ['woboo_test.txt']);
  } finally {
    if (previous === undefined) delete process.env.WOBOO_TEST_DIR;
    else process.env.WOBOO_TEST_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the words of a command are not mistaken for files', () => {
  // Get-ChildItem, -ItemType, New-Item: no extension, no claim.
  assert.deepEqual(filesTouched('Get-ChildItem -Path . -Recurse | Measure-Object', dir, 0), []);
  assert.deepEqual(filesTouched('https://example.com/installer.zip', dir, 0), []);
});

test('no command, no artifacts', () => {
  assert.deepEqual(filesTouched('', dir, 0), []);
  assert.deepEqual(filesTouched(null, dir, 0), []);
});
