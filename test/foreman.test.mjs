// A verify step that cannot fail is worse than no verify step: the mission
// reports success and the work was never done. `Test-Path 'missing'` prints
// False and exits 0, which is exactly how that happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asExitCode,
  verifyReliesOnExitState,
  unescapePaths,
  tolerateWhitespaceInComparison,
} from '../src/foreman.mjs';

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

test('a whole-file comparison tolerates the BOM and newline the writer added', () => {
  // The real failure: Set-Content -Encoding UTF8 wrote a byte-order mark and a
  // trailing CRLF, so a file holding exactly "hello world" read back as 13
  // characters and `$content -eq 'hello world'` was false. Three attempts, a
  // perfect file, and a step reported unprovable.
  const literal = "if (Test-Path 'f.txt') { $content = Get-Content -Path 'f.txt' -Raw; if ($content -eq 'hello world') { exit 0 } else { exit 1 } }";
  assert.match(tolerateWhitespaceInComparison(literal), /\$content\.Trim\(\) -eq 'hello world'/);
  // The inline form the planner uses just as often — no intermediate variable.
  const inline = "if ((Get-Content -Path 'D:/wobo/file1.txt' -Raw) -eq 'hello world') { exit 0 } else { exit 1 }";
  assert.match(tolerateWhitespaceInComparison(inline), /-Raw\)\.Trim\(\) -eq 'hello world'/);
  // Left alone: checks that are already tolerant, and comparisons of computed
  // values where trimming would be meaningless or wrong.
  const matched = "$c = Get-Content 'f.txt' -Raw; if ($c -match 'hello') { exit 0 }";
  assert.equal(tolerateWhitespaceInComparison(matched), matched);
  const counted = "if ((Get-ChildItem).Count -eq 5) { exit 0 }";
  assert.equal(tolerateWhitespaceInComparison(counted), counted);
  assert.equal(tolerateWhitespaceInComparison(''), '');
});

test('a dropped backslash after a drive letter is restored', () => {
  // The real failure: NIM emitted D:wobo/file1.txt, PowerShell resolved it
  // against D:\wobo to D:\wobo\wobo\file1.txt, and every write missed.
  assert.equal(unescapePaths("Set-Content -Path 'D:wobo/file1.txt' -Value x"), "Set-Content -Path 'D:\\wobo/file1.txt' -Value x");
  assert.equal(unescapePaths("Test-Path 'D:wobo\\file1.txt'"), "Test-Path 'D:\\wobo\\file1.txt'");
  // Left alone: a drive already separated, and multi-letter PowerShell drives.
  assert.equal(unescapePaths("Get-ChildItem 'C:\\Users\\asus'"), "Get-ChildItem 'C:\\Users\\asus'");
  assert.equal(unescapePaths('Write-Output $env:PATH'), 'Write-Output $env:PATH');
  assert.equal(unescapePaths('Test-Path Variable:PATH'), 'Test-Path Variable:PATH');
  assert.equal(unescapePaths('Get-Item HKLM:\\SOFTWARE'), 'Get-Item HKLM:\\SOFTWARE');
});

test('a check that only reads $LASTEXITCODE or $? cannot prove anything here', () => {
  // Each command runs in its own PowerShell, so the step command's exit code
  // is gone by the time the verify runs — the command's own result is the proof.
  assert.equal(verifyReliesOnExitState('if ($LASTEXITCODE -eq 0) { exit 0 } else { exit 1 }'), true);
  assert.equal(verifyReliesOnExitState('if ($?) { exit 0 } else { exit 1 }'), true);
  // A real check of state is genuine and must still run, even next to $LASTEXITCODE.
  assert.equal(verifyReliesOnExitState("if ((Test-Path 'x.txt') -and $LASTEXITCODE -eq 0) { exit 0 }"), false);
  assert.equal(verifyReliesOnExitState("Test-Path 'out.pdf'"), false);
  assert.equal(verifyReliesOnExitState('(Get-ChildItem).Count -gt 0'), false);
  assert.equal(verifyReliesOnExitState(''), false);
});
