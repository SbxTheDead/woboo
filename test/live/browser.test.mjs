// The browser, for real: a Chrome that actually launches, a page that actually
// loads, a field that is actually typed into.
//
// Separate from the rest because it opens a window and needs the network. Run it
// with `npm run test:live` — and run it before believing the browser works,
// because every browser bug this project has had was found by a person watching
// a mission fail, not by a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as browser from '../../src/browser.mjs';
import { browserPath } from '../../src/toolbox.mjs';

const skip = browserPath() ? false : 'no Chrome or Edge installed';

test('drives a real page end to end', { skip, timeout: 90_000 }, async (t) => {
  t.after(() => browser.close());

  const opened = await browser.open();
  assert.equal(opened.ok, true, opened.error);

  // Chrome has refused --remote-debugging-port on the default profile since
  // Chrome 136. If this ever regresses to the owner's real profile, the port
  // never opens and this is the line that says so.
  await browser.goto('https://duckduckgo.com/');

  const home = await browser.snapshot();
  assert.ok(home.elements.length > 5, `only ${home.elements.length} elements — the page did not render`);

  const field = home.elements.find((e) => e.tag === 'input' && !/hidden|submit/.test(e.type));
  assert.ok(field, 'no text field found on a search engine home page');

  const typed = await browser.type(field.i, 'europa clipper nasa mission');
  assert.equal(typed.ok, true, typed.error);

  // Enter has to go through Input.dispatchKeyEvent. A synthetic KeyboardEvent
  // has isTrusted:false and a search box is exactly the thing that checks.
  await browser.pressEnter(field.i);

  const text = String(await browser.readText());
  assert.ok(text.length > 500, `only ${text.length} chars back — settle() returned on the page we left`);
  assert.match(text, /clipper/i, 'the search ran but the results were never read');

  const after = await browser.snapshot();
  const links = after.elements.filter((e) => /^https?:/.test(e.href));
  assert.ok(links.length > 3, `only ${links.length} result links — nothing to follow`);
});

test('reads what a screenshot cannot', { skip, timeout: 60_000 }, async (t) => {
  t.after(() => browser.close());

  await browser.open();
  await browser.goto('https://example.com/');

  const snap = await browser.snapshot();
  const link = snap.elements.find((e) => e.tag === 'a');
  assert.ok(link, 'example.com has exactly one link and it was not found');

  // The rendered colour, not an approximation of it — this is the whole reason
  // the DOM rung exists for "check the design of this page" work.
  const style = await browser.styleOf(link.i);
  assert.match(style.color, /^rgb/, `expected a computed colour, got ${style.color}`);
  assert.ok(style.box.w > 0 && style.box.h > 0, 'the element has no size');

  const trouble = await browser.problems();
  assert.ok(Array.isArray(trouble.errors), 'console errors must be readable');
});
