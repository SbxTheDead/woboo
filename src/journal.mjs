// Append-only record of everything Woboo did. Two jobs: it is the audit trail
// that makes a machine-driving agent trustworthy, and it is the live feed the
// dashboard terminal renders.

import fs from 'node:fs';
import { PATHS, ensureHome } from './config.mjs';
import { publish } from './bus.mjs';

let stream = null;

function sink() {
  if (!stream) {
    ensureHome();
    stream = fs.createWriteStream(PATHS.journal, { flags: 'a' });
  }
  return stream;
}

// level drives the colour in the UI terminal, nothing else.
export function record(kind, msg, extra = {}) {
  const entry = { t: new Date().toISOString(), kind, msg, ...extra };
  sink().write(`${JSON.stringify(entry)}\n`);
  publish({ type: 'log', kind, msg, level: extra.level || 'info' });
  return entry;
}

export function tail(n = 120) {
  try {
    const lines = fs.readFileSync(PATHS.journal, 'utf8').trim().split('\n');
    return lines
      .slice(-n)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
