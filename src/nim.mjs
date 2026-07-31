// A second brain: NVIDIA NIM.
//
// NIM hosts a large catalogue behind an OpenAI-compatible endpoint and hands out
// free credits, which makes it the cheapest way to give Woboo a real planner
// while you are still deciding whether you like it. Get a key at
// https://build.nvidia.com — sign in, pick a model, "Get API Key" — then:
//
//   woboo secret nvidia nvapi-...
//   woboo set provider nim
//
// Deliberately written against raw HTTP rather than an SDK: it is one endpoint
// with one JSON shape, and Woboo's whole point is not needing a toolchain.
//
// What it can and cannot do:
//   * plan() and repair() — yes. Those are structured-output calls and NIM
//     models handle them well.
//   * the pilot (driving the screen) — no. That needs Anthropic's computer-use
//     tool protocol, which is not part of the OpenAI-compatible surface. Woboo
//     says so plainly rather than pretending.

import { loadSettings, loadSecrets } from './config.mjs';
import { record } from './journal.mjs';

const BASE = 'https://integrate.api.nvidia.com/v1';

// Statuses that mean "try again", not "give up". A shared free tier produces all
// of these routinely and none of them is a reason to abandon a mission.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Picked from the live catalogue for planning work. The default is a
// mixture-of-experts model: 120B total but only ~12B active per token, so it is
// quick and cheap on a free allowance while still reasoning properly.
export const SUGGESTED = [
  { id: 'nvidia/nemotron-3-super-120b-a12b', note: 'default — MoE, fast and strong at planning' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', note: 'the heaviest NVIDIA model; slower, best quality' },
  { id: 'deepseek-ai/deepseek-v4-pro', note: 'strong reasoning' },
  { id: 'moonshotai/kimi-k2.6', note: 'strong at agentic, tool-shaped tasks' },
  { id: 'openai/gpt-oss-120b', note: 'open-weight GPT, reliable JSON' },
  { id: 'meta/llama-3.3-70b-instruct', note: 'dependable baseline' },
];

export const DEFAULT_MODEL = SUGGESTED[0].id;

export function apiKey() {
  return loadSecrets().nvidiaApiKey || process.env.NVIDIA_API_KEY || '';
}

export function hasCredentials() {
  return Boolean(apiKey());
}

export function model() {
  return loadSettings().nimModel || DEFAULT_MODEL;
}

export async function listModels() {
  const response = await fetch(`${BASE}/models`, {
    headers: apiKey() ? { authorization: `Bearer ${apiKey()}` } : {},
  });
  if (!response.ok) throw new Error(`NIM listing failed (${response.status})`);
  const body = await response.json();
  return body.data.map((m) => m.id);
}

// Some models honour response_format json_schema, some ignore it, and a few
// reject it outright. Rather than maintain a compatibility table that rots, ask
// for the schema, and parse defensively either way.
function extractJson(text) {
  const trimmed = String(text || '').trim();
  // Reasoning models often narrate before the JSON, and some wrap it in a fence.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost balanced object in the response.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Give up below with the raw text, which is more useful than a guess.
      }
    }
  }
  throw new Error(`NIM returned something unparseable:\n${trimmed.slice(0, 400)}`);
}

