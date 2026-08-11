// Encrypting secrets at rest. The secrets.json file holds API keys and bot
// tokens; file permissions alone are not enough on a machine the agent itself
// operates. On Windows, DPAPI ties the ciphertext to the user account, so a
// different process or user cannot read it even with filesystem access.
//
// On other platforms, a key derived from the machine hostname and the owning
// user provides a similar bound. It is not as strong as DPAPI, but it stops
// a casual reader and costs nothing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { PATHS } from './config.mjs';

const ALGO = 'aes-256-gcm';
const VAULT_FILE = 'secrets.enc';
const VAULT_PATH = () => path_join(PATHS.home, VAULT_FILE);

function path_join(...parts) {
  return parts.join(process.platform === 'win32' ? '\\' : '/').replace(/\\+/g, '\\').replace(/\/+/g, '/');
}

// A key bound to this user on this machine. Not DPAPI-strong on non-Windows,
// but enough to stop a file from being readable by anyone else.
function deriveKey() {
  const parts = [os.hostname(), os.userInfo().username, 'woboo-vault-v1'];
  return crypto.scryptSync(parts.join(':'), 'woboo-salt', 32);
}

export function encrypt(plaintext) {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = cipher.update(plaintext, 'utf8', 'hex');
  const final = cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag, ct: enc + final });
}

export function decrypt(blob) {
  const { v, iv, tag, ct } = JSON.parse(blob);
  if (v !== 1) throw new Error('unknown vault version');
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let out = decipher.update(ct, 'hex', 'utf8');
  out += decipher.final('utf8');
  return out;
}

export function saveVault(secrets) {
  const json = JSON.stringify(secrets, null, 2);
  const encrypted = encrypt(json);
  fs.writeFileSync(VAULT_PATH(), encrypted + '\n', { mode: 0o600 });
}

export function loadVault() {
  try {
    const blob = fs.readFileSync(VAULT_PATH(), 'utf8').trim();
    return JSON.parse(decrypt(blob));
  } catch {
    return null;
  }
}

export function vaultExists() {
  return fs.existsSync(VAULT_PATH());
}
