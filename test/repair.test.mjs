// A sentence is not a command.
//
// A repair came back as "Use a properly escaped single-quoted string with
// backtick-n for newlines: powershell -Command ..." — advice with the command
// bolted on the end — and it was executed verbatim, so the shell tried to run
// the word "Use".
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripAdvice } from '../src/foreman.mjs';

test('pulls the command out of the explanation', () => {
  const real =
    'Use a properly escaped single-quoted string with backtick-n for newlines: ' +
    'powershell -Command "Set-Content -Path D:\\wobo\\extract.py -Value x"';
  assert.match(stripAdvice(real), /^powershell -Command/);
});

test('finds a command on the line after the advice', () => {
  const withNewline = 'The path needs forward slashes.\npython -c "print(1)"';
  assert.equal(stripAdvice(withNewline), 'python -c "print(1)"');
});

test('leaves a plain command exactly as it is', () => {
  for (const command of [
    'npm test',
    "if (Test-Path 'x') { exit 0 } else { exit 1 }",
    'git commit -m "a message with a colon: like this"',
    'New-Item -ItemType Directory -Force D:\\out',
    '$env:FOO = "bar"; node build.mjs',
    './scripts/build.sh',
    'pip install --quiet PyPDF2',
  ]) {
    assert.equal(stripAdvice(command), command, `${command} was mangled`);
  }
});

test('advice with no command at all is refused, not run', () => {
  // Better to keep the original failing command than to run an English sentence:
  // at least the failure is the one already diagnosed.
  assert.equal(stripAdvice('The command failed because the path was wrong.'), '');
  assert.equal(stripAdvice('Try quoting the path differently.'), '');
  assert.equal(stripAdvice(''), '');
});
