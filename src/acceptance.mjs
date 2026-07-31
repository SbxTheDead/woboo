// Did Woboo actually deliver what it said it would?
//
// Every step can pass and the owner can still be handed the wrong thing. Today
// alone: a PDF about package-lock.json for a task about a support mailbox, a
// file containing the word "[placeholder]", three pages of research sent
// nowhere because the next step looked for a filename nobody had created, and a
// request for ten internships answered with one glance at a search page.
//
// In every one of those the mission reported success, because "all steps ran"
// was the only question anyone asked.
//
// Woboo now writes down what the owner wants before it starts. This is the other
// half: at the end, take that list and check it — against what is actually on
// disk, not against the model's recollection of having been helpful. A step is
// proven by a command; a mission should be proven by its deliverables.

import fs from 'node:fs';
import path from 'node:path';
import { record } from './journal.mjs';

const SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      description: 'One entry per deliverable, in the order given.',
      items: {
        type: 'object',
        properties: {
          deliverable: { type: 'string', description: 'The deliverable, copied as it was written.' },
          met: {
            type: 'boolean',
            description:
              'True ONLY if the evidence shows this exists and is what was asked for. A file that exists but ' +
              'holds the wrong subject is not met. A count that falls short is not met.',
          },
          evidence: {
            type: 'string',
            description: 'The specific fact that decided it — a filename and what is in it, or what is absent.',
          },
        },
        required: ['deliverable', 'met', 'evidence'],
        additionalProperties: false,
      },
    },
    shortfall: {
      type: 'string',
      description:
        'If anything is not met, one plain sentence telling the owner what they did not get. Empty if all met.',
    },
  },
  required: ['verdicts', 'shortfall'],
  additionalProperties: false,
};

const SYSTEM = `You are checking whether a finished job matches what was asked for.

You are given the owner's deliverables, and evidence about the files that were
actually produced and what the steps reported. Judge each deliverable against the
EVIDENCE, not against how much work appears to have happened.

Be strict, and be specific about why:
- A file that exists but is about the wrong subject does not meet a deliverable.
  A summary of a support mailbox is not met by a document about a project's
  package manifest, however well formatted.
- A file containing "placeholder", "TODO", "lorem ipsum" or "summary goes here"
  meets nothing.
- If the deliverable names a quantity — ten offers, five suppliers — and the
  evidence shows fewer, it is not met. Say how many there actually are.
- "Sent to the owner" is met only if a step reports actually sending it.
- An empty or nearly empty file is not a document.

If a deliverable IS met, say what makes you sure — the file, and what is in it.
Do not be generous. The owner is about to be told this job is finished.`;

// Facts about a file, cheap enough to gather for all of them.
export function evidenceFor(file) {
  try {
    const stat = fs.statSync(file);
    const name = path.basename(file);
    const kb = Math.round(stat.size / 1024);
    if (stat.size === 0) return `${name} — EMPTY (0 bytes)`;

    if (/\.pdf$/i.test(file)) {
      // Counting page objects is crude and good enough to tell a real document
      // from a one-page stub.
      const raw = fs.readFileSync(file, 'latin1');
      const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
      return `${name} — PDF, ${pages} page(s), ${kb}KB`;
    }

    if (/\.(html?|txt|md|json|csv)$/i.test(file)) {
      const text = fs
        .readFileSync(file, 'utf8')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length < 40) return `${name} — ${kb}KB but only ${text.length} characters of text: "${text}"`;
      return `${name} — ${kb}KB, ${text.length} characters. It begins: "${text.slice(0, 600)}"`;
    }

    return `${name} — ${kb}KB`;
  } catch (err) {
    return `${path.basename(file)} — DOES NOT EXIST (${err.code || err.message})`;
  }
}

// The obvious failures, caught without asking a model. These are cheap, certain,
// and they are the ones that actually happened.
export function obviousShortfall(artifacts) {
  if (!artifacts.length) return 'no file was produced at all';
  for (const file of artifacts) {
    // Existence first, and for every kind of file. Checking it only while
    // reading text meant a missing PDF — the most likely thing to be missing,
    // since it is usually the deliverable — went unnoticed.
    if (!fs.existsSync(file)) return `${path.basename(file)} was reported but is not on disk`;
    if (fs.statSync(file).size === 0) return `${path.basename(file)} is empty`;

    let text = '';
    try {
      if (/\.(html?|txt|md)$/i.test(file)) text = fs.readFileSync(file, 'utf8');
    } catch {
      return `${path.basename(file)} could not be read back`;
    }
    if (/\[?\b(placeholder|lorem ipsum|TODO: ?fill|summary goes here)\b\]?/i.test(text)) {
      return `${path.basename(file)} still contains placeholder text`;
    }
  }
  return null;
}

export async function check({ understanding, steps = [], artifacts = [], ask } = {}) {
  const deliverables = understanding?.deliverables || [];
  if (!deliverables.length) return { checked: false, met: true, verdicts: [] };

  const files = artifacts.length ? artifacts.map((f) => `- ${evidenceFor(f)}`).join('\n') : '- (no files were produced)';
  const done = steps
    .map((s, i) => `${i + 1}. [${s.kind}] ${s.title} — ${String(s.output || '(no output)').slice(0, 300)}`)
    .join('\n');

  const prompt = `The owner asked for:
${understanding.asking_for}

They should end up with:
${deliverables.map((d, i) => `${i + 1}. ${d}`).join('\n')}

They would know it worked because: ${understanding.done_when || '(not stated)'}

===== EVIDENCE =====

FILES PRODUCED:
${files}

WHAT EACH STEP REPORTED:
${done}

===== END EVIDENCE =====

For each deliverable, decide whether the evidence shows it was actually produced.`;

  const answer = await ask({
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
    name: 'acceptance',
    maxTokens: 4000,
    think: false,
  });

  const verdicts = answer.verdicts || [];
  const met = verdicts.length > 0 && verdicts.every((v) => v.met);
  for (const v of verdicts) {
    record('accept', `${v.met ? '✓' : '✗'} ${v.deliverable} — ${v.evidence}`.slice(0, 200), {
      level: v.met ? 'ok' : 'error',
    });
  }
  return { checked: true, met, verdicts, shortfall: answer.shortfall || '' };
}
