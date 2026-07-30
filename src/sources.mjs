// Finding things out: search, fetch, and — the part that actually matters —
// deciding which bits of a page are worth reading.
//
// The old scribe took the first 24,000 characters of every source. On a
// Wikipedia article that is the lead and early sections, so the conservation
// figures at the bottom were silently dropped and the report came out vague. A
// person skims for the relevant part. This scores passages against the question
// and reads those, which is the same idea with worse taste.

import { loadSecrets } from './config.mjs';
import { record } from './journal.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Woboo/1.0';

// Domains that never repay the fetch: aggregators, walled gardens, link farms.
const SKIP = /(pinterest|quora|facebook|instagram|tiktok|twitter|x\.com|reddit\.com\/r\/\w+\/comments|youtube|amazon\.|ebay\.)/i;

// Pages that exist to sell you something. A safari lodge writes about elephants
// and lands a .org, but it is marketing copy — and a researcher who cited a
// hotel would be laughed at. Rejected outright rather than ranked low, because
// a bad source read is a bad source quoted.
const COMMERCIAL =
  /(lodge|safari|resort|hotel|tour|travel|holiday|booking|shop|store|sanctuary-visit|adopt|donate-now|zoo-?tickets|elephantsands|elephant-world|tripadvisor|expedia|getyourguide|viator)/i;

// Content farms and SEO chaff: pages assembled from other pages, with no author,
// no citations and nothing original.
const FARM =
  /(animalcorner|biologydictionary|factsking|funfacts|a-z-animals|kidzone|softschools|studocu|coursehero|scribd|slideshare|wikihow|answers\.com|byjus|vedantu|toppr|geeksforgeeks|academicpath|elephanttag|seethewild|nexuswild)/i;

// A rough sense of who to believe, used to order what gets read first — and, at
// zero, to refuse it. Not a truth oracle, just the ordering a researcher applies
// without thinking about it.
export function authority(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  })();

  if (COMMERCIAL.test(host) || FARM.test(host)) return 0;

  // Primary and peer-reviewed.
  if (/nature\.com|science\.org|sciencedirect|springer|wiley|jstor|ncbi\.nlm|pubmed|pnas\.org|cell\.com|plos|biorxiv|royalsocietypublishing|frontiersin/i.test(host)) return 6;
  if (/\.(gov|int)$|\.gov\.|iucnredlist|iucn\.org|unesco|un\.org|who\.int|worldbank|fao\.org|cites\.org/i.test(host)) return 6;
  if (/\.edu$|\.ac\.[a-z]{2}$|\.edu\./.test(host)) return 5;

  // Serious institutions and reference works.
  if (/ourworldindata|britannica|smithsonian|nhm\.ac|amnh\.org|si\.edu|zsl\.org|wcs\.org|worldwildlife|wwf\.|panda\.org|savetheelephants|elephantvoices/i.test(host)) return 5;
  if (/nationalgeographic|bbc\.|reuters|apnews|nytimes|guardian|economist|scientificamerican|newscientist/i.test(host)) return 4;
  if (/wikipedia\.org/i.test(host)) return 3;

  // An unknown .org is not evidence of anything on its own.
  if (/\.org$/.test(host)) return 2;
  return 1;
}

// Tavily is a search API built for agents: it ranks by relevance to the query
// and hands back the extracted article text. That second part matters as much as
// the first — scraping got 403s from worldwildlife.org and timed out on IUCN
// PDFs, and a source that cannot be fetched is a source that cannot be cited.
async function searchTavily(query, limit) {
  const key = loadSecrets().tavilyApiKey || process.env.TAVILY_API_KEY;
  if (!key) return null;

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'advanced',
        max_results: Math.max(limit, 8),
        include_raw_content: true,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      record('research', `Tavily ${response.status}; falling back to open search`, { level: 'warn' });
      return null;
    }

    const body = await response.json();
    const seen = new Set();
    const hits = [];
    for (const result of body.results || []) {
      let host;
      try {
        host = new URL(result.url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      if (seen.has(host) || SKIP.test(result.url)) continue;
      const rank = authority(result.url);
      if (rank === 0) continue;
      seen.add(host);
      hits.push({
        url: result.url,
        host,
        authority: rank,
        query,
        title: result.title || '',
        // Already extracted — no second request, and no 403 to lose it to.
        content: result.raw_content || result.content || '',
        relevance: result.score ?? 0,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  } catch (err) {
    record('research', `Tavily failed (${err.message}); falling back to open search`, { level: 'warn' });
    return null;
  }
}

export async function search(query, { limit = 8 } = {}) {
  // Prefer the real search API; keep the keyless path so Woboo still works
  // without one.
  const viaApi = await searchTavily(query, limit);
  if (viaApi && viaApi.length) return viaApi;

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
      const rank = authority(link);
      // Zero means marketing or a content farm. Not worth reading, so not worth
      // returning — a low rank would still get read once better sources fail.
      if (rank === 0) continue;
      seen.add(host);
      hits.push({ url: link, host, authority: rank, query });
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
  // The search API already extracted this one. Skipping the round trip is the
  // difference between reading a source and losing it to a 403.
  if (hit.content && hit.content.length > 600) {
    const text = /<[a-z][\s>]/i.test(hit.content) ? htmlToText(hit.content) : hit.content;
    if (text.length > 600) {
      return { ...hit, title: hit.title || text.split('\n')[0].slice(0, 120), text, length: text.length };
    }
  }

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
