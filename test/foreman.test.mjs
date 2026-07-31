// A verify step that cannot fail is worse than no verify step: the mission
// reports success and the work was never done. `Test-Path 'missing'` prints
// False and exits 0, which is exactly how that happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asExitCode } from '../src/foreman.mjs';

const WRAPPED = [
  "Test-Path 'D:\\out.pdf'",
  '(Get-Content x.txt) -match "hello"',
  '(Get-Item out.pdf).Length -gt 1000',
];

const LEFT_ALONE = [
  // Tools that already set a meaningful exit code.
  'npm test',
  'git diff --exit-code',
  'pytest -q',
  'node --check src/foreman.mjs',
  // Already says how it ends.
  "if (Test-Path 'x') { exit 0 } else { exit 1 }",
];

test('a truthy PowerShell check becomes a real exit code', { skip: process.platform !== 'win32' }, () => {
  for (const command of WRAPPED) {
    const got = asExitCode(command);
    assert.notEqual(got, command, `${command} was left as-is and can never fail`);
    assert.match(got, /exit 1/, `${command} has no failing branch`);
  }
});

test('commands that set their own exit code are untouched', { skip: process.platform !== 'win32' }, () => {
  for (const command of LEFT_ALONE) {
    assert.equal(asExitCode(command), command, `${command} should not be wrapped`);
  }
});

test('empty stays empty', () => {
  assert.equal(asExitCode(''), '');
  assert.equal(asExitCode(null), '');
});
