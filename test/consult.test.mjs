// Asking the owner, and not asking twice.
//
// pending() once mapped the wrong field and returned an array of undefined, so
// every button tapped on the phone failed with "cannot read properties of
// undefined" — and the mission stalled waiting for an answer it had made
// impossible to give.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as consult from '../src/consult.mjs';
import { clearStop } from '../src/guard.mjs';

const KEY = 'test.consult';
test.beforeEach(() => {
  clearStop();
  consult.forget(KEY);
});
test.after(() => consult.forget(KEY));

test('a question can be found and answered by id', async () => {
  const asked = consult.ask({
    key: KEY,
    question: 'Which profile?',
    options: [
      { label: 'Rayane', value: 'Default' },
      { label: 'kick01', value: 'Profile 3' },
    ],
    timeout: 10,
  });

  await new Promise((r) => setTimeout(r, 50));
  const open = consult.pending();
  assert.equal(open.length, 1);
  assert.equal(typeof open[0].id, 'string', 'pending() must yield requests, not undefined');
  assert.deepEqual(
    open[0].options.map((o) => o.label),
    ['Rayane', 'kick01'],
  );

  const chosen = consult.choose(open[0].id, 1);
  assert.equal(chosen.value, 'Profile 3');
  assert.equal(await asked, 'Profile 3');
});

test('an answered question is not asked again', async () => {
  const asked = consult.ask({ key: KEY, question: 'Which?', options: ['a', 'b'], timeout: 10 });
  await new Promise((r) => setTimeout(r, 50));
  consult.choose(consult.pending()[0].id, 0);
  assert.equal(await asked, 'a');

  // Same key, different options: it must return the remembered answer without
  // opening a second question.
  const again = await consult.ask({ key: KEY, question: 'Which?', options: ['x'], timeout: 2 });
  assert.equal(again, 'a');
  assert.equal(consult.pending().length, 0);
});

test('a stale id does not throw', () => {
  assert.equal(consult.choose('deadbeef', 0), null);
  assert.equal(consult.answer('deadbeef', 'x'), false);
});

test('an out-of-range option does not resolve the question', async () => {
  const asked = consult.ask({ question: 'Which?', options: ['a'], timeout: 1 });
  await new Promise((r) => setTimeout(r, 50));
  const { id } = consult.pending()[0];
  assert.equal(consult.choose(id, 9), null);
  assert.equal(consult.pending().length, 1, 'the question is still open');
  assert.equal(await asked, null, 'and times out rather than resolving to nonsense');
});

test('an unanswered question times out instead of hanging', async () => {
  const answer = await consult.ask({ question: 'Anyone there?', options: ['a'], timeout: 1 });
  assert.equal(answer, null);
  assert.equal(consult.pending().length, 0);
});
