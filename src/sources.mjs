// Finding things out: search, fetch, and — the part that actually matters —
// deciding which bits of a page are worth reading.
//
// The old scribe took the first 24,000 characters of every source. On a
// Wikipedia article that is the lead and early sections, so the conservation
// figures at the bottom were silently dropped and the report came out vague. A
// person skims for the relevant part. This scores passages against the question
// and reads those, which is the same idea with worse taste.

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

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

// A name list can only ever block the farms someone has already met. These are
// the shapes: "top10anything", "best-x-reviews", "x-facts-2024". Kept narrow on
// purpose — it has to reject listicles without catching bestpractices.org.
const FARM_SHAPE = /(^|[.-])(top-?\d+|\d+best|best[a-z-]{0,12}(reviews?|picks?)|[a-z-]*listicle)/i;

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

  if (COMMERCIAL.test(host) || FARM.test(host) || FARM_SHAPE.test(host)) return 0;

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

// ── SSRF screen ─────────────────────────────────────────────────────────────
// Search results are arbitrary URLs chosen by somebody else's page. Fetching
// them unchecked lets a result aim Woboo's network access at the machine
// itself — the dashboard on 127.0.0.1, the router on 192.168.x, cloud metadata
// on 169.254.169.254. Only a public http(s) target is worth a fetch.
//
// The WHATWG URL parser normalises odd IPv4 spellings (`0x7f.1`, `2130706433`)
// to dotted quads before this ever sees them, so checking the dotted form is
// enough. What this cannot see is a public name whose DNS answers with a
// private address — that check takes a resolver, and lives in resolvesPublicly
// below, right next to the request itself.

function privateIp4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const numbers = parts.map(Number);
  if (!numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return false;
  const [a, b] = numbers;
  return (
    a === 0 || // "this" network
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    a >= 224 // multicast and reserved
  );
}

export function isPublicHost(host) {
  const name = String(host).toLowerCase();
  if (!name || name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.internal') || name.endsWith('.local')) {
    return false;
  }
  // IPv6 literals arrive in brackets. Loopback, "unspecified", link-local
  // (fe80::/10) and unique-local (fc00::/7) are all out.
  const bare = name.replace(/^\[|\]$/g, '');
  if (bare.includes(':')) {
    if (bare === '::1' || bare === '::') return false;
    const first = bare.split(':')[0];
    if (/^fe[89ab]/.test(first) || /^f[cd]/.test(first)) return false;
    // An IPv4-mapped address is judged by the IPv4 it maps to — dotted in a
    // hand-written literal, two hex hextets after WHATWG normalisation.
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    if (dotted) return !privateIp4(dotted[1]);
    const hextets = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
    if (hextets) {
      const high = parseInt(hextets[1], 16);
      const low = parseInt(hextets[2], 16);
      return !privateIp4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return true;
  }
  return !privateIp4(bare);
}

export function isPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isPublicHost(parsed.hostname);
}

// The lexical screen above judges what a URL says; this judges where the name
// actually points. A public-looking host whose DNS answers with 127.0.0.1 or
// 169.254.169.254 is a rebinding attack, so every answer has to pass the same
// rules an IP literal would. Fails closed: an unresolvable name, an empty
// answer, or one private address among public ones all refuse the fetch.
// `lookup` is injectable so the tests can stand in for DNS.
export async function resolvesPublicly(host, lookup = (h) => dns.lookup(h, { all: true, verbatim: true })) {
  let addresses;
  try {
    addresses = await lookup(host);
  } catch {
    return false;
  }
  return Boolean(addresses?.length) && addresses.every(({ address }) => isPublicHost(address));
}

