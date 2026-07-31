// The brain: turns a sentence from you into a plan Woboo can execute, and turns
// a failed verify into a corrected instruction for the crew.
//
// Two things worth knowing:
//   * The brain is optional. With no credentials Woboo falls back to a
//     deterministic plan (delegate the whole task, then run the project's own
//     tests). Less clever, still useful — the body works without the cloud.
//   * Planning is a structured-output call, so the plan arrives as validated
//     JSON instead of prose Woboo has to guess its way through.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSettings } from './config.mjs';
import * as nim from './nim.mjs';
import { describe as describeTools } from './toolbox.mjs';
import { describe as describeReach } from './capabilities.mjs';
import { record } from './journal.mjs';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    // Understand the request before planning against it.
    //
    // Woboo was going straight from a sentence to a list of commands, and the
    // gap showed: asked to send an email and then summarise a correspondence in
    // an organised PDF, it produced six steps that wrote a text file nothing
    // created and checked for it three times. Nowhere did it work out that
    // there were two things wanted and what each of them had to look like
    // finished.
    //
    // Saying that first, in its own words, is what makes the plan follow from
    // the request rather than from the shape of the sentence. It is also what
    // the owner sees, so a misunderstanding is visible before any work happens
    // rather than after all of it.
    understanding: {
      type: 'object',
      description: 'What the owner actually wants, worked out before any steps are chosen.',
      properties: {
        asking_for: {
          type: 'string',
          description: 'The request restated plainly, in your own words, as a person would explain it to a colleague.',
        },
        deliverables: {
          type: 'array',
          description:
            'Each separate thing the owner should have when this is finished, and in what form — "an email sent to sam@x.com", "a PDF summarising the support thread". One entry per thing; a task often has more than one.',
          items: { type: 'string' },
        },
        done_when: {
          type: 'string',
          description: 'How the owner would know it worked, stated as something observable.',
        },
        care_about: {
          type: 'array',
          description:
            'What would make this a bad job even if every step ran: the wrong tone, the wrong account, missing the point of the question, a document nobody could read. Empty if nothing stands out.',
          items: { type: 'string' },
        },
      },
      required: ['asking_for', 'deliverables', 'done_when', 'care_about'],
      additionalProperties: false,
    },
    summary: {
      type: 'string',
      description: 'One sentence describing what finishing this task means.',
    },
    steps: {
      type: 'array',
      description: 'Ordered steps. Prefer 2-6. Each step must be independently checkable.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative label, under 60 chars.' },
          kind: {
            type: 'string',
            enum: ['research', 'web', 'delegate', 'shell', 'compose', 'computer', 'inspect'],
            description:
              'research = search the web, read sources, write a cited report and render it to PDF, all in one step; ' +
              'web = drive a real browser through the DOM: click real elements, fill forms, read pages; ' +
              'delegate = hand a spec to the installed coding tool; shell = run a command directly; ' +
              'compose = read local files and WRITE a document from them; ' +
              'computer = drive the mouse and keyboard on screen like a person; inspect = look at the screen.',
          },
          instruction: {
            type: 'string',
            description:
              'For delegate: the full spec to hand the coding tool. For shell: the exact command. ' +
              'For computer: the on-screen goal, stated so someone sitting at the machine could follow it. ' +
              'For inspect: what to look for.',
          },
          verify: {
            type: 'string',
            description:
              'A shell command that exits 0 only if the step really worked (tests, build, lint). Empty string when nothing can be checked.',
          },
        },
        required: ['title', 'kind', 'instruction', 'verify'],
        additionalProperties: false,
      },
    },
  },
  required: ['understanding', 'summary', 'steps'],
  additionalProperties: false,
};

const REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: { type: 'string', description: 'One sentence on why it failed.' },
    instruction: {
      type: 'string',
      description: 'The corrected spec to hand back to the coding tool, quoting the concrete error.',
    },
  },
  required: ['diagnosis', 'instruction'],
  additionalProperties: false,
};

