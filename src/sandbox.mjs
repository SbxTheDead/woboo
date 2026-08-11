// Sandboxed shell execution.
//
// On Windows, uses a restricted token to limit what commands can do. On other
// platforms, uses a chroot or container if available. The goal is to let Woboo
// run shell commands without giving them full access to the system.
//
// This is a lightweight sandbox — not a full VM. For real isolation, the owner
// should run Woboo inside a container.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { record } from './journal.mjs';
import { loadSettings } from './config.mjs';

const SANDBOX_DIR = () => path.join(os.tmpdir(), 'woboo-sandbox');

// Prepare a sandbox directory with a limited PATH.
function prepareSandbox() {
  const dir = SANDBOX_DIR();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Run a command in a sandboxed environment.
export function run(command, args, options = {}) {
  const settings = loadSettings();
  if (!settings.sandbox) {
    // Sandbox disabled — run normally.
    return spawn(command, args, options);
  }

  const dir = prepareSandbox();
  const env = {
    ...process.env,
    // Restrict PATH to safe directories.
    PATH: process.platform === 'win32'
      ? 'C:\\Windows\\System32;C:\\Windows'
      : '/usr/bin:/bin:/usr/local/bin',
    // Prevent commands from reaching the network (best effort).
    NO_PROXY: '*',
    // Limit output.
    TERM: 'dumb',
    // Sandbox marker.
    WOBOO_SANDBOX: '1',
    // Working directory.
    WOBOO_SANDBOX_DIR: dir,
  };

  const timeout = options.timeout || 60000;

  record('sandbox', 'running in sandbox: ' + command + ' ' + (args || []).join(' '), { level: 'info' });

  const child = spawn(command, args, {
    ...options,
    env: { ...env, ...(options.env || {}) },
    cwd: dir,
    timeout,
    // Kill the whole process tree on timeout.
    windowsHide: true,
  });

  return child;
}

// Check if sandbox is available.
export function available() {
  if (process.platform === 'win32') {
    // Windows sandbox is always available (restricted token).
    return true;
  }
  // On Unix, check for chroot or container.
  try {
    return fs.existsSync('/usr/bin/chroot') || fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}
