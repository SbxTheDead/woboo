// Why the research is worth reading: what gets let in.
//
// The first research run cited Wikipedia and nothing else and the owner's
// verdict was "its really bad". Authority ranking is what stops that — a
// content farm and a peer-reviewed journal must not weigh the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, keywords, selectPassages, htmlToText, isPublicUrl, fetchSource } from '../src/sources.mjs';

test('ranks a primary source above an aggregator above an unknown', () => {
  const nasa = authority('https://science.nasa.gov/mission/europa-clipper/');
  const journal = authority('https://www.nature.com/articles/s41586-024-00001-0');
  const wiki = authority('https://en.wikipedia.org/wiki/Europa_Clipper');
  const unknown = authority('https://someblog.example.com/space');

  assert.ok(nasa > wiki, 'a primary source must outrank an encyclopedia summary');
  assert.ok(journal > wiki, 'a journal must outrank an encyclopedia summary');
  assert.ok(wiki > unknown, 'an encyclopedia must outrank a blog nobody has heard of');
});

test('rejects a source outright rather than ranking it low', () => {
  // Zero means never read, not read last: a bad source read is a bad source
  // quoted, and the first research run cited exactly this kind of page.
  for (const url of [
    'https://top10bestreviews.example.com/best-space-facts-2024',
    'https://www.a-z-animals.com/animals/elephant/',
    'https://www.tripadvisor.com/elephant-sanctuary',
    'https://bestcamerareviews.example.net/x',
  ]) {
    assert.equal(authority(url), 0, `${url} should never be read`);
  }
});

test('a narrow shape rule does not catch real sites', () => {
  for (const url of ['https://bestpractices.dev/en', 'https://www.nature.com/x', 'https://top.gov.uk/report']) {
    assert.ok(authority(url) > 0, `${url} was rejected as a content farm`);
  }
});

test('picks passages that answer the question, not the first N bytes', () => {
  const question = 'how much delta-v does the europa clipper flyby need';
  const filler = 'The museum gift shop opens at nine.\n\n'.repeat(200);
  const answer = 'Each Europa flyby requires roughly 2.6 km/s of delta-v to maintain the tour.';
  const picked = selectPassages(`${filler}${answer}\n\n${filler}`, question, { budget: 1200 });

  assert.ok(picked.chars <= 1400, `the budget is a budget — got ${picked.chars}`);
  assert.ok(picked.text.includes('delta-v'), 'the one relevant sentence was dropped');
  assert.ok(picked.kept < picked.of, 'nothing was actually filtered out');
});

test('a page with no paragraph breaks is still readable', () => {
  // Plenty of pages arrive as one continuous run of text. That used to become a
  // single oversized block, which never fit the budget, so the source was
  // fetched and ranked and then read as empty — silently.
  const question = 'how much delta-v does the europa clipper flyby need';
  const filler = 'The museum gift shop opens at nine. '.repeat(200);
  const answer = 'Each Europa flyby requires roughly 2.6 km/s of delta-v to maintain the tour.';
  const picked = selectPassages(`${filler}${answer}${filler}`, question, { budget: 1200 });

  assert.ok(picked.chars > 0, 'the whole source was silently dropped');
  assert.ok(picked.text.includes('delta-v'), 'the answer was in there and was not found');
});

test('a source that matches nothing still returns its opening', () => {
  const picked = selectPassages('Entirely unrelated prose about bicycles.', 'quantum chromodynamics', {
    budget: 500,
  });
  assert.ok(picked.text.length > 0, 'an unmatched source must not read as an empty one');
});

test('the best passage is trimmed to fit rather than discarded', () => {
  // A block can be larger than the entire budget. Skipping it left the reader
  // with the second-best passage, or with nothing at all.
  const question = 'delta-v europa clipper flyby';
  const long = `Each Europa flyby requires roughly 2.6 km/s of delta-v. ${'Padding sentence here. '.repeat(80)}`;
  const picked = selectPassages(long, question, { budget: 400 });

  assert.ok(picked.chars > 0, 'the only passage on the page was thrown away');
  assert.ok(picked.chars <= 400, 'and the budget still has to hold');
  assert.ok(picked.text.includes('delta-v'));
});

test('keywords ignore the words every question contains', () => {
  const words = keywords('what is the best way to compare social structures in elephants');
  assert.ok(words.includes('elephants'));
  for (const stop of ['what', 'is', 'the', 'to', 'in']) {
    assert.ok(!words.includes(stop), `"${stop}" is not a keyword`);
  }
});

