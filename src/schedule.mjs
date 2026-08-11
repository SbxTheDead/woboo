// Scheduling missions to run at a specific time or on a recurring basis.
// The scheduler is a simple timer loop: it checks the schedule every minute
// and fires any mission whose time has come. It is not a cron daemon — it
// lives inside the Woboo process and dies with it.
//
// For persistent scheduling across reboots, the owner can use the OS task
// scheduler with the run command.

import { loadSettings, saveSettings } from './config.mjs';
import { record } from './journal.mjs';

let timer = null;
let runner = null;

export function list() {
  return loadSettings().schedule || [];
}

export function add({ name, task, at, every }) {
  const settings = loadSettings();
  const schedule = settings.schedule || [];
  const entry = {
    id: Date.now().toString(36),
    name,
    task,
    at: at || null,
    every: every || null,
    lastRun: null,
    createdAt: new Date().toISOString(),
  };
  schedule.push(entry);
  saveSettings({ schedule });
  record('schedule', 'added: ' + name, { level: 'ok' });
  return entry;
}

export function remove(id) {
  const settings = loadSettings();
  const schedule = (settings.schedule || []).filter((s) => s.id !== id);
  saveSettings({ schedule });
  return schedule;
}

export function start(runMission) {
  runner = runMission;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  tick(); // check immediately
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  runner = null;
}

function tick() {
  const schedule = list();
  const now = Date.now();
  for (const entry of schedule) {
    if (shouldRun(entry, now)) {
      record('schedule', 'firing: ' + entry.name, { level: 'info' });
      markRun(entry.id);
      if (runner) {
        runner(entry.task).catch((err) => {
          record('schedule', 'failed: ' + entry.name + ' — ' + err.message, { level: 'error' });
        });
      }
    }
  }
}

function shouldRun(entry, now) {
  if (entry.at) {
    const target = new Date(entry.at).getTime();
    if (!entry.lastRun && now >= target) return true;
  }
  if (entry.every) {
    const ms = parseInterval(entry.every);
    if (!ms) return false;
    const last = entry.lastRun ? new Date(entry.lastRun).getTime() : 0;
    if (now - last >= ms) return true;
  }
  return false;
}

function markRun(id) {
  const settings = loadSettings();
  const schedule = settings.schedule || [];
  const entry = schedule.find((s) => s.id === id);
  if (entry) {
    entry.lastRun = new Date().toISOString();
    saveSettings({ schedule });
  }
}

function parseInterval(str) {
  const match = String(str).match(/^(\d+)\s*(m|min|h|hr|hour|d|day)s?$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('m')) return n * 60_000;
  if (unit.startsWith('h')) return n * 3_600_000;
  if (unit.startsWith('d')) return n * 86_400_000;
  return 0;
}
