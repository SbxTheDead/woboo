// The dashboard's other half: a small HTTP surface over the same modules the
// CLI drives. Two rules shape everything here.
//
//   1. It binds to 127.0.0.1 only. Woboo can type into your machine; that is not
//      a capability to expose on a network interface.
//   2. Every route carries the owner key, including the page itself. Localhost
//      is not a trust boundary — any process on this box can reach this port, so
//      the key is what separates "you" from "something running as you".
//
// Events go out over SSE because the bus is already a publisher; the browser is
// just one more subscriber.

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { PATHS, loadSettings, saveSettings, ownerKey } from './config.mjs';
import { subscribe } from './bus.mjs';
import { record, tail } from './journal.mjs';
import { face } from './face.mjs';
import { page } from './ui.mjs';
import * as guard from './guard.mjs';
import * as foreman from './foreman.mjs';
import * as crew from './crew.mjs';
import * as brain from './brain.mjs';
import * as eyes from './eyes.mjs';
import * as hands from './hands.mjs';

const HOST = '127.0.0.1';
const BODY_LIMIT = 256_000;

// ── auth ──────────────────────────────────────────────────────────────────────

function presented(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return url.searchParams.get('key') || req.headers['x-wobo-key'] || '';
}

function authorized(req, url) {
  const given = Buffer.from(String(presented(req, url)));
  const expected = Buffer.from(ownerKey());
  // timingSafeEqual throws on length mismatch, so check that first — the length
  // of the key is not a secret.
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

// ── plumbing ──────────────────────────────────────────────────────────────────

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body was not valid JSON');
  }
}

// Everything the dashboard needs to draw itself from cold.
async function snapshot() {
  return {
    face: face(),
    mission: foreman.currentMission(),
    busy: foreman.isBusy(),
    guard: { stopped: guard.isStopped(), reason: guard.stopReason() },
    approvals: guard.pendingApprovals(),
    settings: loadSettings(),
    brain: { ...brain.status(), installed: brain.installed() },
    crew: await crew.discover(),
    hands: hands.handsMode(),
    shot: eyes.latestShot(),
    log: tail(150),
    home: PATHS.home,
    platform: process.platform,
  };
}

// ── routes ────────────────────────────────────────────────────────────────────

