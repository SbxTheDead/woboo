// Asking the owner, and not asking twice.
//
// Woboo keeps meeting decisions that are genuinely not its to make: which of
// three Chrome profiles is "your" Gmail, which of two files you meant, whether
// to send the thing it just wrote. Guessing produces confident wrong work — mail
// sent from the wrong account is not a small error — and hard-coding a default
// is guessing with extra steps.
//
// So it asks, through whatever channel the owner is actually at: the widget on
// the desktop, the console, or Telegram on their phone. Any of them can answer;
// the first answer wins.
//
// And it remembers. A product that asks which profile every single time is a
// worse product than one that guesses. Answers marked durable are kept, so the
// question is asked once and the preference outlives the process.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, ensureHome } from './config.mjs';
import { publish } from './bus.mjs';
import { record } from './journal.mjs';
import { assertLive, onStop } from './guard.mjs';

const FILE = path.join(PATHS.home, 'preferences.json');

// ── remembered answers ────────────────────────────────────────────────────────

export function preferences() {
  ensureHome();
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function remember(key, value) {
  const all = preferences();
  all[key] = { value, at: Date.now() };
  ensureHome();
  fs.writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
  record('consult', `remembered ${key} = ${String(value).slice(0, 60)}`, { level: 'ok' });
  return value;
}

export function recall(key) {
  return preferences()[key]?.value;
}

export function forget(key) {
  const all = preferences();
  if (!(key in all)) return false;
  delete all[key];
  fs.writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
  record('consult', `forgot ${key}`, { level: 'warn' });
  return true;
}

// ── open questions ────────────────────────────────────────────────────────────

const open = new Map();

// The open questions themselves, so a channel can find one by id and answer it.
// (This mapped the wrong field once and returned an array of undefined, which
// made every Telegram tap fail with "cannot read properties of undefined".)
export function pending() {
  return [...open.values()].map(({ request }) => request);
}

// Answer by id without needing to look the request up first — the channel knows
// which option was tapped, and finding it is this module's job, not theirs.
export function choose(id, index) {
  const waiting = open.get(id);
  if (!waiting) return null;
  const option = waiting.request.options[Number(index)];
  if (!option) return null;
  waiting.settle(option.value, 'answered');
  return option;
}

// Ask the owner. Resolves with the chosen value, or null if nobody answered.
//
// `key` makes the answer durable: ask once, reuse forever, until the owner
// changes it. Leave it out for one-off questions where remembering would be
// wrong ("send this now?" should be asked every time).
export async function ask({
  question,
  options,
  key = null,
  detail = '',
  timeout = 300,
  reask = false,
} = {}) {
  assertLive('ask the owner');

  if (key && !reask) {
    const known = recall(key);
    if (known !== undefined) return known;
  }

  const id = crypto.randomBytes(6).toString('hex');
  const request = {
    id,
    question,
    detail,
    options: options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)),
    asked: Date.now(),
    timeout,
    key,
  };

  record('consult', `asking owner: ${question}`, { level: 'warn' });

  return new Promise((resolve) => {
    let done = false;
    const settle = (value, how) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      open.delete(id);
      if (value !== null && key) remember(key, value);
      record('consult', value === null ? `no answer (${how})` : `owner chose: ${String(value).slice(0, 60)}`, {
        level: value === null ? 'error' : 'ok',
      });
      publish({ type: 'consult:resolved', id, value });
      resolve(value);
    };

    // Long, because the owner may be away from the machine — the whole point of
    // asking on Telegram is that they might answer from a bus.
    const timer = setTimeout(() => settle(null, 'timed out'), timeout * 1000);
    if (typeof timer.unref === 'function') timer.unref();

    open.set(id, { request, settle });
    publish({ type: 'consult', request });
  });
}

export function answer(id, value) {
  const waiting = open.get(id);
  if (!waiting) return false;
  waiting.settle(value, 'answered');
  return true;
}

// A halt should not leave a question hanging.
onStop(() => {
  for (const [, waiting] of open) waiting.settle(null, 'STOP engaged');
});
