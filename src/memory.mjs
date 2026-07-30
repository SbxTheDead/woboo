// What Woboo carries between missions.
//
// Without this, every mission starts from zero: the diagnosis that brain.repair()
// worked out yesterday dies with the process, and tomorrow Woboo makes the same
// mistake at full price. That is the difference between a contractor and a
// colleague — a colleague's value compounds.
//
// Memory is per-workspace, on disk, and deliberately small. It is written at the
// three moments the foreman already reaches:
//
//   * a verify failed and the brain diagnosed why   → a lesson
//   * a mission ended                               → an outcome, and which
//                                                     checks actually proved
//                                                     anything here
//   * the owner corrected Woboo                      → a correction, weighted
//                                                     above anything Woboo
//                                                     concluded on its own
//
// and read back into planning as a short digest. It is capped and pruned on
// purpose: memory that grows without bound stops being context and starts being
// noise, and it rides in every plan prompt.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, ensureHome } from './config.mjs';
import { record } from './journal.mjs';

const DIR = path.join(PATHS.home, 'memory');

const LIMITS = {
  lessons: 12,
  corrections: 12,
  missions: 8,
  checks: 10,
};

function normalise(workspace) {
  return path.resolve(workspace || process.cwd()).replace(/[\\/]+$/, '').toLowerCase();
}

function fileFor(workspace) {
  const key = normalise(workspace);
  const digest = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  // Readable prefix so a human can tell which file is which workspace.
  const label = path.basename(key).replace(/[^a-z0-9._-]/gi, '') || 'workspace';
  return path.join(DIR, `${label}-${digest}.json`);
}

function blank(workspace) {
  return {
    workspace: path.resolve(workspace || process.cwd()),
    updatedAt: Date.now(),
    facts: [],
    lessons: [],
    corrections: [],
    checks: {},
    missions: [],
  };
}

export function load(workspace) {
  ensureHome();
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(workspace), 'utf8'));
    return { ...blank(workspace), ...raw };
  } catch {
    // No memory of this place yet.
    return blank(workspace);
  }
}

function save(workspace, store) {
  ensureHome();
  fs.mkdirSync(DIR, { recursive: true });
  store.updatedAt = Date.now();
  fs.writeFileSync(fileFor(workspace), `${JSON.stringify(store, null, 2)}\n`);
  return store;
}

// Keep the newest N, and treat a repeat as a strengthening of what is already
// known rather than a new entry — a lesson learned three times matters more.
function remember(list, entry, cap, sameAs) {
  const existing = list.find((item) => sameAs(item, entry));
  if (existing) {
    existing.hits = (existing.hits || 1) + 1;
    existing.at = Date.now();
    return list;
  }
  list.unshift({ ...entry, at: Date.now(), hits: 1 });
  return list.slice(0, cap);
}

// ── writing ───────────────────────────────────────────────────────────────────

// A verify failed, the brain worked out why, and the retry was handed back.
export function learnFromRepair(workspace, { step, verify, diagnosis, fix }) {
  const store = load(workspace);
  store.lessons = remember(
    store.lessons,
    { step, verify, diagnosis, fix: (fix || '').slice(0, 400) },
    LIMITS.lessons,
    (a, b) => a.diagnosis === b.diagnosis,
  );
  save(workspace, store);
  record('memory', `learned: ${diagnosis}`.slice(0, 200), { level: 'ok' });
  return store;
}

// A mission ended. Record the shape of it, and score the checks: a command that
// has never once failed here has never once proved anything either.
export function learnFromMission(workspace, mission) {
  const store = load(workspace);

  for (const step of mission.steps || []) {
    if (!step.verify) continue;
    const check = (store.checks[step.verify] ||= { ran: 0, caught: 0, passed: 0 });
    check.ran += 1;
    if (step.status === 'ok') check.passed += 1;
    // "caught" means this check failed at least once and forced a repair — the
    // only evidence that it is actually load-bearing.
    if (step.attempts > 1 || step.status === 'failed') check.caught += 1;
    check.lastAt = Date.now();
  }

  // Drop the least-used checks if we are tracking too many.
  const ranked = Object.entries(store.checks).sort((a, b) => b[1].ran - a[1].ran);
  store.checks = Object.fromEntries(ranked.slice(0, LIMITS.checks));

  store.missions = remember(
    store.missions,
    {
      task: mission.task,
      state: mission.state,
      steps: (mission.steps || []).length,
      proven: (mission.steps || []).filter((s) => s.status === 'ok' && s.verify).length,
    },
    LIMITS.missions,
    (a, b) => a.task === b.task,
  );

  save(workspace, store);
  return store;
}

