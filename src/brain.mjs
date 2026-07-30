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
import { record } from './journal.mjs';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
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
            enum: ['delegate', 'shell', 'computer', 'inspect'],
            description:
              'delegate = hand a spec to the installed coding tool; shell = run a command directly; ' +
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
  required: ['summary', 'steps'],
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
- Use "computer" steps for work that only exists on screen: browsing the web,
  clicking through a GUI, reading a desktop app's interface. Woboo will look at the
  screen and drive the mouse and keyboard itself. State the goal, not the clicks —
  it decides where to click by looking. Prefer "shell" when a command would do the
  same job, because a command can be verified and a click cannot.
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
async function ask({ prompt, schema, maxTokens = 16_000 }) {
  const settings = loadSettings();
  const anthropic = await getClient();

  const body = {
    model: settings.model,
    max_tokens: maxTokens,
    system: SYSTEM,
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

export async function plan({ task, workspace, crew, memory = '' }) {
  // What is genuinely installed, so the plan is built on tools that exist.
  const toolbox = await describeTools().catch(() => '');

  if (provider() === 'nim') {
    return nim.plan({ task, workspace, crew, memory, toolbox, schema: PLAN_SCHEMA, system: SYSTEM });
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

  const { data, usage, model } = await ask({ prompt, schema: PLAN_SCHEMA });
  record('brain', `planned ${data.steps.length} step(s) with ${model}`, {
    level: 'ok',
    usage: usage && { in: usage.input_tokens, out: usage.output_tokens },
  });
  return data;
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

  const { data } = await ask({ prompt, schema: REPAIR_SCHEMA, maxTokens: 8000 });
  record('brain', `diagnosis: ${data.diagnosis}`, { level: 'warn' });
  return data;
}

// ── no-credentials fallback ───────────────────────────────────────────────────
// Deliberately dumb and completely predictable: hand the whole task to the
// coding tool, then run whatever test command the project already defines.

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
