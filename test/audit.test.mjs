// The audit log is the evidence trail for security-sensitive decisions: what
// was asked, and what the owner answered. Unlike the journal it never rotates,
// so the tests only need append-and-read-back — plus proof that the guard's
// approval flow actually writes to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// HOME is fixed at import time in config.mjs, so point it at a scratch dir
// before any Woboo module is loaded — never at the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-audit-'));
process.env.WOBOO_HOME = home;

const { audit } = await import('../src/audit.mjs');
const { PATHS } = await import('../src/config.mjs');
const { requestApproval, resolveApproval, pendingApprovals, clearToRun, clearStop, Refused } =
  await import('../src/guard.mjs');

function readAudit() {
  return fs
    .readFileSync(PATHS.audit, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('what was audited is read back, one JSON object per line', () => {
  audit('test event', 'something happened', 'observed');
  audit('test event', 'something else', 'allowed');

  const entries = readAudit();
  assert.ok(entries.length >= 2);
  const last = entries.at(-1);
  assert.equal(last.event, 'test event');
  assert.equal(last.detail, 'something else');
  assert.equal(last.decision, 'allowed');
  assert.ok(last.t, 'every entry carries a timestamp');
});

test('an approval resolution lands in the audit log', async () => {
  clearStop();
  const granted = requestApproval({ kind: 'run command', detail: 'calc.exe' });
  const { id } = pendingApprovals().at(-1);
  resolveApproval(id, 'allow');
  assert.equal(await granted, true);

  const entries = readAudit();
  assert.ok(
    entries.some((e) => e.event === 'approval' && e.detail.includes('calc.exe') && e.decision === 'allowed'),
    'the allowed resolution was audited'
  );
});

test('a state-dir write ask is audited when issued, and its denial when answered', async () => {
  clearStop();
  const cmd = 'Set-Content ~/.woboo/settings.json "{\\"hands\\":\\"allow\\"}"';
  const outcome = clearToRun(cmd).catch((err) => err);
  const { id } = pendingApprovals().at(-1);
  resolveApproval(id, 'deny');
  const err = await outcome;
  assert.ok(err instanceof Refused, 'a denied ask refuses the command');

  const entries = readAudit();
  assert.ok(
    entries.some((e) => e.event === 'self-config write' && e.detail === cmd && e.decision === 'asked'),
    'the ask itself was audited'
  );
  assert.ok(
    entries.some((e) => e.event === 'approval' && e.detail.includes(cmd) && e.decision.startsWith('denied')),
    'the denial was audited'
  );
});
