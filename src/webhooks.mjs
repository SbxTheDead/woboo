// Webhook triggers.
//
// External services (GitHub, CI, monitoring) can POST to Woboo's webhook
// endpoint to trigger missions. Each webhook has a secret token and a task
// template. When fired, the task is submitted to the foreman.

import crypto from 'node:crypto';
import { loadSettings, saveSettings } from './config.mjs';
import { record } from './journal.mjs';
import { publish } from './bus.mjs';

export function list() {
  return loadSettings().webhooks || [];
}

export function add({ name, task, secret }) {
  const settings = loadSettings();
  const webhooks = settings.webhooks || [];
  const token = secret || crypto.randomBytes(16).toString('hex');
  const hook = {
    id: crypto.randomBytes(6).toString('hex'),
    name,
    task,
    token,
    lastFired: null,
    createdAt: new Date().toISOString(),
  };
  webhooks.push(hook);
  saveSettings({ webhooks });
  record('webhook', 'added: ' + name, { level: 'ok' });
  return hook;
}

export function remove(id) {
  const settings = loadSettings();
  const webhooks = (settings.webhooks || []).filter((w) => w.id !== id);
  saveSettings({ webhooks });
  return webhooks;
}

export function verify(id, providedToken) {
  const hook = list().find((w) => w.id === id);
  if (!hook) return null;
  // Timing-safe comparison.
  const expected = Buffer.from(hook.token);
  const provided = Buffer.from(String(providedToken || ''));
  if (expected.length !== provided.length) return null;
  if (crypto.timingSafeEqual(expected, provided)) return hook;
  return null;
}

export function markFired(id) {
  const settings = loadSettings();
  const webhooks = settings.webhooks || [];
  const hook = webhooks.find((w) => w.id === id);
  if (hook) {
    hook.lastFired = new Date().toISOString();
    saveSettings({ webhooks });
  }
}
