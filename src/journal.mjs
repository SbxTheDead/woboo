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
  const tmp = `${PATHS.journal}.tmp`;
  try {
    const data = fs.readFileSync(PATHS.journal);
    const kept = data.subarray(data.length - KEEP_BYTES);
    // Start on a line boundary so every surviving line still parses.
    const cut = kept.indexOf(0x0a);
    const body = cut >= 0 ? kept.subarray(cut + 1) : kept;
    // Write the replacement next to the journal and rename it over the top, so
    // a crash mid-rotation leaves the old file or the new one, never a
    // half-written one. renameSync replaces an existing destination on both
    // Windows and POSIX.
    fs.writeFileSync(tmp, body);
    try {
      fs.renameSync(tmp, PATHS.journal);
    } catch {
      // Windows can refuse a rename over a file another process holds open;
      // the unlink-then-rename fallback works there at the price of a tiny
      // non-atomic window.
      fs.rmSync(PATHS.journal, { force: true });
      fs.renameSync(tmp, PATHS.journal);
    }
    written = body.length;
  } catch {
    // A locked or unreadable journal must not take the mission down with it.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file may never have been written.
    }
  }
}

// A kill mid-append leaves a torn final line — half a JSON object with no
// trailing newline — and appending after it would glue the next entry onto
// the garbage and lose both. Cut the file back to the last whole line.
// Returns the size after the cut, or -1 when there is no journal to heal.
function repair() {
  let fd = null;
  try {
    fd = fs.openSync(PATHS.journal, 'r+');
    const { size } = fs.fstatSync(fd);
    if (size === 0) return 0;
    const span = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(span);
    fs.readSync(fd, buffer, 0, span, size - span);
    const lastBreak = buffer.lastIndexOf(0x0a);
    if (lastBreak === span - 1) return size;
    if (lastBreak < 0) {
      // No line boundary in the window: if the window is the whole file it is
      // one torn line and goes entirely, otherwise leave it rather than guess.
      if (size === span) fs.ftruncateSync(fd, 0);
      return size === span ? 0 : size;
    }
    fs.ftruncateSync(fd, size - span + lastBreak + 1);
    return size - span + lastBreak + 1;
  } catch {
    return -1;
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

// level drives the colour in the UI terminal, nothing else.
export function record(kind, msg, extra = {}) {
  const entry = { t: new Date().toISOString(), kind, msg, ...extra };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    ensureHome();
    const healed = repair();
    if (healed >= 0) written = healed;
    if (written === null) {
      try {
        written = fs.statSync(PATHS.journal).size;
      } catch {
        written = 0;
      }
    }
    // appendFileSync opens, writes and closes on every call, so a kill loses
    // at most the line being written — never entries already recorded.
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
    let text = buffer.toString('utf8');
    if (size > span) {
      // The window can open mid-line; the partial first line is dropped.
      const firstBreak = text.indexOf('\n');
      text = firstBreak < 0 ? '' : text.slice(firstBreak + 1);
    }
    if (!text.endsWith('\n')) {
      // A kill mid-append leaves a torn final line; it is not an entry yet.
      const lastBreak = text.lastIndexOf('\n');
      text = lastBreak < 0 ? '' : text.slice(0, lastBreak + 1);
    }
    if (!text.trim()) return [];
    return text
      .split('\n')
      .filter((line) => line)
      .slice(-n)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          // One malformed line must not take the whole read down with it.
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