const SYSTEM = `You are the planning half of Woboo, an agent that operates its owner's PC.

BEFORE ANYTHING ELSE, WORK OUT WHAT IS ACTUALLY WANTED.

Fill in "understanding" first and let the plan follow from it. Not from the
shape of the sentence — from what the person meant.

- People write one sentence containing several requests. "Send Sam an email
  asking for updates, then check everything support@x.com sent me and give me a
  summary in an organised PDF" is two deliverables, not one: a sent email, and a
  document. List each separately. A plan that quietly serves only the first is a
  failed plan even if every step passes.
- Read for intent, not keywords. "Do me a summary of what happened" is asking
  what the story was — who wanted what, what was agreed, where it stands — not
  for a list of subject lines. "Organised" means it has a shape someone can
  read: headings, order, the point stated.
- Where the material lives matters. Messages in a mailbox are found through that
  mailbox's own search, never a web search engine. Files on disk are read with a
  command. Say in the plan where each thing is going to come from.
- If the request is genuinely ambiguous, plan the reading you would most likely
  be right about and note the assumption in "care_about". Do not stall.

Then plan the steps that produce exactly those deliverables, in an order where
each has what it needs from the one before. Every step exists to serve a
deliverable; if a step serves none, drop it.


Woboo does not write code itself. It delegates coding to a tool already installed on
the machine (Claude Code or Codex), then proves the work with real commands before
reporting back. Plan for that shape:

- Put the actual building in "delegate" steps, with a spec complete enough that a
  coding agent could act on it without asking follow-up questions.
- Every step's "verify" should be a command that fails loudly when the step did not
  really work. Prefer the project's own tests, build, or typecheck. If a step
  genuinely cannot be checked by a command, use an empty string rather than a
  command that always passes.
- A verify is judged ONLY by its exit code, so it must actually set one. A bare
  expression is worthless: "Test-Path 'x'" and "(Test-Path 'x') -and (...)" both
  print True or False and exit 0 either way, so they pass even when the step
  failed. Always branch explicitly:
      if ((Test-Path 'x') -and ((Get-Item 'x').Length -gt 0)) { exit 0 } else { exit 1 }
  Commands that already exit properly on failure — npm test, git, tsc — need no
  wrapping.
- Use "shell" steps for setup and checks, never for tasks a coding tool should do.
- When the owner asks for research, a report, a briefing or a write-up on a
  topic, use ONE "research" step and nothing else. It searches the web, judges
  and reads the sources, notices what is still missing and looks again, writes a
  cited document and renders the PDF — the whole job. Do not decompose it into
  download-and-print steps: copying a page is not research and is never an
  acceptable answer. The instruction is simply the question, stated fully:
    "Research African and Asian elephants: biology, social structure, range,
     population figures and conservation status. Deliver a PDF."
  Leave its "verify" empty — the step checks its own work with an editor pass.
- Use "compose" only to write from files that are ALREADY on disk. If the
  material still has to be found, that is "research".
- A "web" step is ONE step for the whole browser errand, not one per click. It
  runs its own loop: it opens the page, reads what is actually on it, clicks,
  types, and keeps going until the goal is met. Splitting "open Gmail", "click
  compose", "type the address", "click send" into four steps is wrong — each
  would start a fresh browser and lose the last one's progress. Write it as one
  instruction stating the whole errand:
    "In Gmail, send an email to sam@example.com with the subject 'Report' and
     the elephants PDF attached."
  Its "verify" is usually empty: the step reports what it saw on the page.
- A "web" step CANNOT write files. It reads pages and reports what it found, and
  that report is passed to the steps after it. Never write "extract X to a text
  file" as a web step and then verify that the file exists — the file will never
  be there, the check will fail three times, and the failure will be blamed on
  work that was actually done. If the material has to end up in a document, the
  web step gathers it and a "compose" step writes it.
- Never write a "verify" for a file that no earlier step actually creates. A
  check is only worth having when a command in the plan is what makes it pass.
- Use "computer" steps for anything that happens on the owner's screen. Woboo
  looks at the display and drives the real mouse and keyboard. State the goal,
  not the clicks — it works out where to click by looking.
  Choose "computer" when the task is about the machine itself and nothing else
  can reach it: a desktop application by name — VS Code, Word, Spotify,
  Explorer, Settings, Task Manager — or the desktop, the Start menu, an
  installer, a system dialog.
  Do NOT choose "computer" for anything that lives on the web. Woboo drives a
  browser through the page's own structure, which is roughly ten thousand times
  faster than looking at the screen: measured on this machine, one DOM action
  costs 16ms and one vision step 153 seconds. "Open Chrome and search for X",
  "check the prices on that site", "read my Gmail" are all "web" steps. The
  browser window is visibly open and visibly driven either way.
  Choose "shell" for work with no visible surface — files, git, builds, tests,
  installs — where a command is exact and verifiable.
- Never fetch a web page with a shell command. Invoke-WebRequest, curl and wget
  are not "browsing": they get one raw file, they cannot follow a search result,
  they trip anti-bot pages, and the owner asked to see their machine used rather
  than a silent HTTP request. If the information is on the web, it is a "web"
  step, or a "research" step when the answer needs several sources.
  When a task could go either way, ask which the owner actually wants to happen:
  if they said "open", they want the window open.
- Write every shell command for the platform's real shell. On win32 that is
  PowerShell, never cmd.exe: use Test-Path, New-Item, $LASTEXITCODE. cmd-isms
  like "if exist X exit 0 else exit 1", %VAR% or 2>NUL are parse errors there and
  fail every single time. Elsewhere, write POSIX sh.
- Quote paths with single quotes, not double: 'C:\\some\\path'. These commands
  travel through JSON, and a double quote has to be escaped on the way, which is
  where malformed commands come from. Single quotes need no escaping and are
  literal in PowerShell, which is what a path wants anyway.
- Build only on tools the request says are installed. That list is measured on
  the actual machine, not guessed: if something is not on it, a step using it
  cannot run, no matter how standard the tool seems.
- Keep the plan short. Two good steps beat six speculative ones.

Deliver what the owner asked for at the scope they intended. Do not widen the task.`;

