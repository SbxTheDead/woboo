// Research, as a loop rather than a list of steps.
//
// The old shape was fixed at planning time: two URLs chosen before a word had
// been read, fetched, printed. A person does not work that way. They search,
// skim, judge, read, notice what is still missing, and go looking again — and
// only then write. The gap between "what I have" and "what I was asked" is the
// engine, and it cannot exist in a plan drawn up in advance.
//
//   queries → search → judge → read → what is still missing? ──┐
//        ↑                                                     │
//        └──────────────── another round ──────────────────────┘
//                              ↓
//                    draft → critique → revise → render

import path from 'node:path';
import fs from 'node:fs';
import { record } from './journal.mjs';
import { setFace } from './face.mjs';
import { assertLive } from './guard.mjs';
import * as sources from './sources.mjs';
import * as critic from './critic.mjs';
import { render, toPdf } from './document.mjs';

const PLANNER = `You direct a researcher. Given a question, you decide what to go and find out.

Write search queries a person would actually type. Cover the distinct facets of
the question rather than rephrasing it five times: for "research elephants" that
means biology, social behaviour, range, population figures, threats — not
"elephants", "about elephants", "elephant info".

Write queries that surface PRIMARY sources, not blog summaries of them. A plain
topic query returns tourism pages and content farms. Aim at the organisations
and documents that hold the actual data:
  - name the body that publishes it: "IUCN Red List African elephant assessment",
    "CITES elephant trade report", "Our World in Data elephant population"
  - ask for the artefact: "peer reviewed study", "census", "dataset", "PDF report"
  - use site: when you know where it lives — site:iucnredlist.org, site:nature.com
  - include a year for anything that changes: "2024 population estimate"
A query that would return a listicle is a wasted query.`;

const GAP_SCHEMA = {
  type: 'object',
  properties: {
    covered: { type: 'array', description: 'Facets of the question the material already answers.', items: { type: 'string' } },
    missing: { type: 'array', description: 'Facets still unanswered. Empty if the material is sufficient.', items: { type: 'string' } },
    queries: {
      type: 'array',
      description: 'Up to 3 further search queries that would close those gaps. Empty if nothing is missing.',
      items: { type: 'string' },
    },
    enough: { type: 'boolean', description: 'True when the material can answer the question properly.' },
  },
  required: ['covered', 'missing', 'queries', 'enough'],
  additionalProperties: false,
};

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A title for the finished document.' },
    standfirst: { type: 'string', description: 'One sentence saying what the document covers.' },
    queries: { type: 'array', description: '3 to 5 search queries covering distinct facets.', items: { type: 'string' } },
  },
  required: ['title', 'standfirst', 'queries'],
  additionalProperties: false,
};

const WRITER = `You are writing a researched document for the person who commissioned it.

You are given numbered sources. Write from them, in your own words.

- Cite every factual claim with the source it came from, as <span class="cite">[3]</span>
  immediately after the claim. A number, date or name with no citation is a defect.
- Never state a fact that is not in the sources. If the sources disagree, say so
  and give both. If something was not found, say that plainly rather than
  filling the space.
- Structure it for a reader in a hurry: open with a short "Key findings" list in
  <div class="keypoints"><h3>Key findings</h3><ul>…</ul></div>, then headed
  sections in a sensible order.
- Prose, not bullet soup. Lists only where the content is genuinely a list.
- No padding, no restating the brief, no empty conclusion.

Output ONLY the document body: <div class="keypoints">…</div> followed by <h2>
sections. No <html>, <head>, <body> or <style> — those are supplied. Do not write
a Sources list; that is generated for you.`;

