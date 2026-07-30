// What is actually on this machine.
//
// "Do not assume a tool is installed" is weak guidance — the model has no way to
// comply with it. Telling it what *is* there is guidance it can act on, and it
// turns a whole class of dead plans (pandoc, wkhtmltopdf, jq) into working ones.
//
// Probed once per process and cached: this runs before every plan, and shelling
// out a dozen times per mission to learn the same answer would be silly.

import fs from 'node:fs';
import path from 'node:path';
import { exec, isWindows } from './ps.mjs';

// Things worth knowing about, and what they unlock. Edge earns its place: it is
// on every Windows machine and turns HTML into PDF headlessly, which is the
// answer to "give me this as a PDF" without installing anything.
const PROBES = [
  { name: 'git', why: 'version control' },
  { name: 'node', why: 'run JS, and npm scripts' },
  { name: 'npm', why: 'project scripts' },
  { name: 'python', why: 'scripting' },
  { name: 'pandoc', why: 'document conversion' },
  { name: 'ffmpeg', why: 'media' },
];

const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

// Chrome first when it is there — it is what the owner actually uses, so a
// login they already have is a login Woboo can use. Edge is the fallback
// because it is on every Windows machine, which is why it renders the PDFs.
const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
];

export function chromePath() {
  for (const candidate of CHROME_PATHS) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// The browser Woboo should drive: the owner's, if they have one.
export function browserPath() {
  return chromePath() || edgePath();
}

export function profileRoot() {
  const local = process.env.LOCALAPPDATA || '';
  return chromePath()
    ? path.join(local, 'Google', 'Chrome', 'User Data')
    : path.join(local, 'Microsoft', 'Edge', 'User Data');
}

// Every profile the owner actually has, with the name and account they would
// recognise. "Default" is a directory name, not a choice — someone with three
// profiles has three different inboxes, and picking one for them is how Woboo
// ends up composing mail from the wrong person.
export function listProfiles() {
  const root = profileRoot();
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
    const cache = state.profile?.info_cache || {};
    return Object.entries(cache)
      .map(([dir, info]) => ({
        dir,
        name: info.name || dir,
        email: info.user_name || '',
        lastUsed: state.profile?.last_used === dir,
        // A profile listed in Local State but absent on disk is a leftover.
        present: fs.existsSync(path.join(root, dir)),
      }))
      .filter((p) => p.present)
      .sort((a, b) => Number(b.lastUsed) - Number(a.lastUsed));
  } catch {
    return [];
  }
}

let cache = null;

export function edgePath() {
  for (const candidate of EDGE_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function probe({ refresh = false } = {}) {
  if (cache && !refresh) return cache;

  const found = {};
  for (const tool of PROBES) {
    try {
      const which = isWindows() ? ['where.exe', [tool.name]] : ['/usr/bin/which', [tool.name]];
      const result = await exec(which[0], which[1], { timeout: 6000, action: 'probe tools' });
      found[tool.name] = result.ok && result.out ? result.out.split(/\r?\n/)[0].trim() : null;
    } catch {
      found[tool.name] = null;
    }
  }
  found.edge = edgePath();
  cache = found;
  return cache;
}

// The paragraph the planner reads. Only facts, and only ones that change what a
// sensible plan looks like.
export async function describe() {
  const tools = await probe();
  const lines = [];

  const present = PROBES.filter((t) => tools[t.name]).map((t) => t.name);
  const missing = PROBES.filter((t) => !tools[t.name]).map((t) => t.name);

  if (present.length) lines.push(`Installed and on PATH: ${present.join(', ')}.`);
  if (missing.length) lines.push(`NOT installed — do not plan around these: ${missing.join(', ')}.`);

  if (isWindows()) {
    lines.push(
      'PowerShell can fetch a URL directly: Invoke-WebRequest -Uri <url> -UseBasicParsing -OutFile <path>.',
    );
    if (tools.edge) {
      lines.push(
        'To produce a PDF, use Edge headlessly — it is always present and needs nothing installed:',
        `  & '${tools.edge}' --headless --disable-gpu --no-pdf-header-footer --print-to-pdf='<out.pdf>' '<in.html>'`,
        '  It takes an HTML file or a URL, and writes a real PDF. Give it a second to finish before checking.',
      );
    }
  }

  return lines.join('\n');
}
