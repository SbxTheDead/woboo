// The check Woboo was missing.
//
// Its whole thesis is that a step is done when a command says so, not when the
// model says so. Yet the deliverable — the actual document — was verified by
// "the file exists and is over 2KB". A report can pass that test while being
// confidently wrong, and Woboo would report it as proven work.
//
// So this reads the draft the way a sceptical editor would: against the brief it
// was given and the sources it was written from. Anything it flags goes back
// through the same repair loop everything else uses.

import { record } from './journal.mjs';

const SCHEMA = {
  type: 'object',
  properties: {
    covers_brief: { type: 'boolean', description: 'Does the draft answer everything the brief asked for?' },
    missing: {
      type: 'array',
      description: 'Parts of the brief the draft does not answer. Empty if none.',
      items: { type: 'string' },
    },
    unsupported: {
      type: 'array',
      description:
        'Specific claims — especially numbers, dates and names — that do not appear in the sources. Empty if none.',
      items: { type: 'string' },
    },
    uncited: {
      type: 'array',
      description: 'Factual claims carrying no citation marker that should have one. Empty if none.',
      items: { type: 'string' },
    },
    problems: {
      type: 'array',
      description: 'Anything else wrong: padding, repetition, copied passages, contradictions, poor structure.',
      items: { type: 'string' },
    },
    verdict: {
      type: 'string',
      enum: ['good', 'needs_revision', 'unusable'],
      description: 'good = ship it; needs_revision = fixable; unusable = start over.',
    },
  },
  required: ['covers_brief', 'missing', 'unsupported', 'uncited', 'problems', 'verdict'],
  additionalProperties: false,
};

const SYSTEM = `You are a sceptical editor reviewing a draft before it goes to the
person who commissioned it. You did not write it and you have no stake in it.

Judge it on evidence, not style:
- Does it actually answer the brief, all of it?
- Is every specific claim — every number, date, place, name — traceable to the
  source material you were given? A figure that appears nowhere in the sources is
  the most important thing you can catch, because it is invented.
- Are factual claims cited?
- Is anything padded, repeated, self-contradictory, or copied verbatim at length?

Be concrete. "The conservation section is vague" is useless; "gives no population
figure for Asian elephants, though source 3 has one" is what the writer needs.

Do not invent problems to seem thorough. A good draft with nothing wrong should
come back with verdict "good" and empty lists — that is a real and common answer.`;

export async function critique({ brief, draft, sources, ask }) {
  // The sources are re-supplied so claims can be checked against them, not
  // against the model's memory of the world.
  const material = sources
    .map((s, i) => `--- SOURCE ${i + 1} (${s.host || 'local'}): ${s.title || s.url || ''} ---\n${s.text.slice(0, 9000)}`)
    .join('\n\n');

  const prompt = `The brief the writer was given:
${brief}

The draft they produced (HTML):
${String(draft).replace(/<style[\s\S]*?<\/style>/gi, '').slice(0, 40_000)}

The source material it was supposed to be written from:
${material}

Review the draft.`;

  // Thinking off, and a generous ceiling. The input here is a whole draft plus
  // every source, and with reasoning enabled the model spends its entire output
  // budget deliberating and never reaches the JSON — a verdict that never
  // arrives is worse than a blunt one.
  const report = await ask({
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
    name: 'critique',
    maxTokens: 4000,
    think: false,
  });

  const faults =
    report.missing.length + report.unsupported.length + report.uncited.length + report.problems.length;
  record(
    'critic',
    `verdict ${report.verdict}` +
      (faults
        ? ` — ${report.missing.length} gap(s), ${report.unsupported.length} unsupported, ${report.problems.length} problem(s)`
        : ' — nothing to fix'),
    { level: report.verdict === 'good' ? 'ok' : 'warn' },
  );

  return report;
}

// Turn a critique into instructions the writer can act on. Deliberately not a
// rewrite of the whole document: a targeted fix keeps what was already right.
export function asRevisionNotes(report) {
  const notes = [];
  if (report.missing.length) {
    notes.push(`The brief is not fully answered. Add coverage of:\n${report.missing.map((m) => `  - ${m}`).join('\n')}`);
  }
  if (report.unsupported.length) {
    notes.push(
      'These claims are not supported by the sources. Remove them, or replace them with what the sources ' +
        `actually say:\n${report.unsupported.map((m) => `  - ${m}`).join('\n')}`,
    );
  }
  if (report.uncited.length) {
    notes.push(`Add citation markers to:\n${report.uncited.map((m) => `  - ${m}`).join('\n')}`);
  }
  if (report.problems.length) {
    notes.push(`Fix:\n${report.problems.map((m) => `  - ${m}`).join('\n')}`);
  }
  return notes.join('\n\n');
}
