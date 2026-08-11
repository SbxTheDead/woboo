// Plugin hooks. Woboo calls hooks at key moments — before a mission starts,
// after each step, when a mission completes. Plugins can observe, log, or
// modify behaviour by registering handlers.
//
// A plugin is just a module that exports an object with hook functions. It is
// loaded from ~/.woboo/plugins/ on startup. No sandbox, no permission model —
// the owner installs plugins they trust, same as any other Node code.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { record } from './journal.mjs';

const hooks = {
  beforeMission: [],
  afterStep: [],
  afterMission: [],
  onError: [],
};

export function register(hookName, handler) {
  if (!hooks[hookName]) {
    record('plugins', 'unknown hook: ' + hookName, { level: 'warn' });
    return;
  }
  hooks[hookName].push(handler);
  record('plugins', 'registered: ' + hookName, { level: 'info' });
}

export async function emit(hookName, ...args) {
  const handlers = hooks[hookName] || [];
  for (const handler of handlers) {
    try {
      await handler(...args);
    } catch (err) {
      record('plugins', hookName + ' handler failed: ' + err.message, { level: 'error' });
    }
  }
}

export function loadPlugins() {
  const dir = path.join(PATHS.home, 'plugins');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))) {
    try {
      const mod = require(path.join(dir, file));
      if (mod && typeof mod.register === 'function') {
        mod.register({ register, emit });
        record('plugins', 'loaded: ' + file, { level: 'ok' });
      }
    } catch (err) {
      record('plugins', 'failed to load ' + file + ': ' + err.message, { level: 'error' });
    }
  }
}

export function listHooks() {
  return Object.fromEntries(Object.entries(hooks).map(([k, v]) => [k, v.length]));
}
