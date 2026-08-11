// Cleaning up the data Woboo accumulates: old screenshots, old missions, and
// the audit log when it grows past its bound. Run on boot and periodically.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureHome } from './config.mjs';

// Screenshots older than this are removed.
const SHOT_TTL_MS = 7 * 86_400_000; // 7 days

// Audit log is rotated when it passes this size.
const AUDIT_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const AUDIT_KEEP_BYTES = 512 * 1024; // 512KB

export function cleanShots() {
  let removed = 0;
  try {
    const dir = PATHS.shots;
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - SHOT_TTL_MS;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed += 1;
        }
      } catch {
        // Skip files that cannot be stat'd.
      }
    }
  } catch {
    // Best effort.
  }
  return removed;
}

export function rotateAudit() {
  try {
    const stat = fs.statSync(PATHS.audit);
    if (stat.size <= AUDIT_MAX_BYTES) return false;
    const data = fs.readFileSync(PATHS.audit);
    const kept = data.subarray(data.length - AUDIT_KEEP_BYTES);
    const cut = kept.indexOf(0x0a);
    const body = cut >= 0 ? kept.subarray(cut + 1) : kept;
    const tmp = PATHS.audit + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, PATHS.audit);
    return true;
  } catch {
    return false;
  }
}

export function runAll() {
  const shots = cleanShots();
  const auditRotated = rotateAudit();
  return { shotsRemoved: shots, auditRotated };
}
