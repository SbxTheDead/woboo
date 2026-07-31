// Why the research is worth reading: what gets let in.
//
// The first research run cited Wikipedia and nothing else and the owner's
// verdict was "its really bad". Authority ranking is what stops that — a
// content farm and a peer-reviewed journal must not weigh the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authority, keywords, selectPassages, htmlToText } from '../src/sources.mjs';

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
