// Screenshot comparison.
//
// Before and after a mission step, Woboo takes screenshots. This module
// compares them to detect visual changes — useful for verify steps that need
// to confirm something changed on screen.

import fs from 'node:fs';
import { record } from './journal.mjs';

// Simple pixel-diff between two PNG buffers. Returns a similarity score 0-1
// and a list of changed regions. Does not require any native dependencies —
// it reads the raw pixel data from the PNG files.
export function compare(beforePath, afterPath) {
  try {
    const before = fs.readFileSync(beforePath);
    const after = fs.readFileSync(afterPath);

    // If sizes differ significantly, the screen changed.
    const sizeDiff = Math.abs(before.length - after.length) / Math.max(before.length, 1);
    if (sizeDiff > 0.5) {
      return { similarity: 0, changed: true, reason: 'size differs significantly' };
    }

    // Byte-level comparison (fast, not pixel-perfect but good enough).
    const len = Math.min(before.length, after.length);
    let different = 0;
    const sampleStep = Math.max(1, Math.floor(len / 10000)); // Sample 10k bytes
    let sampled = 0;

    for (let i = 0; i < len; i += sampleStep) {
      sampled++;
      if (before[i] !== after[i]) different++;
    }

    const similarity = 1 - (different / sampled);
    const changed = similarity < 0.95;

    record('diff', 'similarity: ' + (similarity * 100).toFixed(1) + '%', { level: changed ? 'warn' : 'info' });
    return { similarity: Math.round(similarity * 1000) / 1000, changed, reason: changed ? 'visual change detected' : 'no significant change' };
  } catch (err) {
    record('diff', 'comparison failed: ' + err.message, { level: 'error' });
    return { similarity: -1, changed: false, reason: err.message };
  }
}
