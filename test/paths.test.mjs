// Paths that arrived with their separators doubled.
//
// The planner emitted  Test-Path 'D:\\wobo\\tmp'  — an artefact of the plan
// travelling as JSON. In a single-quoted PowerShell string a backslash is
// literal, so that is a path with doubled separators: not what was meant, and
// not reliably tolerated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unescapePaths } from '../src/foreman.mjs';

test('collapses doubled separators inside quoted paths', () => {
  assert.equal(unescapePaths(String.raw`Test-Path 'D:\\wobo\\tmp'`), String.raw`Test-Path 'D:\wobo\tmp'`);
  assert.equal(
    unescapePaths(String.raw`New-Item -ItemType Directory 'D:\\wobo\\out\\reports'`),
    String.raw`New-Item -ItemType Directory 'D:\wobo\out\reports'`,
  );
});

test('leaves correct paths alone', () => {
  for (const command of [
    String.raw`Test-Path 'D:\wobo\tmp'`,
    'npm test',
    "git commit -m 'a message with no path'",
    String.raw`Get-Content 'C:\Users\asus\.woboo\settings.json'`,
  ]) {
    assert.equal(unescapePaths(command), command, `${command} should be untouched`);
  }
});

test('does not touch text that merely contains backslashes outside quotes', () => {
  const command = String.raw`Write-Output "a\\b"`;
  assert.equal(unescapePaths(command), command);
});
