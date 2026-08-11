#!/usr/bin/env node
// The 100-task harness.
//
// It drives a running Woboo through TEST_SUITE.md one task at a time, answers
// the approval prompts an unattended run would otherwise time out on, and
// writes down what actually happened — the state Woboo reached, the files it
// produced, the journal lines it wrote, and the reason it gave when it failed.
//
// The earlier harness stopped the whole run at the first failure and asked for
// a human. That is the wrong shape for a hundred tasks: one bad task should
// cost one task. This one records the failure, keeps its evidence, and carries
// on, so a full sweep produces a full picture and the failures can be grouped
// and fixed by pattern afterwards.
//
//   node test-harness.mjs                 run everything, from the beginning
//   node test-harness.mjs --resume        carry on from where it stopped
//   node test-harness.mjs --only 2,7,41   just those
//   node test-harness.mjs --from 41 --to 55
//   node test-harness.mjs --retry 2       attempts per task before it is failed
//   node test-harness.mjs --stop-on-fail  the old behaviour, when debugging one

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(os.homedir(), '.woboo');
const SUITE = path.join(HERE, 'TEST_SUITE.md');
const RESULTS = path.join(HERE, 'benchmark', 'results.json');
const EVIDENCE = path.join(HERE, 'benchmark', 'evidence');
const LOG = path.join(HERE, 'benchmark', 'harness.log');

// Long enough for a research task that reads six sources and renders a PDF;
// short enough that a wedged mission does not eat the night.
const DEFAULT_TIMEOUT = 10 * 60_000;
const SLOW = { research: 20 * 60_000, download: 15 * 60_000, browser: 12 * 60_000 };
const POLL = 700;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const RETRIES = Number(value('retry', '2'));
const STOP_ON_FAIL = flag('stop-on-fail');

// ── plumbing ──────────────────────────────────────────────────────────────────

fs.mkdirSync(EVIDENCE, { recursive: true });

const stamp = () => new Date().toISOString().slice(11, 19);
function say(line = '') {
  const text = line ? `[${stamp()}] ${line}` : '';
  console.log(text);
  try {
    fs.appendFileSync(LOG, `${text}\n`);
  } catch {
    // A harness that cannot write its own log still has a run to finish.
  }
}

// The owner key and the port are on disk, so the harness needs no arguments to
// find the server it is meant to drive.
function ownerKey() {
  return fs.readFileSync(path.join(HOME, 'owner.key'), 'utf8').trim();
}

function settings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

let BASE = `http://127.0.0.1:${value('port', String(settings().port || 4477))}`;

async function api(route, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-woboo-key': ownerKey() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

// The server picks the next free port when its own is taken, so a harness that
// only ever tries one port will sit there talking to nothing.
async function findServer() {
  const first = Number(value('port', String(settings().port || 4477)));
  for (const port of [first, first + 1, first + 2, first + 3]) {
    BASE = `http://127.0.0.1:${port}`;
    try {
      const { status } = await api('/api/state');
      if (status === 200) return port;
    } catch {
      // Nothing listening there yet.
    }
  }
  throw new Error(`no Woboo server answered on ports ${first}–${first + 3}. Start one: node woboo.mjs up`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the suite ─────────────────────────────────────────────────────────────────

export function parseSuite(markdown) {
  const tasks = [];
  let category = 'Uncategorised';
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+([A-Z])\.\s+(.+?)\s*\(\d+-\d+\)\s*$/);
    if (heading) {
      category = `${heading[1]}. ${heading[2]}`;
      continue;
    }
    const item = line.match(/^(\d{1,3})\.\s+(.+?)\s*$/);
    if (item) tasks.push({ num: Number(item[1]), text: item[2], category });
  }
  return tasks;
}

// What a task is likely to spend its time on, which is all the timeout needs.
function budgetFor(task) {
  const text = task.text.toLowerCase();
  if (/^E\./.test(task.category) || /\bresearch|write a (guide|report|summary)\b/.test(text)) return SLOW.research;
  if (/\bdownload\b/.test(text)) return SLOW.download;
  if (/^C\./.test(task.category) || /\b(go to|open|navigate|search for)\b/.test(text)) return SLOW.browser;
  return DEFAULT_TIMEOUT;
}

// ── evidence ──────────────────────────────────────────────────────────────────

function journalSince(since) {
  try {
    return fs
      .readFileSync(path.join(HOME, 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && Date.parse(entry.t) >= since);
  } catch {
    return [];
  }
}

function keepEvidence(task, attempt, mission, journal) {
  const file = path.join(EVIDENCE, `task-${String(task.num).padStart(3, '0')}-attempt-${attempt}.json`);
  fs.writeFileSync(file, JSON.stringify({ task, mission, journal }, null, 2), 'utf8');
  return path.relative(HERE, file);
}

// ── results ───────────────────────────────────────────────────────────────────

function loadResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  } catch {
    return { startedAt: Date.now(), endedAt: null, tasks: [], summary: {} };
  }
}

