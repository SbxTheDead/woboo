// The capability ladder, which is the whole reason Woboo is not slow.
//
// Measured on this machine: a DOM action costs 16ms, a vision step 153,000ms.
// Routing a task to the wrong rung is not a style question — it is the
// difference between four seconds and four minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { route, identify, describe } from '../src/capabilities.mjs';

const CASES = [
  ['search the web for the europa clipper mission', 'dom'],
  ['open gmail and read the latest message', 'dom'],
  ['check the colours and buttons on example.com', 'dom'],
  ['find the cheapest flight to lisbon', 'dom'],
  // Nothing on the web can do these; the screen is the only interface.
  ['open notepad and type a shopping list', 'vision'],
  ['open task manager and end the stuck process', 'vision'],
  ['click the settings icon in VS Code', 'vision'],
];

test('routes each goal to the cheapest rung that can do it', () => {
  const wrong = [];
  for (const [goal, want] of CASES) {
    const got = route(goal).rung;
    if (got !== want) wrong.push(`${goal}\n    wanted ${want}, got ${got}`);
  }
  assert.equal(wrong.length, 0, `\n  ${wrong.join('\n  ')}`);
});

test('every rung it returns is one the foreman knows how to run', () => {
  const known = new Set(['api', 'dom', 'vision']);
  for (const [goal] of CASES) {
    assert.ok(known.has(route(goal).rung), `${goal} routed to an unknown rung`);
  }
});

test('the planner is told what is actually available', () => {
  const text = describe();
  assert.ok(text.length > 50, 'an empty toolbox description means the planner is guessing');
});

test('identify does not invent an app for a goal that names none', () => {
  assert.equal(identify('think about something'), null);
});
