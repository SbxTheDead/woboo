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
- An empty file meets a deliverable only where the owner asked for an empty
  file. "Five empty text files" is met by five files of nought bytes; a report
  is not.
- If the deliverable names a quantity — ten offers, five suppliers — and the
  evidence shows fewer, it is not met. Say how many there actually are.
- "Sent to the owner" is met only if a step reports actually sending it.
- An empty or nearly empty file is not a document, unless an empty file is
  precisely what was asked for.

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

// A deliverable that names a file, by extension ("summary.pdf") or by form
// ("a PDF", "the document"). "The tests pass" and "the browser restarted"
// name none — for those, producing no file is the correct outcome.
// Either a name with an extension (summary.pdf), or a generic noun led by a
// determiner (a PDF, the document, into an image). The determiner is what
// separates "a file" — an owed artifact — from "a list of file names", where
// "file" only modifies "names" and nothing is owed. Matching the bare word was
// enough to categorize a console-listing task as coding and then fail it for
// producing no file it never owed.
const NAMES_A_FILE =
  /[-\w]+\.(pdf|html?|txt|md|docx?|xlsx?|pptx?|csv|json|png|jpe?g|gif|zip)\b|\b(?:an?|the|one|each|new|another|its?|my|into an?|as an?)\s+(file|document|pdf|spreadsheet|presentation|screenshot|image|photo|picture)\b/i;

// What "finished" has to look like depends on the kind of mission.
//
// "Restart the browser" ends with zero files and is done; "summarise the
// mailbox as a PDF" with zero files is a failure. The same empty artifacts
// list means opposite things, so the cheap checks below judge against the
// mission's category rather than against the deliverables alone.
export const CATEGORIES = ['coding', 'research', 'browser', 'operation'];

// Deliverables that describe a document written up from gathered material,
// rather than something built. Tested before the file check, because "a PDF
// report" names a file too — but what it owes is research, not code.
const REPORTISH =
  /\b(report|summary|summarise|summarize|document|write-?up|overview|digest|briefing|pdf|slides?|presentation)/i;

// The plan may say what kind of mission this is; when it does not, the shape
// of the plan says it instead. Pure, so the inference is testable on its own.
export function categorize(mission = {}) {
  const explicit = mission.category || mission.understanding?.category;
  if (explicit && CATEGORIES.includes(explicit)) return explicit;

  const steps = Array.isArray(mission.steps) ? mission.steps : [];
  const kinds = new Set(steps.map((s) => s && s.kind).filter(Boolean));
  const deliverables = mission.understanding?.deliverables || [];

  // Gathering material and writing it up.
  if (kinds.has('research') || kinds.has('compose') || deliverables.some((d) => REPORTISH.test(d))) return 'research';
  // Building something: files are owed, or a coding tool is doing the building.
  if (kinds.has('delegate') || deliverables.some((d) => NAMES_A_FILE.test(d))) return 'coding';
  // The machine's state is the deliverable.
  if (kinds.has('web') || kinds.has('computer') || kinds.has('inspect')) return 'browser';
  // Commands and nothing else: "restart the browser", "run the tests".
  return 'operation';
}

// The obvious failures, caught without asking a model. These are cheap, certain,
// and they are the ones that actually happened.
// "Create five empty text files" asks for nought bytes, five times. The empty
// check below is right about reports and wrong about these, and it fails them
// on the one property that was requested — so when the owner asked for an
// empty file, an empty file stops being evidence of a job half done.
const WANTS_EMPTY = /\b(empty|blank|zero[\s-]?byte|0[\s-]?byte)\b/i;

// Renaming, copying, moving or backing up a file inherits its content — it does
// not author any. So a copy of an empty file is an empty file and the job is
// done, even though nobody asked for "empty": the source was empty, and the
// operation faithfully carried that across. The empty check exists to catch a
// report that rendered blank, not a faithful copy of a blank file.
const INHERITS_CONTENT = /\b(renam|copie|copy|moved?|moving|back(?:ing)?[\s-]?up|backup|duplicat)\w*/i;

// Operations that leave nothing behind in the workspace: a delete removes the
// file, a move carries it elsewhere. Either way an empty artifact list is the
// correct outcome, not evidence that nothing happened — so the "no file was
// produced" complaint must not fire on them.
const LEAVES_NOTHING = /\b(delet|remov|eras|purg|moved?|moving)\w*/i;

// A pure file operation — copy, rename, move, delete — proven by its own
// command check needs no second opinion. The model judge earns its keep on
// authored content: is this the right subject, is it a placeholder, does the
// count fall short. Turned loose on a faithful copy of an empty file it does
// harm — it called file3_backup.txt "not an exact copy of file3.txt" because
// the evidence it was shown could not tell it the source was empty too. When
// every step is a shell command that passed its own verify, and every
// deliverable describes carrying content across or removing it rather than
// writing any, the commands have already said so.
export function provenByCommands(mission = {}) {
  const steps = Array.isArray(mission.steps) ? mission.steps : [];
  if (!steps.length) return false;
  const allVerifiedShell = steps.every((s) => s && s.kind === 'shell' && s.verify && s.status === 'ok');
  const deliverables = mission.understanding?.deliverables || [];
  const allOperations =
    deliverables.length > 0 && deliverables.every((d) => INHERITS_CONTENT.test(d) || LEAVES_NOTHING.test(d));
  return allVerifiedShell && allOperations;
}

export function obviousShortfall(artifacts, deliverables = [], { category = null, steps = [] } = {}) {
  const emptyIsWhatWasAsked =
    deliverables.some((d) => WANTS_EMPTY.test(d)) || deliverables.some((d) => INHERITS_CONTENT.test(d));
  if (!artifacts.length) {
    // An operation mission owes commands, not files. Every step already ran
    // and was verified by its exit code, so "restart the browser" ending with
    // nothing on disk is the correct outcome — it was being reported failed
    // for producing no file it never owed.
    if (category === 'operation') return null;
    // A browser mission owes a state, not a file — but the state must have
    // been proven by a check, not asserted by a step that merely ran.
    if (category === 'browser') {
      const proven = steps.some((s) => s.verify && s.status === 'ok');
      return steps.length && !proven ? 'the browser was driven, but the state it reached was never verified' : null;
    }
    // A delete or a move-away owes no file in the workspace — the file was
    // removed, or carried elsewhere. "delete file5.txt" and "move file4.txt to
    // Documents" name a file, so the check below would demand one back and fail
    // a job that did exactly what was asked. The verb settles it.
    if (deliverables.some((d) => LEAVES_NOTHING.test(d))) return null;
    // Only a failure when a file was actually owed. Judged against the
    // deliverables, not the step count: "run the tests" and "restart the
    // browser" produce no file, and were being reported failed for it.
    return deliverables.some((d) => NAMES_A_FILE.test(d)) ? 'no file was produced at all' : null;
  }
  for (const file of artifacts) {
    // Existence first, and for every kind of file. Checking it only while
    // reading text meant a missing PDF — the most likely thing to be missing,
    // since it is usually the deliverable — went unnoticed.
    if (!fs.existsSync(file)) return `${path.basename(file)} was reported but is not on disk`;
    if (fs.statSync(file).size === 0 && !emptyIsWhatWasAsked) return `${path.basename(file)} is empty`;

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