function saveResults(results) {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2), 'utf8');
}

// ── one task ──────────────────────────────────────────────────────────────────

// Approvals auto-deny after `approvalTimeout` seconds, and an unattended run
// has nobody to press the button — so the harness is the owner for the duration.
// The guard's outright refusals are untouched: this answers the "ask" tier only,
// which is exactly what a human sitting here would be doing.
async function answerApprovals(seen) {
  const { body } = await api('/api/state');
  for (const request of body.approvals || []) {
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    await api('/api/approval', { method: 'POST', body: { id: request.id, decision: 'allow' } });
    say(`   🔓 approved: ${request.kind} — ${String(request.detail || '').slice(0, 120)}`);
  }
  return body;
}

async function runTask(task, attempt) {
  const since = Date.now();
  const budget = budgetFor(task);

  say('');
  say('='.repeat(62));
  say(`📋 Task #${task.num} (attempt ${attempt}): ${task.text}`);
  say(`   category: ${task.category} · budget: ${Math.round(budget / 60000)}m`);
  say('='.repeat(62));

  // A mission left running from an earlier task would swallow this one's POST.
  const before = await api('/api/state');
  if (before.body.guard?.stopped) {
    await api('/api/resume', { method: 'POST' });
    say('   ▶ released a STOP left over from an earlier task');
  }
  if (before.body.busy) {
    await api('/api/stop', { method: 'POST', body: { reason: 'harness: previous mission overran' } });
    await wait(1500);
    await api('/api/resume', { method: 'POST' });
    say('   ⏹ stopped a mission that was still running');
  }

  const started = await api('/api/mission', { method: 'POST', body: { task: task.text } });
  if (started.status !== 202) {
    return {
      passed: false,
      state: 'not-started',
      error: `POST /api/mission answered ${started.status}: ${JSON.stringify(started.body)}`,
      ms: 0,
      evidence: null,
    };
  }

  const seen = new Set();
  let last = '';
  let mission = null;

  while (Date.now() - since < budget) {
    await wait(POLL);
    let state;
    try {
      state = await answerApprovals(seen);
    } catch (err) {
      // The server died mid-mission — worth recording rather than crashing.
      say(`   ⚠ could not read state: ${err.message}`);
      continue;
    }
    mission = state.mission;
    if (!mission) continue;
    if (mission.state !== last) {
      last = mission.state;
      say(`   📊 ${mission.state}${mission.steps?.length ? ` (${mission.steps.length} step(s))` : ''}`);
    }
    if (['done', 'failed', 'stopped'].includes(mission.state) && !state.busy) break;
  }

  const ms = Date.now() - since;
  const journal = journalSince(since);
  const evidence = keepEvidence(task, attempt, mission, journal);

  if (!mission || !['done', 'failed', 'stopped'].includes(mission.state)) {
    await api('/api/stop', { method: 'POST', body: { reason: 'harness: task exceeded its budget' } });
    await wait(1000);
    await api('/api/resume', { method: 'POST' });
    return { passed: false, state: mission?.state || 'unknown', error: `timed out after ${Math.round(ms / 1000)}s`, ms, evidence };
  }

  return {
    passed: mission.state === 'done',
    state: mission.state,
    error: mission.state === 'done' ? null : mission.report || `mission ${mission.state}`,
    report: mission.report || '',
    missionId: mission.id,
    steps: (mission.steps || []).map((s) => ({ title: s.title, kind: s.kind, status: s.status, verify: !!s.verify })),
    verdicts: mission.verdicts || [],
    ms,
    evidence,
  };
}

