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
function toUnicodeMap(bytes) {
  const map = new Map();

  // A document has several fonts and each has its own map, so the same code
  // means different things in different ones. Merging them blindly let a
  // decorative font's mapping win over the body text's, and a résumé came back
  // reading "In尔tit t e 号f Techn号l号g" — the right words with the wrong
  // glyphs. Without tracking which font is selected mid-stream, the best
  // available tie-break is that a Latin document is made of Latin letters.
  const rank = (ch) => {
    if (!ch) return 0;
    const c = ch.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 3; // plain ASCII
    if (c < 0x250) return 2; // accented Latin
    return 1; // anything else
  };
  const offer = (code, ch) => {
    if (rank(ch) > rank(map.get(code))) map.set(code, ch);
  };

  for (const text of streams(bytes)) {
    if (!text.includes('beginbfchar') && !text.includes('beginbfrange')) continue;

    for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const [, from, to] of block.matchAll(/<([0-9a-f]{2,8})>\s*<([0-9a-f]{2,32})>/gi)) {
        offer(parseInt(from, 16), fromHexUtf16(to));
      }
    }
    for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const [, lo, hi, dst] of block.matchAll(/<([0-9a-f]{2,8})>\s*<([0-9a-f]{2,8})>\s*<([0-9a-f]{2,32})>/gi)) {
        const start = parseInt(lo, 16);
        const end = parseInt(hi, 16);
        const base = parseInt(dst.slice(0, 4), 16);
        for (let c = start; c <= end && c - start < 512; c += 1) offer(c, String.fromCharCode(base + (c - start)));
      }
    }
  }
  return map;
}

function fromHexUtf16(hex) {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

export function pdfToText(bytes) {
  const unicode = toUnicodeMap(bytes);
  const subset = unicode.size > 0;
  const out = [];

  for (const text of streams(bytes)) {
    if (!/T[Jj]/.test(text)) continue;
    for (const [, body] of text.matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      const decoded = body.replace(/\\([nrt()\\])/g, (m, c) => ({ n: '\n', r: '', t: ' ' })[c] ?? c);
      if (!subset) {
        out.push(decoded);
        continue;
      }
      // A subset font addresses its glyphs two bytes at a time.
      let piece = '';
      for (let i = 0; i + 1 < decoded.length; i += 2) {
        piece += unicode.get((decoded.charCodeAt(i) << 8) | decoded.charCodeAt(i + 1)) ?? '';
      }
      out.push(piece);
    }
    if (out.join('').length > 200_000) break;
  }

  // Each glyph is often its own show-operator, so joining with spaces spelled
  // everything o u t l i k e t h i s. Join them as written and let the file's
  // own space glyphs do the separating.
  return out
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:)])/g, '$1')
    .trim();
}