// Fetch an arbitrary, already-screened URL with the resolver check folded in.
// Redirects are followed by hand so each hop gets screened and resolved too —
// undici's automatic following would carry the request to a 127.0.0.1
// Location without either check ever seeing it.
//
// Known gap: undici resolves the name again when it connects, and without a
// custom dispatcher there is no way to hand it the address that was just
// validated. A name whose answer flips private in the instant between check
// and connect can still slip through; closing that window takes an undici
// Agent with a validating lookup, and undici is not a dependency here.
async function fetchScreened(url, { lookup, ...options } = {}) {
  let current = url;
  for (let hop = 0; ; hop++) {
    const host = new URL(current).hostname.replace(/^\[|\]$/g, '');
    if (!isIP(host) && !(await resolvesPublicly(host, lookup))) return null;
    const response = await fetch(current, { ...options, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location || hop >= 5) return null;
    const next = new URL(location, current).href;
    if (!isPublicUrl(next)) return null;
    current = next;
  }
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
      if (seen.has(host) || SKIP.test(result.url) || !isPublicUrl(result.url)) continue;
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
      if (!/^https?:/i.test(link) || SKIP.test(link) || !isPublicUrl(link)) continue;
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
export async function fetchSource(hit, { timeout = 9000, lookup } = {}) {
  // The screen, again, right before the request: a hit can also arrive from
  // somewhere other than search(), and the network is where refusal counts.
  if (!isPublicUrl(hit.url)) return null;

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
    const response = await fetchScreened(hit.url, {
      headers: { 'user-agent': UA },
      signal: controller.signal,
      lookup,
    });
    if (!response?.ok) return null;
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

  // Paragraphs first, then sentences for any paragraph too big to be a block.
  //
  // Splitting only on blank lines assumed every page has them, and plenty do
  // not — a stripped article often arrives as one continuous run of text. That
  // became a single 14,000-character block, which never fit the budget, so it
  // was skipped and the function returned nothing at all. The source had been
  // fetched, ranked and paid for, and then read as empty, silently.
  const MAX_BLOCK = 1400;
  const pieces = [];
  for (const para of text.split(/\n\s*\n/)) {
    if (para.length <= MAX_BLOCK) {
      pieces.push(para);
      continue;
    }
    let sentence = '';
    for (const part of para.split(/(?<=[.!?])\s+/)) {
      if ((sentence + part).length > MAX_BLOCK && sentence) {
        pieces.push(sentence.trim());
        sentence = '';
      }
      // A single sentence longer than a block is rare and still has to go
      // somewhere; hard-split it rather than drop it.
      if (part.length > MAX_BLOCK) {
        for (let i = 0; i < part.length; i += MAX_BLOCK) pieces.push(part.slice(i, i + MAX_BLOCK));
        continue;
      }
      sentence += `${part} `;
    }
    if (sentence.trim()) pieces.push(sentence.trim());
  }

  const blocks = [];
  let current = '';
  for (const piece of pieces) {
    if ((current + piece).length > MAX_BLOCK && current) {
      blocks.push(current.trim());
      current = '';
    }
    current += `${piece}\n\n`;
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
    if (used + item.block.length > budget) {
      // The best passage on the page can be larger than the whole budget, and
      // skipping it left the reader with the second-best — or, when every block
      // was oversized, with nothing. Trim it to fit rather than discard it; half
      // of the right passage beats all of the wrong one.
      const room = budget - used;
      if (!chosen.length && room > 200) {
        chosen.push({ ...item, block: item.block.slice(0, room) });
        used = budget;
      }
      continue;
    }
    chosen.push(item);
    used += item.block.length;
  }
  chosen.sort((a, b) => a.index - b.index);

  // A page that matched nothing is still a page. Returning empty here means the
  // scribe writes as though the source did not exist, which is how a report ends
  // up citing one site out of eight — so hand back the opening instead and say
  // that is what happened.
  if (!chosen.length && text.trim()) {
    const head = text.trim().slice(0, budget);
    return { text: head, kept: 0, of: blocks.length, chars: head.length, fallback: true };
  }

  return {
    text: chosen.map((c) => c.block).join('\n\n'),
    kept: chosen.length,
    of: blocks.length,
    chars: used,
  };
}
