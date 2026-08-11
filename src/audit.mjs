// Append-only audit log for security-sensitive decisions, kept apart from the
// journal on purpose: the journal is a live feed that rotates once it passes
// its cap, the audit log is never capped or rewritten. What was asked and
// what the owner decided has to survive for the life of the installation —
// that is the evidence behind "every important action is verified".
//
// One JSON object per line: { t, event, detail, decision }.

import fs from 'node:fs';
import { PATHS, ensureHome } from './config.mjs';

export function audit(event, detail, decision) {
  const entry = { t: new Date().toISOString(), event, detail, decision };
  try {
    ensureHome();
    fs.appendFileSync(PATHS.audit, `${JSON.stringify(entry)}\n`);
  } catch {
    // Same rule as the journal: a disk that refuses the write must not fail
    // the step that produced it.
  }
  return entry;
}
