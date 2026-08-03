// Append-only record of everything Woboo did. Two jobs: it is the audit trail
// that makes a machine-driving agent trustworthy, and it is the live feed the
// dashboard terminal renders.
//
// The file lives for the whole installation and is read back constantly —
// every dashboard snapshot tails it — so both operations are bounded: tail()
// reads only the end of the file, and record() rewrites it down to the most
// recent entries once it passes the cap. Neither cost grows with the journal.

import fs from 'node:fs';
import { PATHS, ensureHome } from './config.mjs';
import { publish } from './bus.mjs';

// Past the cap the oldest half is dropped; a running total is kept in memory
// so the check costs no syscall per line. Another Woboo process appending to
// the same file only makes the total stale, which delays rotation a little —
// the cap is a bound on growth, not an exact watermark.
const MAX_BYTES = 512 * 1024;
const KEEP_BYTES = 256 * 1024;

let written = null;

function cap() {
  try {
    const data = fs.readFileSync(PATHS.journal);
    const kept = data.subarray(data.length - KEEP_BYTES);
    // Start on a line boundary so every surviving line still parses.
    const cut = kept.indexOf(0x0a);
    const body = cut >= 0 ? kept.subarray(cut + 1) : kept;
    fs.writeFileSync(PATHS.journal, body);
    written = body.length;
  } catch {
    // A locked or unreadable journal must not take the mission down with it.
  }
}

// level drives the colour in the UI terminal, nothing else.
export function record(kind, msg, extra = {}) {
  const entry = { t: new Date().toISOString(), kind, msg, ...extra };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    ensureHome();
    if (written === null) {
      try {
        written = fs.statSync(PATHS.journal).size;
      } catch {
        written = 0;
      }
    }
    fs.appendFileSync(PATHS.journal, line);
    written += Buffer.byteLength(line);
    if (written > MAX_BYTES) cap();
  } catch {
    // The journal is the audit trail, not the work: a disk that refuses the
    // write must not fail the step that produced it.
  }
  publish({ type: 'log', kind, msg, level: extra.level || 'info' });
  return entry;
}

export function tail(n = 120) {
  let fd = null;
  try {
    fd = fs.openSync(PATHS.journal, 'r');
    const { size } = fs.fstatSync(fd);
    // The last n lines can only live at the end of the file; reading the whole
    // journal for every snapshot got slower the longer Woboo ran.
    const span = Math.min(size, Math.max(64 * 1024, n * 512));
    const buffer = Buffer.alloc(span);
    fs.readSync(fd, buffer, 0, span, size - span);
    let text = buffer.toString('utf8').trim();
    if (size > span) {
      // The window can open mid-line; the partial first line is dropped.
      const firstBreak = text.indexOf('\n');
      text = firstBreak < 0 ? '' : text.slice(firstBreak + 1);
    }
    if (!text) return [];
    return text
      .split('\n')
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
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing sensible to do with a failed close.
      }
    }
  }
}