async function route(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return send(res, 200, page({ key: ownerKey() }), { 'content-type': 'text/html; charset=utf-8' });
  }

  if (method === 'GET' && pathname === '/api/state') {
    return send(res, 200, await snapshot());
  }

  if (method === 'GET' && pathname === '/api/log') {
    const n = Math.min(1000, Math.max(1, Number(url.searchParams.get('n')) || 150));
    return send(res, 200, { log: tail(n) });
  }

  // The live feed. Full state first so a browser opened mid-mission is correct
  // immediately, then every bus event as it happens.
  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const write = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Socket died between the check and the write; the close handler cleans up.
      }
    };

    write({ type: 'state', state: await snapshot() });
    const unsubscribe = subscribe(write);

    // Proxies and sleeping laptops drop idle sockets; a comment line is enough
    // to keep this one honest.
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // Same as above.
      }
    }, 15_000);
    if (typeof beat.unref === 'function') beat.unref();

    const cleanup = () => {
      clearInterval(beat);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    return undefined;
  }

  // The most recent screenshot, straight off disk.
  if (method === 'GET' && pathname === '/api/shot') {
    const shot = eyes.latestShot();
    if (!shot || !fs.existsSync(shot.path)) return send(res, 404, { error: 'no screenshot yet' });
    const png = fs.readFileSync(shot.path);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return res.end(png);
  }

  if (method === 'POST' && pathname === '/api/mission') {
    const { task, workspace } = await readBody(req);
    if (!task || !String(task).trim()) return send(res, 400, { error: 'a task is required' });
    if (foreman.isBusy()) return send(res, 409, { error: 'Woboo is already on a mission' });
    if (guard.isStopped()) {
      return send(res, 409, { error: `STOP is engaged: ${guard.stopReason() || 'release it first'}` });
    }
    // Fire and forget: progress arrives over SSE, and a mission failure is a
    // mission outcome, not an HTTP error.
    foreman.runMission(String(task).trim(), { workspace }).catch((err) => {
      record('mission', `mission ended early: ${err.message}`, { level: 'error' });
    });
    return send(res, 202, { started: true });
  }

  if (method === 'POST' && pathname === '/api/selftest') {
    if (foreman.isBusy()) return send(res, 409, { error: 'Woboo is busy' });
    foreman.selfTest().catch((err) => {
      record('mission', `self-test ended early: ${err.message}`, { level: 'error' });
    });
    return send(res, 202, { started: true });
  }

  if (method === 'POST' && pathname === '/api/stop') {
    const { reason } = await readBody(req);
    return send(res, 200, { stopped: true, reason: guard.engageStop(reason || 'owner pressed STOP') });
  }

  if (method === 'POST' && pathname === '/api/resume') {
    guard.clearStop();
    return send(res, 200, { stopped: false });
  }

  if (method === 'POST' && pathname === '/api/approval') {
    const { id, decision } = await readBody(req);
    const handled = guard.resolveApproval(id, decision === 'allow' ? 'allow' : 'deny');
    return send(res, handled ? 200 : 404, { handled });
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const patch = await readBody(req);
    // Only let the dashboard touch knobs that are meant to be turned.
    const allowed = ['model', 'effort', 'crew', 'workspace', 'hands', 'maxRepairs', 'approvalTimeout'];
    const clean = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    }
    if (!Object.keys(clean).length) return send(res, 400, { error: 'nothing settable in that patch' });
    const next = saveSettings(clean);
    record('settings', `updated: ${Object.keys(clean).join(', ')}`, { level: 'ok' });
    if (clean.crew) crew.invalidate();
    return send(res, 200, { settings: next });
  }

  if (method === 'POST' && pathname === '/api/look') {
    const { reason } = await readBody(req);
    return send(res, 200, await eyes.screenshot({ reason: reason || 'owner asked' }));
  }

  if (method === 'POST' && pathname === '/api/crew/refresh') {
    return send(res, 200, { crew: await crew.discover({ refresh: true }) });
  }

  // Hands are reachable from the dashboard, but every act still goes through
  // the same approval gate as everything else.
  if (method === 'POST' && pathname === '/api/hands') {
    const { act, text, combo, x, y, button, title } = await readBody(req);
    try {
      switch (act) {
        case 'type':
          return send(res, 200, await hands.typeText(String(text ?? '')));
        case 'key':
          return send(res, 200, await hands.pressKey(String(combo ?? '')));
        case 'click':
          return send(res, 200, await hands.click(Number(x) | 0, Number(y) | 0, { button }));
        case 'move':
          return send(res, 200, await hands.moveTo(Number(x) | 0, Number(y) | 0));
        case 'focus':
          return send(res, 200, await hands.focusWindow(String(title ?? '')));
        default:
          return send(res, 400, { error: `unknown hand act "${act}"` });
      }
    } catch (err) {
      const blocked = err instanceof guard.Refused || err instanceof guard.Halted;
      return send(res, blocked ? 403 : 500, { error: err.message });
    }
  }

  return send(res, 404, { error: `no route for ${method} ${pathname}` });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', `http://${HOST}`);
    } catch {
      return send(res, 400, { error: 'unparseable URL' });
    }

    if (!authorized(req, url)) {
      return send(res, 401, { error: 'owner key required — start Woboo with `wobo up` and use the printed URL' });
    }

    try {
      await route(req, res, url);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.end();
    }
    return undefined;
  });
}

// `strict` is for `wobo up`, where the owner named a port and silently using a
// different one would be confusing. The app leaves it off: a stale server from
// an earlier session should not stop Woboo from opening its own window.
export function listen({ port, strict = false, tries = 12 } = {}) {
  const first = port || loadSettings().port;

  const attempt = (candidate, remaining) =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', (err) => {
        if (err.code !== 'EADDRINUSE') return reject(err);
        if (strict || remaining <= 0) {
          return reject(
            new Error(`port ${candidate} is already in use — try \`wobo up --port ${candidate + 1}\``),
          );
        }
        resolve(attempt(candidate + 1, remaining - 1));
      });
      server.listen(candidate, HOST, () => {
        const url = `http://${HOST}:${candidate}/?key=${ownerKey()}`;
        record(
          'server',
          `dashboard listening on ${HOST}:${candidate}${candidate !== first ? ` (${first} was taken)` : ''}`,
          { level: 'ok' },
        );
        resolve({ server, port: candidate, url, host: HOST });
      });
    });

  return attempt(first, tries);
}
