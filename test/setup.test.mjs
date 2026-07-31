// First-run setup reports what is missing. Getting that wrong means either
// nagging an owner who is already configured, or launching a widget that
// cannot think and blinks at them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { state, isConfigured, looksRight } from '../src/setup.mjs';

test('reports a state for every step, with a reason', () => {
  const s = state();
  for (const step of ['brain', 'search', 'telegram', 'browser']) {
    assert.ok(step in s, `${step} is not reported at all`);
    assert.equal(typeof s[step].done, 'boolean');
  }
});

test('configured means a brain, not merely a config file', () => {
  assert.equal(isConfigured(), state().brain.done);
});

test('catches a key pasted wrong before it becomes a 401 an hour later', () => {
  assert.equal(looksRight('nvidiaApiKey', 'nvapi-abcdefghij1234567890abcd'), true);
  assert.equal(looksRight('nvidiaApiKey', 'sk-this-is-an-openai-key'), false);
  assert.equal(looksRight('nvidiaApiKey', 'nvapi-'), false);
  assert.equal(looksRight('tavilyApiKey', 'tvly-dev-abcdefghijkl'), true);
  assert.equal(looksRight('tavilyApiKey', 'nvapi-wrong-one'), false);
  assert.equal(looksRight('telegramToken', '8834776041:AAG1KlvytOaesZaY3f62yMjF1JEjprp0nU'), true);
  assert.equal(looksRight('telegramToken', 'just-a-string'), false);
});

test('an unknown secret is not rejected for failing a shape nobody defined', () => {
  assert.equal(looksRight('somethingNew', 'anything at all'), true);
});
