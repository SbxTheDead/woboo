// Collaborative mode.
//
// Multiple Woboo instances can work on the same task by splitting it into
// sub-tasks and coordinating through a shared state file. One instance is the
// "leader" that splits the work; others are "workers" that pick up sub-tasks.
//
// This is a simple file-based coordination — not a distributed system. For
// real multi-machine collaboration, use a message queue.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, ensureHome } from './config.mjs';
import { record } from './journal.mjs';

const COLLAB_DIR = () => {
  const d = path.join(PATHS.home, 'collab');
  ensureHome();
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export function createSession(task, subtasks) {
  const id = crypto.randomBytes(8).toString('hex');
  const session = {
    id,
    task,
    subtasks: subtasks.map((t, i) => ({
      id: i,
      task: t,
      state: 'pending',
      worker: null,
      result: null,
    })),
    created: new Date().toISOString(),
    leader: process.pid,
  };
  fs.writeFileSync(path.join(COLLAB_DIR(), id + '.json'), JSON.stringify(session, null, 2));
  record('collab', 'session created: ' + id + ' (' + subtasks.length + ' subtasks)', { level: 'ok' });
  return session;
}

export function loadSession(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(COLLAB_DIR(), id + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function claimTask(sessionId, workerId) {
  const session = loadSession(sessionId);
  if (!session) return null;
  const task = session.subtasks.find((t) => t.state === 'pending');
  if (!task) return null;
  task.state = 'claimed';
  task.worker = workerId;
  task.claimedAt = new Date().toISOString();
  fs.writeFileSync(path.join(COLLAB_DIR(), sessionId + '.json'), JSON.stringify(session, null, 2));
  record('collab', 'task ' + task.id + ' claimed by ' + workerId, { level: 'info' });
  return task;
}

export function completeTask(sessionId, taskId, result) {
  const session = loadSession(sessionId);
  if (!session) return false;
  const task = session.subtasks.find((t) => t.id === taskId);
  if (!task) return false;
  task.state = 'done';
  task.result = result;
  task.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(COLLAB_DIR(), sessionId + '.json'), JSON.stringify(session, null, 2));
  record('collab', 'task ' + taskId + ' completed', { level: 'ok' });
  return true;
}

export function sessionStatus(sessionId) {
  const session = loadSession(sessionId);
  if (!session) return null;
  return {
    id: session.id,
    task: session.task,
    total: session.subtasks.length,
    done: session.subtasks.filter((t) => t.state === 'done').length,
    pending: session.subtasks.filter((t) => t.state === 'pending').length,
    claimed: session.subtasks.filter((t) => t.state === 'claimed').length,
  };
}

export function listSessions() {
  try {
    return fs.readdirSync(COLLAB_DIR())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(COLLAB_DIR(), f), 'utf8'));
        } catch { return null; }
      })
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        task: s.task,
        subtasks: s.subtasks.length,
        created: s.created,
      }));
  } catch {
    return [];
  }
}
