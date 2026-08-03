// A delegate step is the one place work happens outside Woboo's command guard:
// the coding tool answers to its own permissions, not to the allowlist. These
// tests pin the argv a briefing spawns with — the trust boundary is the flags,
// so the flags are what gets tested. No crew tool is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingArgs } from '../src/crew.mjs';

test('claude is briefed in acceptEdits mode with destructive shell denied', () => {
  const argv = briefingArgs('claude', 'add a test');
  assert.equal(argv[0], '-p');
  assert.deepEqual(argv.slice(1, 3), ['--permission-mode', 'acceptEdits']);
  const denied = argv[argv.indexOf('--disallowedTools') + 1];
  assert.match(denied, /Bash\(rm -rf:\*\)/);
  assert.match(denied, /Bash\(git push --force:\*\)/);
  assert.match(denied, /Bash\(git reset --hard:\*\)/);
});

test('codex is briefed inside a workspace-write sandbox', () => {
  const argv = briefingArgs('codex', 'add a test');
  assert.equal(argv[0], 'exec');
  assert.deepEqual(argv.slice(1, 3), ['--sandbox', 'workspace-write']);
});

test('the instruction stays one argv entry, flags never swallow it', () => {
  const instruction = 'fix the "quoted" bug && don\'t rm -rf /';
  for (const name of ['claude', 'codex']) {
    const argv = briefingArgs(name, instruction);
    assert.equal(argv.at(-1), instruction);
    assert.equal(argv.filter((a) => a === instruction).length, 1);
  }
});

test('crewTrust full is the only way the tool gets everything', () => {
  assert.deepEqual(briefingArgs('claude', 'x', 'full'), ['-p', '--permission-mode', 'bypassPermissions', 'x']);
  assert.deepEqual(briefingArgs('codex', 'x', 'full'), ['exec', '--sandbox', 'danger-full-access', 'x']);
});

test('guarded is the default and any unknown value stays guarded', () => {
  assert.deepEqual(briefingArgs('claude', 'x'), briefingArgs('claude', 'x', 'guarded'));
  assert.deepEqual(briefingArgs('codex', 'x', 'typo'), briefingArgs('codex', 'x', 'guarded'));
  assert.ok(!briefingArgs('claude', 'x', 'typo').includes('bypassPermissions'));
});
