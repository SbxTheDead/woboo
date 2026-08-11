// Undo and rollback.
//
// Before a risky operation (file edit, install, delete), Woboo snapshots the
// affected files. If the verify step fails, it can roll back to the snapshot.
// This is not a full filesystem snapshot — just the files about to change.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, ensureHome } from './config.mjs';
import { record } from './journal.mjs';

const SNAP_DIR = () => {
  const d = path.join(PATHS.home, 'snapshots');
  ensureHome();
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export function snapshot(files) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(SNAP_DIR(), id);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = { id, created: new Date().toISOString(), files: [] };

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) {
        const dest = path.join(dir, path.basename(file));
        fs.copyFileSync(file, dest);
        manifest.files.push({ original: file, snapshot: dest, size: stat.size });
      }
    } catch {
      // File doesn't exist yet — that is fine, rollback will delete it.
      manifest.files.push({ original: file, snapshot: null, size: 0 });
    }
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  record('snapshot', 'created: ' + id + ' (' + files.length + ' files)', { level: 'info' });
  return id;
}

export function rollback(snapshotId) {
  const dir = path.join(SNAP_DIR(), snapshotId);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    for (const entry of manifest.files) {
      if (entry.snapshot && fs.existsSync(entry.snapshot)) {
        fs.copyFileSync(entry.snapshot, entry.original);
      } else {
        // File didn't exist before — remove the new one.
        try { fs.unlinkSync(entry.original); } catch { /* already gone */ }
      }
    }
    // Clean up snapshot dir.
    fs.rmSync(dir, { recursive: true, force: true });
    record('snapshot', 'rolled back: ' + snapshotId, { level: 'ok' });
    return true;
  } catch (err) {
    record('snapshot', 'rollback failed: ' + err.message, { level: 'error' });
    return false;
  }
}

export function cleanOld(maxAgeDays = 7) {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(SNAP_DIR())) {
      const dir = path.join(SNAP_DIR(), entry);
      const stat = fs.statSync(dir);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    }
  } catch {
    // Best effort.
  }
  return removed;
}

export function list() {
  try {
    return fs.readdirSync(SNAP_DIR()).filter((f) => {
      return fs.statSync(path.join(SNAP_DIR(), f)).isDirectory();
    }).map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(SNAP_DIR(), id, 'manifest.json'), 'utf8'));
      } catch {
        return { id, files: [], created: 'unknown' };
      }
    });
  } catch {
    return [];
  }
}