let client = null;
let clientError = null;

export async function getClient() {
  if (client) return client;
  if (clientError) throw clientError;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Zero-arg construction resolves an API key, an auth token, or an `ant`
    // profile — whichever the machine has.
    client = new Anthropic();
    return client;
  } catch (err) {
    clientError = new Error(
      `brain unavailable: ${err.message}. Run "npm install" inside the wobo folder.`,
    );
    throw clientError;
  }
}

// Credentials can come from an env var or from an `ant auth login` profile, so
// an unset ANTHROPIC_API_KEY does not mean there is nothing to authenticate with.
// Which brain is in charge. 'auto' prefers Anthropic and falls back to NIM.
export function provider() {
  const chosen = loadSettings().provider || 'auto';
  if (chosen === 'nim') return 'nim';
  if (chosen === 'anthropic') return 'anthropic';
  if (anthropicCredentials()) return 'anthropic';
  return nim.hasCredentials() ? 'nim' : 'anthropic';
}

export function hasCredentials() {
  return provider() === 'nim' ? nim.hasCredentials() : anthropicCredentials();
}

function anthropicCredentials() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const configDir =
    process.env.ANTHROPIC_CONFIG_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'Anthropic')
      : path.join(os.homedir(), '.config', 'anthropic'));
  try {
    return fs.readdirSync(path.join(configDir, 'credentials')).length > 0;
  } catch {
    return false;
  }
}

export function installed() {
  try {
    // Resolve without importing so `wobo doctor` can report before install.
    import.meta.resolve?.('@anthropic-ai/sdk');
    return true;
  } catch {
    return false;
  }
}

export function status() {
  const which = provider();
  if (which === 'nim') {
    return { provider: 'nim', model: nim.model(), effort: 'n/a', credentials: nim.hasCredentials(), ready: nim.hasCredentials() };
  }
  return {
    model: loadSettings().model,
    effort: loadSettings().effort,
    credentials: hasCredentials(),
    ready: hasCredentials(),
  };
}

