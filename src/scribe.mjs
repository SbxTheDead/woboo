// The part of Woboo that writes.
//
// Without this, "research elephants and give me a PDF" degenerates into
// downloading a page and printing it: five steps, every one proven by a command,
// and a worthless 42-page dump of somebody else's HTML. The checks were honest.
// The work was not research.
//
// A researcher reads several sources and writes something new. That needs a step
// whose output is prose rather than an exit code — so this takes gathered
// material, hands it to the brain, and writes a real document.

import fs from 'node:fs';
import path from 'node:path';
import { pdfToText as readPdf } from './pdf.mjs';
import { record } from './journal.mjs';

// Source pages are megabytes of markup; models want the words. Deliberately
// crude — this feeds a language model, not a parser, and the model copes with
// imperfect text far better than it copes with 1MB of <div>.
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Wikipedia chrome that is never worth reading.
    .replace(/<(nav|header|footer|aside|table)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Enough of each source to be worth reading, capped so a handful of pages still
// fits in one request.
const PER_SOURCE = 24_000;

export function gather(workspace, patterns) {
  const sources = [];
  for (const entry of patterns) {
    const full = path.isAbsolute(entry) ? entry : path.join(workspace, entry);
    try {
      if (!fs.existsSync(full)) continue;
      const stat = fs.statSync(full);
      const files = stat.isDirectory()
        ? fs.readdirSync(full).map((f) => path.join(full, f))
        : [full];
      for (const file of files) {
        // PDFs count. Skipping them meant a task pointing at a résumé or a
        // report had its one real source silently ignored — and the planner
        // resorted to shelling out to Python to read it, which failed on
        // quoting, on a missing package, and on a path, three attempts running.
        if (!/\.(html?|txt|md|json|pdf)$/i.test(file)) continue;
        const text = /\.pdf$/i.test(file)
          ? readPdf(fs.readFileSync(file))
          : /\.html?$/i.test(file)
            ? htmlToText(fs.readFileSync(file, 'utf8'))
            : fs.readFileSync(file, 'utf8');
        if (text.length < 200) continue;
        sources.push({ file, text: text.slice(0, PER_SOURCE), full: text.length });
      }
    } catch {
      // An unreadable source is not worth failing the whole compose over.
    }
  }
  return sources;
}

const SYSTEM = `You are the writing half of Woboo, producing a document for its owner.

You are given source material that was gathered for you. Write the document the
owner actually asked for — a synthesis in your own words, organised so a person
can use it.

- Structure it: a title, a short opening that says what this covers, then
  headed sections in a sensible order, and a closing summary if it helps.
- Write prose. Use a list only where the content is genuinely a list.
- Draw on every source you were given, and prefer a specific fact with a number
  or a name over a vague sentence.
- Where sources disagree or a figure is uncertain, say so rather than picking
  one silently.
- Never pad. No filler sections, no restating the brief back, no "in conclusion"
  paragraph that adds nothing.
- Do not copy long passages verbatim. If you quote, keep it short and mark it.

Output a complete standalone HTML document and nothing else: start at <!doctype
html> and end at </html>. Include a <style> block — generous margins, a readable
serif for body text, clear heading hierarchy, and a printable page size, because
this becomes a PDF.`;

export async function compose({ instruction, sources, outFile, write }) {
  if (!sources.length) {
    return { ok: false, out: 'nothing to write from — no readable sources were gathered' };
  }

  const material = sources
    .map(
      (s, i) =>
        `--- SOURCE ${i + 1}: ${path.basename(s.file)} (${s.full} chars, showing ${s.text.length}) ---\n${s.text}`,
    )
    .join('\n\n');

  record('scribe', `writing from ${sources.length} source(s), ${Math.round(material.length / 1000)}k chars`, {
    level: 'info',
  });

  const html = await write({
    system: SYSTEM,
    prompt: `What the owner asked for:\n${instruction}\n\nSource material:\n\n${material}`,
    maxTokens: 16_000,
  });

  const body = String(html).replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!/<html/i.test(body)) {
    return { ok: false, out: `the brain did not return an HTML document:\n${body.slice(0, 300)}` };
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, body, 'utf8');
  record('scribe', `wrote ${path.basename(outFile)} (${Math.round(body.length / 1000)}k chars)`, { level: 'ok' });

  return { ok: true, out: `wrote ${outFile} (${body.length} chars) from ${sources.length} sources`, file: outFile };
}