// The owner said something Woboo should not have to be told twice.
export function learnFromOwner(workspace, text) {
  const store = load(workspace);
  store.corrections = remember(
    store.corrections,
    { text: String(text).slice(0, 300) },
    LIMITS.corrections,
    (a, b) => a.text.toLowerCase() === b.text.toLowerCase(),
  );
  save(workspace, store);
  record('memory', `noted: ${text}`.slice(0, 200), { level: 'ok' });
  return store;
}

// A durable fact about the place — build system, layout, conventions.
export function learnFact(workspace, text) {
  const store = load(workspace);
  store.facts = remember(
    store.facts,
    { text: String(text).slice(0, 300) },
    LIMITS.lessons,
    (a, b) => a.text.toLowerCase() === b.text.toLowerCase(),
  );
  save(workspace, store);
  return store;
}

// ── reading ───────────────────────────────────────────────────────────────────

// The digest that rides in every plan prompt. Short on purpose: this is context,
// not an archive. Returns '' when there is nothing worth saying, so a first
// mission in a new workspace costs nothing.
export function recall(workspace) {
  const store = load(workspace);
  const lines = [];

  if (store.corrections.length) {
    lines.push('The owner has said, and should not have to repeat:');
    for (const c of store.corrections.slice(0, 5)) lines.push(`- ${c.text}`);
  }

  if (store.facts.length) {
    lines.push('About this workspace:');
    for (const f of store.facts.slice(0, 5)) lines.push(`- ${f.text}`);
  }

  // Only surface checks that have actually caught something — a command that
  // always passes is not evidence, and recommending it teaches the wrong lesson.
  const proven = Object.entries(store.checks)
    .filter(([, c]) => c.caught > 0)
    .sort((a, b) => b[1].caught - a[1].caught)
    .slice(0, 4);
  if (proven.length) {
    lines.push('Checks that have genuinely caught problems here:');
    for (const [cmd, c] of proven) lines.push(`- \`${cmd}\` (failed ${c.caught} of ${c.ran} runs)`);
  }

  const noisy = Object.entries(store.checks).filter(([, c]) => c.ran >= 3 && c.caught === 0);
  if (noisy.length) {
    lines.push(
      `Checks that have never once failed here, so they prove little: ${noisy
        .map(([cmd]) => `\`${cmd}\``)
        .join(', ')}`,
    );
  }

  if (store.lessons.length) {
    lines.push('Learned the hard way on earlier missions:');
    for (const l of store.lessons.slice(0, 5)) {
      lines.push(`- ${l.diagnosis}${l.hits > 1 ? ` (hit ${l.hits}x)` : ''}`);
    }
  }

  const failed = store.missions.filter((m) => m.state === 'failed').slice(0, 3);
  if (failed.length) {
    lines.push('Recent tasks here that did not finish:');
    for (const m of failed) lines.push(`- "${m.task}"`);
  }

  return lines.length ? lines.join('\n') : '';
}

export function summary(workspace) {
  const store = load(workspace);
  return {
    workspace: store.workspace,
    updatedAt: store.updatedAt,
    facts: store.facts.length,
    lessons: store.lessons.length,
    corrections: store.corrections.length,
    missions: store.missions.length,
    checks: Object.keys(store.checks).length,
    file: fileFor(workspace),
  };
}

export function forget(workspace) {
  try {
    fs.unlinkSync(fileFor(workspace));
    record('memory', `forgot everything about ${path.resolve(workspace)}`, { level: 'warn' });
    return true;
  } catch {
    return false;
  }
}

export function workspaces() {
  ensureHome();
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const store = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
          return { workspace: store.workspace, updatedAt: store.updatedAt, file: f };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}