function textOf(response) {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

// One request shape, used by both plan() and repair().
async function askAnthropic({ prompt, schema, maxTokens = 16_000, system = SYSTEM }) {
  const settings = loadSettings();
  const anthropic = await getClient();

  const body = {
    model: settings.model,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: settings.effort,
      format: { type: 'json_schema', schema },
    },
    messages: [{ role: 'user', content: prompt }],
  };

  // Opus 5's safety classifiers can decline a request. Server-side fallbacks
  // re-run a declined request on Anthropic's recommended model in the same
  // call, so a false positive on benign work does not kill the mission.
  let response;
  try {
    response = await anthropic.beta.messages.create({
      ...body,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    // If this deployment does not accept the fallback beta, the plan still
    // matters more than the safety net — retry once without it.
    if (err?.status === 400) {
      record('brain', `fallbacks unavailable (${err.message}); retrying without`, { level: 'warn' });
      response = await anthropic.messages.create(body);
    } else {
      throw err;
    }
  }

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category || 'unspecified';
    throw new Error(`the brain declined this request (${category})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('the brain ran out of output budget before finishing the plan');
  }

  const raw = textOf(response);
  try {
    return { data: JSON.parse(raw), usage: response.usage, model: response.model };
  } catch {
    throw new Error(`the brain returned something unparseable:\n${raw.slice(0, 400)}`);
  }
}

// A plan that fetches a web page with a shell command is the wrong plan.
//
// The system prompt says so, the owner's stance says so, and the model does it
// anyway — Invoke-WebRequest into a regex against raw HTML, which gets one file,
// cannot follow a search result, trips anti-bot pages, and is invisible to an
// owner who asked to watch their machine being used. Prompting harder does not
// fix something a model will do one time in three. Rewriting the step does.
const FETCHES_A_PAGE =
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b[^\n]*\bhttps?:\/\/(?!localhost|127\.0\.0\.1)/i;

export function redirectWebFetches(plan) {
  if (!Array.isArray(plan?.steps)) return plan;
  for (const step of plan.steps) {
    if (step.kind !== 'shell' || !FETCHES_A_PAGE.test(step.instruction || '')) continue;
    const url = (step.instruction.match(/https?:\/\/[^\s'"<>)]+/) || [])[0] || '';
    record('brain', `rewrote a shell fetch of ${url || 'a web page'} into a browser step`, { level: 'warn' });
    step.kind = 'web';
    step.instruction = `Open ${url || 'the page named in this task'} and find: ${step.title}. Read what the page actually says and report it.`;
    // The browser step reports what it saw; there is no file for a command to
    // check, and the old verify was written against one.
    step.verify = '';
  }
  return plan;
}

export async function plan({ task, workspace, crew, memory = '' }) {
  const prefer = loadSettings().prefer || 'auto';
  const stance =
    prefer === 'gui'
      ? 'The owner has set Woboo to work visibly rather than invisibly. Prefer "web" ' +
        'steps: a real browser window they can watch, driven through the page itself. ' +
        'Use "computer" ONLY for native desktop applications that have no web version, ' +
        'because it costs about 150 seconds per action against 16 milliseconds for a ' +
        'web step. Working visibly means driving the browser, not photographing it.'
      : prefer === 'commands'
        ? 'The owner has set Woboo to prefer commands. Avoid web and computer steps ' +
          'unless the task genuinely cannot be done any other way.'
        : '';
  // What is genuinely installed, so the plan is built on tools that exist.
  const toolbox = [await describeTools().catch(() => ''), describeReach()]
    .filter(Boolean)
    .join('\n\n');

  if (provider() === 'nim') {
    return redirectWebFetches(
      await nim.plan({ task, workspace, crew, memory, toolbox, stance, schema: PLAN_SCHEMA, system: SYSTEM }),
    );
  }
  const prompt = `Owner's task:
${task}

Workspace: ${workspace}
Coding tool available for delegation: ${crew || 'none installed — avoid "delegate" steps and use "shell" instead'}
Platform: ${process.platform}
Shell commands run in: ${process.platform === 'win32' ? 'PowerShell (not cmd.exe)' : '/bin/sh'}

What Woboo can actually do right now:
- run shell commands in the workspace${crew ? '' : ' (this is the main way to act)'}
${crew ? `- hand a written spec to ${crew}, which can read and write files` : '- no coding tool is installed, so there is nothing to delegate to'}
- look at the screen, and drive the mouse and keyboard in a "computer" step —
  use this for anything that only exists in a GUI
${toolbox}
If the task needs something outside all of that, say so in the summary rather
than planning a step that cannot possibly work.
${
  memory
    ? `
What Woboo already knows about this workspace from earlier missions. Treat the
owner's corrections as binding, and prefer checks that have actually caught
problems here over ones that always pass:

${memory}
`
    : ''
}
Produce the plan.`;

  const { data, usage, model } = await askAnthropic({ prompt, schema: PLAN_SCHEMA });
  record('brain', `planned ${data.steps.length} step(s) with ${model}`, {
    level: 'ok',
    usage: usage && { in: usage.input_tokens, out: usage.output_tokens },
  });
  return redirectWebFetches(data);
}

// A structured answer to any question, whichever brain is in charge. The
// research loop and the critic both need this — they ask things that are not
// "make a plan" but still want validated JSON back.
export async function ask({ system, prompt, schema, name = 'answer', maxTokens = 8000, think = true }) {
  if (provider() === 'nim') return nim.structured({ system, prompt, schema, name, maxTokens, think });
  const { data } = await askAnthropic({ prompt, schema, maxTokens, system });
  return data;
}

// Prose out, not JSON. Used by the scribe to actually write a document.
export async function write({ system, prompt, maxTokens = 16_000 }) {
  if (provider() === 'nim') return nim.write({ system, prompt, maxTokens });

  const anthropic = await getClient();
  const response = await anthropic.messages.create({
    model: loadSettings().model,
    max_tokens: maxTokens,
    system,
    thinking: { type: 'adaptive' },
    output_config: { effort: loadSettings().effort },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') throw new Error('the brain declined to write this');
  return textOf(response);
}

export async function repair({ task, step, failure, attempt }) {
  if (provider() === 'nim') {
    return nim.repair({ task, step, failure, attempt, schema: REPAIR_SCHEMA, system: SYSTEM });
  }
  const prompt = `While working on: ${task}

Step "${step.title}" was handed to the coding tool with this instruction:
${step.instruction}

Its verify command was:
${step.verify}

That command failed (attempt ${attempt}). Output:
${failure.slice(0, 6000)}

Write a corrected instruction for the coding tool. Quote the specific error, say what
to change, and do not restate the whole original task.`;

  const { data } = await askAnthropic({ prompt, schema: REPAIR_SCHEMA, maxTokens: 8000 });
  record('brain', `diagnosis: ${data.diagnosis}`, { level: 'warn' });
  return data;
}

// ── no-credentials fallback ───────────────────────────────────────────────────
// Deliberately dumb and completely predictable: hand the whole task to the
// coding tool, then run whatever test command the project already defines.

// When the brain could not be reached, there is no plan — and pretending
// otherwise is worse than failing. The old fallback echoed a line about missing
// coding tools and reported "All 1 steps done", which reads as success for work
// that never happened. A mission nobody could plan must say so.
export function unplannable({ task, reason }) {
  return {
    summary: `Could not plan "${task}"`,
    unplanned: true,
    reason,
    steps: [],
  };
}

export function offlinePlan({ task, workspace, crew, reason = '' }) {
  const verify = guessVerify(workspace);
  const steps = [];

  if (crew) {
    steps.push({
      title: 'Delegate the task to the coding tool',
      kind: 'delegate',
      instruction: task,
      verify,
    });
  } else {
    steps.push({
      title: 'Report that no coding tool is installed',
      kind: 'shell',
      instruction: 'echo "no crew tool found on PATH — install Claude Code or Codex"',
      verify: '',
    });
  }

  if (verify) {
    steps.push({
      title: 'Prove it with the project checks',
      kind: 'shell',
      instruction: verify,
      verify,
    });
  }

  return {
    // Say which it was. "No credentials" when the real cause was a busy server
    // sends the owner off checking their key for no reason.
    summary: `Offline plan (${reason || 'no brain credentials'}): ${task}`,
    steps,
    offline: true,
  };
}

// Look at what the project actually uses rather than guessing a command that
// will fail on the first run.
export function guessVerify(workspace) {
  try {
    const pkgPath = path.join(workspace, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {};
      if (scripts.test) return 'npm test';
      if (scripts.build) return 'npm run build';
      if (scripts.lint) return 'npm run lint';
    }
    if (fs.existsSync(path.join(workspace, 'go.mod'))) return 'go test ./...';
    if (fs.existsSync(path.join(workspace, 'Cargo.toml'))) return 'cargo test';
    if (
      fs.existsSync(path.join(workspace, 'pyproject.toml')) ||
      fs.existsSync(path.join(workspace, 'pytest.ini'))
    ) {
      return 'pytest -q';
    }
  } catch {
    // An unreadable manifest just means we cannot suggest a check.
  }
  return '';
}
