// Which Woboo owns the phone.
//
// Telegram allows one long-polling consumer per bot. Woboo used to treat a
// conflict as final, so a single stray poll from anywhere left the bot deaf
// until it was restarted, with nothing on screen to say why. The lock decides
// who polls; everything here is a case that would silently break Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../src/config.mjs';
import { __lock } from '../src/telegram.mjs';

const { holdLock, lockHolder, releaseLock } = __lock;
const LOCK = path.join(PATHS.home, 'telegram.lock');

// pid 4 is the Windows System process: certainly alive, certainly not us, and
// signalling it fails with EPERM rather than ESRCH — which is the case that
// made Woboo steal a live peer's lock.
const LIVE_STRANGER = process.platform === 'win32' ? 4 : 1;

const clean = () => {
  try {
    fs.unlinkSync(LOCK);
  } catch {
    // Nothing to clean.
  }
};

test.beforeEach(clean);
test.after(clean);

test('a free lock can be taken, and taken again by the same process', () => {
  assert.equal(holdLock(), true);
  assert.equal(holdLock(), true);
  assert.equal(lockHolder().pid, process.pid);
});

test('a live peer keeps its lock', () => {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: LIVE_STRANGER, at: Date.now() }));
  assert.equal(holdLock(), false, 'stealing this would have two Woboos fighting over the phone');
});

test('a lock whose heartbeat stopped is free', () => {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: LIVE_STRANGER, at: Date.now() - 60_000 }));
  assert.equal(holdLock(), true);
});

test('a lock held by a dead process is free', () => {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999_999, at: Date.now() }));
  assert.equal(holdLock(), true, 'a killed Woboo must not silence Telegram forever');
});

test('a corrupt lock file does not wedge Telegram shut', () => {
  fs.writeFileSync(LOCK, 'not json at all');
  assert.equal(holdLock(), true);
});

test('releasing removes our own lock and leaves a stranger alone', () => {
  holdLock();
  releaseLock();
  assert.equal(fs.existsSync(LOCK), false);

  fs.writeFileSync(LOCK, JSON.stringify({ pid: LIVE_STRANGER, at: Date.now() }));
  releaseLock();
  assert.equal(fs.existsSync(LOCK), true, "another Woboo's lock is not ours to drop");
});
