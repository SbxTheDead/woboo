// Mission replay.
//
// Re-run a past mission with the same task. Optionally with modifications.
// Loads the mission from disk and submits it again.

import { load } from './missions.mjs';
import * as foreman from './foreman.mjs';
import { record } from './journal.mjs';

export async function replay(missionId, { modify } = {}) {
  const original = load(missionId);
  if (!original) throw new Error('mission not found: ' + missionId);

  const task = modify ? modify(original.task) : original.task;
  record('replay', 'replaying mission ' + missionId + ': ' + task.slice(0, 80), { level: 'info' });

  const mission = await foreman.runMission(task);
  return {
    originalId: missionId,
    originalTask: original.task,
    newMission: mission,
  };
}