// ── the run ───────────────────────────────────────────────────────────────────

async function main() {
  const suite = parseSuite(fs.readFileSync(SUITE, 'utf8'));
  say('🧪 Woboo 100-Task Harness');
  say('═'.repeat(31));
  say(`📋 parsed ${suite.length} tasks from TEST_SUITE.md`);

  const port = await findServer();
  say(`🔌 talking to Woboo on port ${port}`);

  // An approval that auto-denies in three seconds cannot survive a poll loop,
  // and a denied approval fails a task for a reason that has nothing to do with
  // the task. Give the harness room to answer.
  const current = settings().approvalTimeout;
  if (!current || current < 30) {
    await api('/api/settings', { method: 'POST', body: { approvalTimeout: 60 } });
    say(`⚙ approvalTimeout ${current}s → 60s, so approvals can be answered rather than timing out`);
  }

  const results = flag('resume') ? loadResults() : { startedAt: Date.now(), endedAt: null, tasks: [], summary: {} };
  if (!results.startedAt) results.startedAt = Date.now();

  const done = new Set(results.tasks.filter((t) => t.passed).map((t) => t.num));
  const only = value('only') ? new Set(value('only').split(',').map(Number)) : null;
  const from = Number(value('from', '1'));
  const to = Number(value('to', '100'));

  let chosen = suite.filter((t) => t.num >= from && t.num <= to);
  if (only) chosen = chosen.filter((t) => only.has(t.num));
  if (flag('resume') && !only) chosen = chosen.filter((t) => !done.has(t.num));

  say(`▶ running ${chosen.length} task(s)`);

  for (const task of chosen) {
    let outcome = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      attempts = attempt;
      outcome = await runTask(task, attempt);
      if (outcome.passed) {
        say(`✅ Task #${task.num} PASSED in ${Math.round(outcome.ms / 1000)}s (attempt ${attempt})`);
        break;
      }
      say(`❌ Task #${task.num} ${outcome.state}: ${String(outcome.error).slice(0, 200)}`);
      if (attempt < RETRIES) say(`   ↻ retrying (${attempt + 1}/${RETRIES})`);
    }

    const record = {
      num: task.num,
      text: task.text,
      category: task.category,
      passed: outcome.passed,
      state: outcome.state,
      attempts,
      ms: outcome.ms,
      error: outcome.error,
      report: outcome.report || '',
      missionId: outcome.missionId || null,
      steps: outcome.steps || [],
      verdicts: outcome.verdicts || [],
      evidence: outcome.evidence,
      finishedAt: new Date().toISOString(),
    };
    results.tasks = results.tasks.filter((t) => t.num !== task.num).concat(record).sort((a, b) => a.num - b.num);
    saveResults(results);

    if (!outcome.passed && STOP_ON_FAIL) {
      say('🛑 --stop-on-fail: stopping here for investigation');
      break;
    }
    // A breath between missions: the browser and the widget both settle.
    await wait(2000);
  }

  const ran = results.tasks;
  results.endedAt = Date.now();
  results.summary = {
    tasks: ran.length,
    passed: ran.filter((t) => t.passed).length,
    failed: ran.filter((t) => !t.passed).length,
    firstAttemptPasses: ran.filter((t) => t.passed && t.attempts === 1).length,
    totalSeconds: Math.round(ran.reduce((sum, t) => sum + (t.ms || 0), 0) / 1000),
  };
  saveResults(results);

  say('');
  say(`📊 ${results.summary.passed}/${results.summary.tasks} passed · ${results.summary.failed} failed`);
  say(`   results: ${path.relative(HERE, RESULTS)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    say(`💥 harness stopped: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
