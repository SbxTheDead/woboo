// Reading a PDF without a dependency.
//
// The text lives in content streams, usually deflated, and Node's zlib can
// unpack them. The catch is that a PDF embedding a subset font does not store
// letters at all — it stores glyph indices — so pulling the strings out raw
// gives a resume as a page of control codes. The ToUnicode CMap is the file
// telling you what those codes stand for, and reading it is the difference
// between a document and noise.
//
// Approximate on purpose: fonts are merged rather than tracked per text run,
// which needs following the Tf operator through the stream. Some letters come
// out substituted -- "CoUpter Science BacSelor" for "Computer Science
// Bachelor". Legible, and a model reads through it, but not right.

import zlib from 'node:zlib';

// Every stream in the file, inflated where it will inflate.
function* streams(bytes) {
  let at = 0;
  for (;;) {
    const start = bytes.indexOf('stream', at);
    if (start < 0) return;
    const from = start + (bytes[start + 6] === 0x0d ? 8 : 7);
    const end = bytes.indexOf('endstream', from);
    if (end < 0) return;
    at = end + 9;
    const chunk = bytes.subarray(from, end);
    try {
      yield zlib.inflateSync(chunk).toString('latin1');
    } catch {
      yield chunk.toString('latin1');
    }
  }
}

// What a font's internal glyph codes actually mean.
//
// A PDF that embeds a subset font does not store letters, it stores glyph
// indices — so pulling the strings out raw gave a résumé as 1,368 characters of
// control codes. The ToUnicode CMap is the file telling you what those codes
// stand for, and reading it is the difference between a document and noise.
// Every font's map, kept apart.
//
// Merging them was the mistake. A document has several fonts, the same code
// means something different in each, and blending them let a decorative font
// overwrite the body text — a résumé came back reading "CoUpter Science
// BacSelor". Kept separate, the right one can be found by trying each.
function toUnicodeMaps(bytes) {
  const maps = [];
  for (const text of streams(bytes)) {
    if (!text.includes('beginbfchar') && !text.includes('beginbfrange')) continue;
    const map = new Map();

    for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const [, from, to] of block.matchAll(/<([0-9a-f]{2,8})>\s*<([0-9a-f]{2,32})>/gi)) {
        map.set(parseInt(from, 16), fromHexUtf16(to));
      }
    }
    for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const [, lo, hi, dst] of block.matchAll(/<([0-9a-f]{2,8})>\s*<([0-9a-f]{2,8})>\s*<([0-9a-f]{2,32})>/gi)) {
        const start = parseInt(lo, 16);
        const end = parseInt(hi, 16);
        const base = parseInt(dst.slice(0, 4), 16);
        for (let c = start; c <= end && c - start < 512; c += 1) map.set(c, String.fromCharCode(base + (c - start)));
      }
    }
    if (map.size) maps.push(map);
  }
  return maps;
}

// How much like real prose a decoding looks.
//
// Which font a run of text uses is recorded in the content stream, and
// following that properly means resolving font resources through the object
// table. This reaches the same answer far more cheaply: decode with each map
// and keep whichever produces something a person could read. A wrong map yields
// letter salad, and letter salad does not contain the word "the".
const COMMON = /\b(the|and|of|to|in|for|with|at|on|is|as|by|from|are|an)\b/gi;

function readability(text) {
  const letters = text.match(/[A-Za-z]/g) || [];
  if (letters.length < 20) return 0;
  const words = (text.match(COMMON) || []).length;
  const vowels = (text.match(/[aeiouAEIOU]/g) || []).length / letters.length;
  // English runs around 38% vowels among its letters. Letter salad does not.
  return (letters.length / text.length) * 2 + words * 0.4 - Math.abs(vowels - 0.38) * 5;
}

function fromHexUtf16(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

// The raw strings from every text-showing operator, before any decoding.
function shownStrings(bytes) {
  const runs = [];
  for (const text of streams(bytes)) {
    if (!/T[Jj]/.test(text)) continue;
    for (const [, body] of text.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      runs.push(body.replace(/\\([nrt()\\])/g, (m, c) => ({ n: '\n', r: '', t: ' ' })[c] ?? c));
    }
    if (runs.length > 40_000) break;
  }
  return runs;
}

// Each glyph is often its own show-operator, so joining with spaces spelled
// everything o u t l i k e t h i s. Join as written and let the file's own
// space glyphs do the separating.
const tidy = (parts) =>
  parts
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:)])/g, '$1')
    .trim();

export function pdfToText(bytes) {
  const runs = shownStrings(bytes);
  if (!runs.length) return '';

  const maps = toUnicodeMaps(bytes);
  if (!maps.length) return tidy(runs);

  // One combined map, with the biggest font winning any disagreement.
  //
  // Decoding everything with a single font's map drops every glyph belonging to
  // the others, which cost whole letters — "Compter Science" for "Computer
  // Science". Merging covers them all, and the font with the most glyphs is the
  // one the body text is set in, so its reading is the one to trust where two
  // fonts claim the same code.
  const merged = new Map();
  for (const map of [...maps].sort((a, b) => a.size - b.size)) {
    for (const [code, ch] of map) merged.set(code, ch);
  }

  const text = tidy(
    runs.map((run) => {
      // A subset font addresses its glyphs two bytes at a time.
      //
      // Reading each run both ways and keeping whichever recovered more
      // characters was tried and is worse: it recovers a few real letters and
      // appends a tail of CJK glyphs from runs that were never single-byte.
      // More characters is not the same as more text.
      let piece = '';
      for (let i = 0; i + 1 < run.length; i += 2) {
        piece += merged.get((run.charCodeAt(i) << 8) | run.charCodeAt(i + 1)) ?? '';
      }
      return piece;
    }),
  );

  // Nonsense means the document is probably scanned images rather than text.
  // Say nothing rather than hand back garbage that reads like content — the
  // caller can act on "no readable text", but not on letter salad.
  return readability(text) > 0.5 ? text : '';
}