test('script and style never reach the reader', () => {
  const html = `
    <html><head><style>body{color:red}</style></head>
    <body><script>alert('x')</script><p>The actual sentence.</p></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('The actual sentence.'));
  assert.ok(!/alert|color:red/.test(text), 'page machinery was read as content');
});

test('the SSRF screen refuses anything that is not a public host', () => {
  // A search result is somebody else's URL. Without this screen a result could
  // aim Woboo's fetch at the dashboard on loopback, the router, or cloud
  // instance metadata.
  for (const url of [
    'http://127.0.0.1:4477/api/state',
    'http://localhost:4477/',
    'http://[::1]/',
    'http://10.0.0.4/internal',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://printer.internal/',
  ]) {
    assert.equal(isPublicUrl(url), false, `${url} must never be fetched`);
  }
});

test('the screen is not fooled by odd spellings or other schemes', () => {
  // The WHATWG parser normalises these to 127.0.0.1 before the check runs.
  for (const url of ['http://2130706433/', 'http://0x7f.1/']) {
    assert.equal(isPublicUrl(url), false, `${url} is loopback in disguise`);
  }
  for (const url of ['file:///C:/Users/asus/secrets.txt', 'ftp://example.com/x', 'gopher://example.com/']) {
    assert.equal(isPublicUrl(url), false, `${url} is not a web page`);
  }
});

test('the screen lets real public sources through', () => {
  for (const url of [
    'https://en.wikipedia.org/wiki/Europa_Clipper',
    'http://example.com/report',
    'https://172.15.0.1/edge-case', // just outside 172.16/12 — public space
    'https://172.32.0.1/edge-case',
  ]) {
    assert.equal(isPublicUrl(url), true, `${url} is an ordinary public address`);
  }
});

// ── DNS rebinding ───────────────────────────────────────────────────────────
// The lexical screen judges what a URL says. A public name can still resolve
// to a private address, so fetchSource resolves the host and judges every
// answer before a single byte is fetched. `lookup` stands in for DNS.

const PAGE = `<p>${'A public page about elephants and their social lives. '.repeat(20)}</p>`;

const PUBLIC_IP = { address: '93.184.216.34', family: 4 };

function stubFetch(t, handler = async () => new Response(PAGE, { headers: { 'content-type': 'text/html' } })) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return handler(...args);
  });
  return calls;
}

test('a public name with public answers is fetched', async (t) => {
  const calls = stubFetch(t);
  const lookedUp = [];
  const got = await fetchSource(
    { url: 'https://elephants.example.com/report' },
    {
      lookup: async (host) => {
        lookedUp.push(host);
        return [PUBLIC_IP];
      },
    },
  );

  assert.ok(got, 'a public answer must not stop the fetch');
  assert.deepEqual(lookedUp, ['elephants.example.com']);
  assert.equal(calls.length, 1);
});

test('a public name that resolves to loopback is refused before the fetch', async (t) => {
  // The rebinding case: the URL reads public, DNS says 127.0.0.1.
  const calls = stubFetch(t);
  const got = await fetchSource(
    { url: 'https://sneaky.example.com/' },
    { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
  );

  assert.equal(got, null, 'loopback behind a public name is still loopback');
  assert.equal(calls.length, 0, 'the request must never leave the process');
});

test('a public name that resolves to cloud metadata is refused', async (t) => {
  const calls = stubFetch(t);
  const got = await fetchSource(
    { url: 'https://sneaky.example.com/' },
    { lookup: async () => [{ address: '169.254.169.254', family: 4 }] },
  );

  assert.equal(got, null);
  assert.equal(calls.length, 0);
});

test('one private answer among public ones refuses the whole name', async (t) => {
  // Round-robin DNS could hand the connection the private one, so every
  // answer has to pass, not just most of them.
  const calls = stubFetch(t);
  const got = await fetchSource(
    { url: 'https://sneaky.example.com/' },
    { lookup: async () => [PUBLIC_IP, { address: '10.0.0.4', family: 4 }] },
  );

  assert.equal(got, null);
  assert.equal(calls.length, 0);
});

test('a DNS failure fails closed', async (t) => {
  const calls = stubFetch(t);
  const got = await fetchSource(
    { url: 'https://gone.example.com/' },
    {
      lookup: async () => {
        throw new Error('getaddrinfo ENOTFOUND gone.example.com');
      },
    },
  );

  assert.equal(got, null, 'an unresolvable name is not fetchable anyway');
  assert.equal(calls.length, 0);
});

test('an IP literal is judged lexically, without a lookup', async (t) => {
  const calls = stubFetch(t);
  let lookups = 0;
  const got = await fetchSource(
    { url: 'https://93.184.216.34/report' },
    {
      lookup: async () => {
        lookups++;
        return [PUBLIC_IP];
      },
    },
  );

  assert.ok(got, 'a public literal needs no resolver');
  assert.equal(lookups, 0, 'a literal must not trigger a lookup');
  assert.equal(calls.length, 1);
});

test('a redirect to a private address is refused hop by hop', async (t) => {
  // Redirects are followed by hand precisely so this Location gets screened.
  const calls = stubFetch(t, async (url) => {
    if (String(url).includes('example.com')) {
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4477/api/state' } });
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
  });
  const got = await fetchSource(
    { url: 'https://elephants.example.com/report' },
    { lookup: async () => [PUBLIC_IP] },
  );

  assert.equal(got, null, 'a redirect is somebody else choosing the URL again');
  assert.equal(calls.length, 1, 'only the first hop may leave the process');
});