async function ask({ system, prompt, schema, name, maxTokens = 8000, think = true }) {
  const key = apiKey();
  if (!key) throw new Error('no NVIDIA key — run `woboo secret nvidia nvapi-...`');

  const body = {
    model: model(),
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `${prompt}\n\nReply with JSON only, matching this schema exactly. No prose, no code fence:\n${JSON.stringify(schema)}`,
      },
    ],
    response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } },
  };

  // Nemotron reasons before answering when asked to, and a plan is exactly the
  // kind of work that benefits. The reasoning comes back on its own field, so
  // the answer stays clean JSON. NVIDIA's guidance for thinking mode is a warm
  // temperature; without it, the usual near-deterministic setting.
  if (think) {
    body.temperature = 1;
    body.top_p = 0.95;
    body.chat_template_kwargs = { enable_thinking: true };
    // The reasoning budget comes OUT of max_tokens; it is not extra.
    //
    // This asked for twice the entire output budget to be spent thinking, so
    // the model deliberated until it ran out and the answer was never written.
    // What came back was a fragment of its own scratchpad, which parsed as JSON
    // often enough to look like a plan — for a task it had invented, because
    // the scratchpad was where it was imagining examples. That is where "Slack
    // #project-alpha" and "team@example.com" came from on a request that
    // mentioned neither.
    //
    // Half, so there is always at least as much room for the answer as for the
    // thinking that produced it.
    body.reasoning_budget = Math.min(8192, Math.floor(maxTokens * 0.5));
  } else {
    body.temperature = 0.2;
    // Say "off" rather than staying silent. Nemotron reasons by default, and an
    // omitted flag leaves it on — which on a long prompt means the whole output
    // budget goes to deliberation and the JSON never arrives.
    body.chat_template_kwargs = { enable_thinking: false };
  }

  // A dropped wifi packet is not a reason to abandon a mission. fetch() rejects
  // on a network fault rather than returning a status, so the HTTP retry below
  // never sees it — this catches the case where there is no response at all.
  const post = async () => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // Measured: a plan comes back in 2–60 seconds. A request still open
          // at 75 is not slow, it is lost — and waiting three minutes to find
          // that out, then retrying twice, turns one dropped packet into five
          // minutes of a machine that looks dead.
          signal: AbortSignal.timeout(75_000),
        });
      } catch (err) {
        lastError = err;
        record('brain', `network fault reaching NIM (${err.message}); retry ${attempt}/3`, { level: 'warn' });
        await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
      }
    }
    throw lastError;
  };

  // Not every model on the catalogue accepts every extra. Rather than keep a
  // compatibility table that rots, shed the optional parts one at a time and
  // keep the request — the schema also lives in the prompt, and thinking is a
  // quality lever, not a requirement.
  let response = await post();
  if (response.status === 400 || response.status === 422) {
    delete body.chat_template_kwargs;
    delete body.reasoning_budget;
    response = await post();
  }
  if (response.status === 400 || response.status === 422) {
    delete body.response_format;
    response = await post();
  }

  // A free allowance shares workers, so "all 32 busy" is routine rather than
  // broken — two missions starting together is enough to hit it. Wait and try
  // again instead of throwing the plan away over a queue that clears in seconds.
  //
  // 500 belongs here too. NIM returns "Failed to parse chat completion
  // response" now and then, entirely at its end, and it used to end the mission:
  // one bad response from a shared free tier and everything the owner asked for
  // was abandoned mid-step.
  for (let attempt = 1; attempt <= 4 && RETRYABLE.has(response.status); attempt += 1) {
    const wait = attempt * 4000;
    record('brain', `NIM busy (${response.status}); retrying in ${wait / 1000}s`, { level: 'warn' });
    await new Promise((resolve) => setTimeout(resolve, wait));
    response = await post();
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`NIM ${response.status}: ${detail.slice(0, 200) || response.statusText}`);
  }

  const payload = await response.json();
  const choice = payload.choices?.[0];
  if (!choice) throw new Error('NIM returned no choices');

  // Sometimes the model simply comes apart — a thousand <unk> tokens where the
  // answer should be. It is a decoding failure at their end, not a bad request,
  // and it used to end the mission: everything the owner asked for abandoned
  // because one sampled response was garbage. Ask once more.
  const raw = choice.message?.content || '';
  if (/(<unk>){8,}|(�){8,}/.test(raw)) {
    record('brain', 'NIM returned garbage tokens; asking again', { level: 'warn' });
    const retry = await post();
    if (retry.ok) {
      const second = await retry.json();
      const text = second.choices?.[0]?.message?.content || '';
      if (text && !/(<unk>){8,}/.test(text)) {
        return { data: extractJson(text), usage: second.usage, model: second.model };
      }
    }
  }
  // Reasoning models put the answer in `content` and their thinking elsewhere;
  // either way `content` is what we want.
  const data = extractJson(choice.message?.content);
  return { data, usage: payload.usage, model: payload.model };
}

// Any structured question, not just planning — the research loop asks about
// gaps, the critic asks for a verdict.
export function structured({ system, prompt, schema, name = 'answer', maxTokens = 8000, think = true }) {
  return ask({ system, prompt, schema, name, maxTokens, think }).then((r) => r.data);
}

// Long-form prose rather than a schema — the scribe wants a document back, not
// a validated object. Thinking stays off: this is writing, not reasoning, and a
// reasoning budget on top of 16k of output is a slow way to get the same words.
export async function write({ system, prompt, maxTokens = 16_000 }) {
  const key = apiKey();
  if (!key) throw new Error('no NVIDIA key — run `woboo secret nvidia nvapi-...`');

  const post = () =>
    fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model(),
        max_tokens: maxTokens,
        temperature: 0.6,
        top_p: 0.95,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });

  let response = await post();
  for (let attempt = 1; attempt <= 4 && RETRYABLE.has(response.status); attempt += 1) {
    const wait = attempt * 4000;
    record('brain', `NIM ${response.status}; retrying in ${wait / 1000}s`, { level: 'warn' });
    await new Promise((resolve) => setTimeout(resolve, wait));
    response = await post();
  }
  if (!response.ok) {
    throw new Error(`NIM ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || '';
}

// ── the two calls the foreman makes ───────────────────────────────────────────
// Same shapes brain.mjs produces, so the foreman cannot tell which brain it got.

export async function plan({ task, workspace, crew, memory = '', toolbox = '', stance = '', schema, system }) {
  const prompt = `Owner's task:
${task}

Workspace: ${workspace}
Coding tool available for delegation: ${crew || 'none installed — avoid "delegate" steps and use "shell" instead'}
Platform: ${process.platform}
Shell commands run in: ${process.platform === 'win32' ? 'PowerShell (not cmd.exe)' : '/bin/sh'}
${toolbox ? `
What is actually available on this machine:
${toolbox}
` : ''}
${memory ? `\nWhat Woboo already knows about this workspace:\n\n${memory}\n` : ''}
${stance ? `
${stance}
` : ''}
Produce the plan.`;

  const { data, usage, model: used } = await ask({ system, prompt, schema, name: 'plan', maxTokens: 14_000 });
  record('brain', `planned ${data.steps?.length ?? 0} step(s) with ${used}`, {
    level: 'ok',
    usage: usage && { in: usage.prompt_tokens, out: usage.completion_tokens },
  });
  return data;
}

export async function repair({ task, step, failure, attempt, schema, system }) {
  const prompt = `While working on: ${task}

Step "${step.title}" was handed to the coding tool with this instruction:
${step.instruction}

Its verify command was:
${step.verify}

That command failed (attempt ${attempt}). Output:
${failure.slice(0, 6000)}

Write a corrected instruction for the coding tool. Quote the specific error, say what
to change, and do not restate the whole original task.`;

  const { data } = await ask({ system, prompt, schema, name: 'repair', maxTokens: 3000 });
  record('brain', `diagnosis: ${data.diagnosis}`, { level: 'warn' });
  return data;
}
