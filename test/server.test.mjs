// The dashboard key used to travel as ?key= on every request, which is how a
// credential ends up in browser history. It now goes by header, and by a
// session cookie for the requests that cannot set one (EventSource, <img>) —
// with the URL accepted only on the page itself, once, to bootstrap that.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// HOME is fixed at import time in config.mjs, so point it at a scratch dir
// before any Woboo module is loaded — never at the real one.
process.env.WOBOO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'woboo-server-'));

const { createServer } = await import('../src/server.mjs');
const { ownerKey } = await import('../src/config.mjs');

const key = ownerKey();
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

test('an API route without the key is refused', async () => {
  const res = await fetch(`${base}/api/log`);
  assert.equal(res.status, 401);
});

test('the key in the URL no longer opens an API route', async () => {
  // History and logs keep URLs; headers they do not. Only the page bootstrap
  // still accepts ?key= — everything else must come by header or cookie.
  const res = await fetch(`${base}/api/log?key=${encodeURIComponent(key)}`);
  assert.equal(res.status, 401);
});

test('a Bearer header opens an API route, a wrong one does not', async () => {
  const ok = await fetch(`${base}/api/log`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(Array.isArray(body.log));

  const bad = await fetch(`${base}/api/log`, { headers: { authorization: `Bearer ${key}x` } });
  assert.equal(bad.status, 401);
});

test('the page accepts ?key= once and answers with a session cookie', async () => {
  const res = await fetch(`${base}/?key=${encodeURIComponent(key)}`);
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie') || '';
  assert.ok(cookie.includes(`woboo_key=${key}`), 'no session cookie was set');
  assert.ok(cookie.includes('HttpOnly'), 'the cookie must not be script-readable');

  const bare = await fetch(`${base}/`);
  assert.equal(bare.status, 401, 'the page itself still needs the key');
});

test('the session cookie authenticates what cannot set a header', async () => {
  const res = await fetch(`${base}/api/log`, { headers: { cookie: `woboo_key=${key}` } });
  assert.equal(res.status, 200);

  const wrong = await fetch(`${base}/api/log`, { headers: { cookie: `woboo_key=${key}x` } });
  assert.equal(wrong.status, 401);
});
