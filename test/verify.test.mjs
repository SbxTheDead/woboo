// A check that cannot run proves nothing.
//
// The planner wrote `if (Test-Path 'x') -and ((Get-Item 'x').Length -gt 0)) {
// exit 0 } else { exit 1 }` — one bracket too many. PowerShell refused to parse
// it and exited 1, so the step was declared unproven and re-run twice more with
// the identical broken command: three failures, three identical errors, and a
// report blaming work that had been done correctly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIsMalformed } from '../src/foreman.mjs';

test('catches the bracket that cost three attempts', () => {
  const real = `if (Test-Path 'D:\\wobo\\emails.txt') -and ((Get-Item 'D:\\wobo\\emails.txt').Length -gt 0)) { exit 0 } else { exit 1 }`;
  assert.match(verifyIsMalformed(real) || '', /parenthesis/);
});

test('catches unclosed brackets of every kind', () => {
  assert.ok(verifyIsMalformed('if (Test-Path "x") { exit 0'));
  assert.ok(verifyIsMalformed('Get-Item x | Select-Object -First 1)'));
  assert.ok(verifyIsMalformed('$a = @(1, 2'));
});

test('leaves well-formed checks alone', () => {
  for (const command of [
    'npm test',
    "if (Test-Path 'D:\\out.pdf') { exit 0 } else { exit 1 }",
    "if ((Test-Path 'x') -and ((Get-Item 'x').Length -gt 0)) { exit 0 } else { exit 1 }",
    'git diff --exit-code',
    '',
  ]) {
    assert.equal(verifyIsMalformed(command), null, `${command} is fine and was called malformed`);
  }
});

test('brackets inside quotes are data, not syntax', () => {
  // A path is allowed to contain anything at all.
  assert.equal(verifyIsMalformed(`Test-Path 'C:\\a (copy)\\b.txt'`), null);
  assert.equal(verifyIsMalformed(`Write-Output "a ) b { c"`), null);
});
