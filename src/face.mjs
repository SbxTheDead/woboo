// Woboo's expression is not decoration — it is the state machine, rendered.
// Every face below corresponds to something the foreman is actually doing, so
// glancing at the screen tells you where the mission is without reading a log.

import { publish } from './bus.mjs';

export const FACES = [
  'asleep',    // no mission, idle a long while
  'idle',      // ready, blinking
  'listening', // took a task, hasn't planned yet
  'thinking',  // asking the brain for a plan
  'working',   // executing a step
  'testing',   // running a verify command — the skeptical squint
  'happy',     // mission verified
  'confused',  // verify failed, handing it back to the crew
  'error',     // mission failed or refused
  'stopped',   // STOP engaged
];

let current = { state: 'idle', note: '', since: Date.now() };

export function face() {
  return current;
}

export function setFace(state, note = '') {
  if (!FACES.includes(state)) state = 'idle';
  // Re-publish even when the state repeats: the note usually changed.
  current = { state, note, since: Date.now() };
  publish({ type: 'face', state, note });
  return current;
}