export async function investigate({
  question,
  workspace,
  rounds = 2,
  perQuery = 5,
  ask,
  write,
  onProgress,
} = {}) {
  const say = (message, level = 'info') => {
    record('research', message, { level });
    if (onProgress) onProgress(message);
  };

  // ── what to look for ────────────────────────────────────────────────────
  setFace('thinking', 'working out what to look for');
  // Naming the facets of a question is recall, not deliberation — thinking mode
  // roughly doubles the latency here and changes the queries not at all. The gap
  // audit below keeps it, because deciding what is missing is a judgement.
  const opening = await ask({
    system: PLANNER,
    prompt: `The question:\n${question}\n\nDecide the title, a one-sentence standfirst, and the opening search queries.`,
    schema: QUERY_SCHEMA,
    name: 'queries',
    think: false,
  });
  say(`researching "${opening.title}" — ${opening.queries.length} opening queries`);

  const gathered = [];
  const seenHosts = new Set();
  let queries = opening.queries;

  for (let round = 1; round <= rounds && queries.length; round += 1) {
    assertLive('research');
    setFace('working', `round ${round}: searching`);

    // ── search and judge ──────────────────────────────────────────────────
    // Four searches at once rather than four in a row. They do not depend on
    // each other, so waiting for each in turn was pure idle time.
    const batches = await Promise.all(
      queries.slice(0, 4).map((query) => sources.search(query, { limit: perQuery }).catch(() => [])),
    );
    const candidates = [];
    for (const hits of batches) {
      for (const hit of hits) {
        if (seenHosts.has(hit.host)) continue;
        candidates.push(hit);
      }
    }
    // Read the most authoritative first, so a budget spent early is spent well.
    candidates.sort((a, b) => b.authority - a.authority);
    say(`round ${round}: ${candidates.length} candidate source(s)`);

    // ── read ──────────────────────────────────────────────────────────────
    // Keep going until enough have actually been read, rather than trying a
    // fixed few and giving up. The most authoritative sources are often the
    // least fetchable — a government PDF or a site that blocks robots — so a
    // run that only tried the top of the list could come back empty while a
    // dozen perfectly good pages sat below it.
    // Fetch a batch at a time rather than one after another. A slow or dead
    // source used to hold up every source behind it; now the batch is only as
    // slow as its slowest member, and the unreadable ones cost nothing.
    const queue = candidates.filter((c) => !seenHosts.has(c.host)).slice(0, 12);
    let readThisRound = 0;

    for (let at = 0; at < queue.length && readThisRound < 4; at += 4) {
      assertLive('research');
      const batch = queue.slice(at, at + 4);
      const fetched = await Promise.all(batch.map((c) => sources.fetchSource(c).catch(() => null)));

      for (const source of fetched) {
        if (!source || readThisRound >= 4) continue;
        if (seenHosts.has(source.host)) continue;
        seenHosts.add(source.host);

        const picked = sources.selectPassages(source.text, `${question} ${opening.standfirst}`);
        if (picked.chars < 400) continue;
        gathered.push({ ...source, text: picked.text, kept: picked.kept, of: picked.of });
        readThisRound += 1;
        say(`  read ${source.host} — kept ${picked.kept}/${picked.of} passages (${Math.round(picked.chars / 1000)}k)`);
      }
    }
    if (!readThisRound) say(`round ${round}: ${queue.length} source(s) tried, none readable`, 'warn');

    if (!gathered.length) {
      say('nothing readable found', 'warn');
      break;
    }

    // ── what is still missing? ────────────────────────────────────────────
    if (round === rounds) break;
    setFace('thinking', 'checking what is still missing');
    const assessment = await ask({
      system: 'You audit research material for gaps. Be specific and be honest when it is sufficient.',
      prompt:
        `The question:\n${question}\n\nWhat has been gathered so far:\n\n` +
        gathered.map((g, i) => `--- ${i + 1}. ${g.host} ---\n${g.text.slice(0, 4000)}`).join('\n\n') +
        '\n\nWhat does this already answer, and what is still missing?',
      schema: GAP_SCHEMA,
      name: 'gaps',
    });

    if (assessment.enough || !assessment.queries.length) {
      say(`material is sufficient after round ${round}`);
      break;
    }
    say(`still missing: ${assessment.missing.join('; ')}`);
    queries = assessment.queries;
  }

  if (!gathered.length) {
    return { ok: false, out: 'found nothing readable on that question' };
  }

  // ── write ───────────────────────────────────────────────────────────────
  setFace('working', 'writing it up');
  const material = gathered
    .map((g, i) => `--- SOURCE ${i + 1} (${g.host}): ${g.title} ---\n${g.text}`)
    .join('\n\n');

  let body = await write({
    system: WRITER,
    prompt: `The brief:\n${question}\n\nTitle: ${opening.title}\n\nThe sources:\n\n${material}`,
    maxTokens: 16_000,
  });
  body = clean(body);
  say(`drafted ${Math.round(body.length / 1000)}k chars from ${gathered.length} sources`);

  // ── critique and revise ─────────────────────────────────────────────────
  // Critique, revise, and critique the revision. Reporting the first verdict
  // after having fixed it would describe a document that no longer exists — and
  // a revision nobody rechecks is just a second guess.
  setFace('testing', 'checking its own work');
  let report = await critic.critique({ brief: question, draft: body, sources: gathered, ask });

  for (let pass = 1; pass <= 2 && report.verdict !== 'good'; pass += 1) {
    setFace('confused', `revising (pass ${pass})`);
    const notes = critic.asRevisionNotes(report);
    say(`revising, pass ${pass}: ${report.verdict}`, 'warn');

    const revised = clean(
      await write({
        system: WRITER,
        prompt:
          `The brief:\n${question}\n\nYour draft came back from an editor with corrections. ` +
          `Produce the corrected document — keep what was right, fix only what is listed.\n\n` +
          `EDITOR'S NOTES:\n${notes}\n\nYOUR DRAFT:\n${body}\n\nTHE SOURCES:\n\n${material}`,
        maxTokens: 16_000,
      }),
    );
    // A revision that came back empty or mangled is not an improvement.
    if (revised.length < 500) {
      say('the revision came back unusable; keeping the previous draft', 'warn');
      break;
    }
    body = revised;

    setFace('testing', 're-checking');
    report = await critic.critique({ brief: question, draft: body, sources: gathered, ask });
    if (report.verdict === 'good') say(`clean after pass ${pass}`);
  }

  // ── render ──────────────────────────────────────────────────────────────
  setFace('working', 'making the PDF');
  const slug = opening.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'report';
  const htmlFile = path.resolve(workspace, `${slug}.html`);
  const pdfFile = path.resolve(workspace, `${slug}.pdf`);

  fs.writeFileSync(
    htmlFile,
    render({
      title: opening.title,
      standfirst: opening.standfirst,
      body,
      sources: gathered,
      meta: `${gathered.length} sources · researched by Woboo`,
    }),
    'utf8',
  );

  const pdf = await toPdf(htmlFile, pdfFile);
  if (!pdf.ok) {
    return { ok: true, out: `wrote ${htmlFile}, but the PDF failed: ${pdf.error}`, file: htmlFile, report };
  }

  return {
    ok: true,
    out:
      `${opening.title} — ${pdf.pages} pages from ${gathered.length} sources, ` +
      `editor's verdict: ${report.verdict}. ${pdfFile}`,
    file: pdfFile,
    html: htmlFile,
    sources: gathered.length,
    report,
  };
}

// Models like to wrap a body in a fence or a full document even when told not to.
function clean(text) {
  let out = String(text || '')
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const body = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (body) out = body[1].trim();
  return out
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[\s\S]*?<\/h1>/i, '')
    .trim();
}
