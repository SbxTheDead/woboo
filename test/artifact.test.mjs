// The file the plan guessed at, versus the one that got made.
//
// A step that writes a document names it after its own content — a research
// step wrote internship-opportunities-in-china-for-rayane-sbaac.pdf — while the
// plan, drawn up before any of it existed, guessed internships.pdf. Reading,
// sending and checking a file all need the same answer, and all three got it
// wrong at least once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orArtifact } from '../src/foreman.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-artifact-'));
const made = path.join(dir, 'internship-opportunities-in-china-for-rayane-sbaac.pdf');
const alsoMade = path.join(dir, 'report.html');
fs.writeFileSync(made, '%PDF-1.4');
fs.writeFileSync(alsoMade, '<html></html>');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a guessed name falls back to what was actually produced', () => {
  const guessed = path.join(dir, 'internships.pdf');
  assert.equal(orArtifact(guessed, [made]), made);
});

test('an existing file is never replaced', () => {
  assert.equal(orArtifact(made, [alsoMade, made]), made);
});

test('the extension has to match, or it is the wrong file', () => {
  const guessed = path.join(dir, 'notes.txt');
  assert.equal(orArtifact(guessed, [made]), guessed, 'a PDF must not stand in for a text file');
});

test('the most recent match wins when several were produced', () => {
  const older = path.join(dir, 'first.pdf');
  fs.writeFileSync(older, '%PDF-1.4');
  assert.equal(orArtifact(path.join(dir, 'guessed.pdf'), [older, made]), made);
});

test('nothing produced means the guess stands, so the error names what was asked for', () => {
  const guessed = path.join(dir, 'internships.pdf');
  assert.equal(orArtifact(guessed, []), guessed);
});

test('an artifact recorded but since deleted is not offered', () => {
  const gone = path.join(dir, 'deleted.pdf');
  assert.equal(orArtifact(path.join(dir, 'guessed.pdf'), [gone]), path.join(dir, 'guessed.pdf'));
});
