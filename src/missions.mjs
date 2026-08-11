// Persisting missions to disk so they survive a crash and can be browsed
// later. Every state transition writes the current mission snapshot; a crashed
// process leaves behind exactly what was proven and what was not.
//
// The history is what the dashboard shows when no mission is running: a list
// of what was asked, what happened, and how long it took.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureHome } from './config.mjs';

const DIR = () => {
  const d = PATHS.missions;
  ensureHome();
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function file(id) {
  return path.join(DIR(), id + '.json');
}

export function save(mission) {
  if (!mission?.id) return;
  try {
    fs.writeFileSync(file(mission.id), JSON.stringify(mission, null, 2) + '\n');
  } catch {
    // A disk that refuses the write must not fail the mission.
  }
}

export function load(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return null;
  }
}

export function remove(id) {
  try {
    fs.unlinkSync(file(id));
  } catch {
    // Already gone.
  }
}

export function history(limit = 50) {
  try {
    const dir = DIR();
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ name: f, stat: fs.statSync(path.join(dir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, limit);

    return files.map(({ name }) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        return {
          id: m.id,
          task: m.task,
          state: m.state,
          report: m.report,
          steps: (m.steps || []).length,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          duration: m.endedAt && m.startedAt ? Math.round((m.endedAt - m.startedAt) / 1000) : null,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function purge(olderThanDays = 30) {
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  let removed = 0;
  try {
    const dir = DIR();
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const fp = path.join(dir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed += 1;
      }
    }
  } catch {
    // Best effort.
  }
  return removed;
}

export function exportAll() {
  return history(10000);
}
