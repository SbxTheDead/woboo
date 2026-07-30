// How Woboo's documents look, and how they become PDFs.
//
// A PDF is a printed object, not a web page, and browsers default to neither.
// Left alone you get 11pt Times at 1cm margins with headings orphaned at the
// foot of a page — technically a document, obviously nobody's work. This is the
// house style: one stylesheet, applied to everything Woboo writes, so the model
// only has to supply structure and never has to invent typography.

import fs from 'node:fs';
import path from 'node:path';
import { record } from './journal.mjs';
import { script } from './ps.mjs';
import { edgePath } from './toolbox.mjs';

// Measured in the units print actually uses. The scale is a fourth (1.333) so
// heading sizes relate to each other rather than being picked one at a time.
export const HOUSE_CSS = `
  @page {
    size: A4;
    margin: 22mm 20mm 20mm;
  }
  :root {
    --ink: #16130F;
    --soft: #4A423A;
    --rule: #D8D0C4;
    --accent: #C4552B;
    --paper: #FFFFFF;
  }
  * { box-sizing: border-box; }
  html { font-size: 11pt; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: "Georgia", "Cambria", "Times New Roman", serif;
    line-height: 1.55; text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }

  /* ── title block ─────────────────────────────────────────────────────── */
  .doc-title {
    border-bottom: 2px solid var(--accent);
    padding-bottom: 10mm; margin-bottom: 9mm;
  }
  .doc-title h1 {
    font-size: 2.15rem; line-height: 1.12; margin: 0 0 3mm;
    letter-spacing: -.015em; font-weight: 700;
  }
  .doc-title .standfirst {
    font-size: 1.05rem; color: var(--soft); margin: 0; max-width: 34em;
    font-style: italic;
  }
  .doc-title .meta {
    margin-top: 5mm; font-family: ui-monospace, "Consolas", monospace;
    font-size: .72rem; letter-spacing: .08em; text-transform: uppercase;
    color: var(--soft);
  }

  /* ── headings ────────────────────────────────────────────────────────── */
  h2, h3, h4 { font-weight: 700; line-height: 1.2; }
  h2 {
    font-size: 1.5rem; margin: 9mm 0 3mm; padding-bottom: 1.5mm;
    border-bottom: 1px solid var(--rule); letter-spacing: -.01em;
  }
  h3 { font-size: 1.14rem; margin: 6mm 0 2mm; color: var(--soft); }
  h4 { font-size: 1rem; margin: 5mm 0 1.5mm; }
  /* A heading stranded at the foot of a page is the classic tell. */
  h1, h2, h3, h4 { break-after: avoid-page; page-break-after: avoid; }

  p { margin: 0 0 3.4mm; orphans: 3; widows: 3; }
  p + p { text-indent: 0; }
  strong { font-weight: 700; }

  ul, ol { margin: 0 0 4mm; padding-left: 6mm; }
  li { margin-bottom: 1.6mm; }
  li::marker { color: var(--accent); }

  blockquote {
    margin: 4mm 0; padding: 0 0 0 5mm;
    border-left: 2px solid var(--accent); color: var(--soft); font-style: italic;
  }

  table {
    width: 100%; border-collapse: collapse; margin: 4mm 0; font-size: .92rem;
    break-inside: avoid-page; page-break-inside: avoid;
  }
  th, td { text-align: left; padding: 2mm 3mm; border-bottom: 1px solid var(--rule); }
  th { font-weight: 700; border-bottom: 1.5px solid var(--ink); }
  tbody tr:nth-child(even) { background: #FAF7F2; }

  figure { margin: 5mm 0; break-inside: avoid-page; }
  figcaption { font-size: .82rem; color: var(--soft); margin-top: 1.5mm; }

  code, .mono { font-family: ui-monospace, "Consolas", monospace; font-size: .88em; }

  /* ── citations ───────────────────────────────────────────────────────── */
  /* Superscript markers that stay readable at print size. */
  .cite, sup a {
    font-size: .68em; vertical-align: super; line-height: 0;
    color: var(--accent); text-decoration: none; font-weight: 700;
    font-family: ui-monospace, monospace;
  }
  .sources { margin-top: 10mm; padding-top: 5mm; border-top: 1px solid var(--rule); }
  .sources h2 { border: none; margin-top: 0; font-size: 1.15rem; }
  .sources ol { padding-left: 7mm; font-size: .86rem; color: var(--soft); }
  .sources li { margin-bottom: 2.2mm; }
  .sources .host {
    font-family: ui-monospace, monospace; font-size: .95em; color: var(--accent);
  }
  .sources a { color: var(--soft); text-decoration: none; word-break: break-all; }

  /* A findings box, for the summary a reader wants first. */
  .keypoints {
    background: #FBF7F1; border: 1px solid var(--rule); border-left: 3px solid var(--accent);
    padding: 4mm 5mm; margin: 6mm 0; break-inside: avoid-page;
  }
  .keypoints h3 { margin: 0 0 2mm; color: var(--ink); font-size: 1rem; }
  .keypoints ul { margin: 0; }

  .note { color: var(--soft); font-size: .9rem; }
`;

// Wrap a body the model wrote in the house chrome. The model supplies structure
// and words; it never has to think about margins.
export function render({ title, standfirst = '', body, sources = [], meta = '' }) {
  const list = sources.length
    ? `<section class="sources"><h2>Sources</h2><ol>${sources
        .map(
          (s) =>
            `<li><span class="host">${escapeHtml(s.host || '')}</span> — ${escapeHtml(
              s.title || s.url,
            )}<br><a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a></li>`,
        )
        .join('')}</ol></section>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${HOUSE_CSS}</style>
</head><body>
<header class="doc-title">
  <h1>${escapeHtml(title)}</h1>
  ${standfirst ? `<p class="standfirst">${escapeHtml(standfirst)}</p>` : ''}
  ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
</header>
${body}
${list}
</body></html>`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// HTML in, PDF out. Edge is on every Windows machine and needs nothing
// installed, which is why it beats pandoc and wkhtmltopdf here.
export async function toPdf(htmlFile, pdfFile) {
  const edge = edgePath();
  if (!edge) return { ok: false, error: 'Microsoft Edge not found — cannot render a PDF' };

  const source = `& '${edge.replace(/'/g, "''")}' --headless --disable-gpu --no-pdf-header-footer ` +
    `--print-to-pdf='${pdfFile.replace(/'/g, "''")}' '${htmlFile.replace(/'/g, "''")}' 2>&1 | Out-Null
Start-Sleep -Milliseconds 900
if (Test-Path '${pdfFile.replace(/'/g, "''")}') { Write-Output 'made' } else { Write-Output 'missing' }`;

  const result = await script(source, { action: 'render pdf', timeout: 90_000 });
  if (!fs.existsSync(pdfFile)) {
    return { ok: false, error: `Edge did not produce a PDF (${result.out || 'no output'})` };
  }

  const bytes = fs.readFileSync(pdfFile);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, error: 'the file Edge produced is not a PDF' };
  }
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  record('document', `rendered ${path.basename(pdfFile)} — ${pages} pages, ${Math.round(bytes.length / 1024)}KB`, {
    level: 'ok',
  });
  return { ok: true, pages, bytes: bytes.length, file: pdfFile };
}
