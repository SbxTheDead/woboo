// Finding things out: search, fetch, and — the part that actually matters —
// deciding which bits of a page are worth reading.
//
// The old scribe took the first 24,000 characters of every source. On a
// Wikipedia article that is the lead and early sections, so the conservation
// figures at the bottom were silently dropped and the report came out vague. A
// person skims for the relevant part. This scores passages against the question
// and reads those, which is the same idea with worse taste.

import { record } from './journal.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Woboo/1.0';

// Domains that never repay the fetch: aggregators, walled gardens, link farms.
const SKIP = /(pinterest|quora|facebook|instagram|tiktok|twitter|x\.com|reddit\.com\/r\/\w+\/comments|youtube|amazon\.|ebay\.)/i;

// A rough sense of who to believe, used to order what gets read first. Not a
// truth oracle — just the ordering a researcher would apply without thinking.
function authority(url) {
  if (/\.(gov|int)(\/|$)/.test(url) || /iucn|unesco|worldbank|who\.int/i.test(url)) return 5;
  if (/\.edu(\/|$)|\.ac\.[a-z]{2}(\/|$)/.test(url)) return 4;
  if (/nature\.com|science\.org|springer|wiley|jstor|ncbi\.nlm|pnas\.org|cell\.com/i.test(url)) return 5;
  if (/wikipedia\.org/i.test(url)) return 3;
  if (/nationalgeographic|britannica|smithsonian|bbc\.|reuters|nytimes|worldwildlife|wwf\./i.test(url)) return 4;
  if (/\.org(\/|$)/.test(url)) return 3;
  return 2;
}

export async function search(query, { limit = 8 } = {}) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA } });
    if (!response.ok) return [];
    const html = await response.text();
    const seen = new Set();
    const hits = [];
    for (const match of html.matchAll(/uddg=([^&"']+)/g)) {
      const link = decodeURIComponent(match[1]);
      if (!/^https?:/i.test(link) || SKIP.test(link)) continue;
      const host = new URL(link).hostname.replace(/^www\./, '');
      // One page per site: ten pages from one domain is not several sources.
      if (seen.has(host)) continue;
      seen.add(host);
      hits.push({ url: link, host, authority: authority(link), query });
      if (hits.length >= limit) break;
    }
    return hits;
  } catch (err) {
    record('research', `search failed for "${query}": ${err.message}`, { level: 'warn' });
    return [];
  }
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside|form|figure)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Short by design: a slow source is not worth a long wait when there are a
// dozen others in the queue.
export async function fetchSource(hit, { timeout = 9000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(hit.url, { headers: { 'user-agent': UA }, signal: controller.signal });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    // A PDF is worth finding but not worth parsing here; the text ones carry.
    if (!/text\/html|text\/plain/i.test(type)) return null;
    const text = htmlToText(await response.text());
    if (text.length < 600) return null;
    const title = (await Promise.resolve(text)).split('\n')[0].slice(0, 120);
    return { ...hit, title, text, length: text.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── reading, rather than truncating ───────────────────────────────────────────

const STOP = new Set(
  ('the a an and or but of to in on for with by from as at is are was were be been it its this that these those ' +
    'what which who whom how why when where all any some more most other into than then them they their there ' +
    'about give me everything write report research using')
    .split(' '),
);

export function keywords(question) {
  return [...new Set(
    String(question)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  )];
}

// Split on paragraph boundaries, score each block against the question, keep the
// best ones in their original order so the prose still reads in sequence.
export function selectPassages(text, question, { budget = 14_000 } = {}) {
  const terms = keywords(question);
  const blocks = [];
  let current = '';
  for (const para of text.split(/\n\s*\n/)) {
    if ((current + para).length > 1400 && current) {
      blocks.push(current.trim());
      current = '';
    }
    current += `${para}\n\n`;
  }
  if (current.trim()) blocks.push(current.trim());

  const scored = blocks.map((block, index) => {
    const lower = block.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const hits = lower.split(term).length - 1;
      if (hits) score += 1 + Math.log(hits);
    }
    // Numbers and years are what makes a passage worth citing.
    if (/\b(19|20)\d{2}\b/.test(block)) score += 1.5;
    if (/\d[\d,.]*\s*(%|km|kg|tons?|tonnes|individuals|elephants|million|billion)/i.test(block)) score += 2;
    // The opening of a page usually says what it is about.
    if (index < 2) score += 1;
    return { block, score, index };
  });

  const chosen = [];
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (item.score <= 0) break;
    if (used + item.block.length > budget) continue;
    chosen.push(item);
    used += item.block.length;
  }
  chosen.sort((a, b) => a.index - b.index);

  return {
    text: chosen.map((c) => c.block).join('\n\n'),
    kept: chosen.length,
    of: blocks.length,
    chars: used,
  };
}
