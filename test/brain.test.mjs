// A plan that fetches a web page with a shell command is the wrong plan.
//
// The system prompt says so, the owner's stance says so, and the model does it
// anyway — Invoke-WebRequest into a regex against raw HTML. It gets one file, it
// cannot follow a search result, it trips anti-bot pages, and it is invisible to
// an owner who asked to watch their machine being used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redirectWebFetches } from '../src/brain.mjs';

const shellStep = (instruction) => ({
  steps: [{ title: 'Get the status', kind: 'shell', instruction, verify: "Test-Path 'D:\\page.html'" }],
});

test('rewrites a shell fetch into a browser step', () => {
  for (const command of [
    "Invoke-WebRequest -Uri 'https://europa.nasa.gov/mission/' -OutFile 'D:\\page.html'",
    "curl https://example.com/status -o out.html",
    "iwr 'https://example.com' | Select-Object -ExpandProperty Content",
    "wget https://example.com/x.html",
  ]) {
    const [step] = redirectWebFetches(shellStep(command)).steps;
    assert.equal(step.kind, 'web', `${command} was left as a shell step`);
    assert.match(step.instruction, /^Open https?:\/\//, 'the browser step must name the url');
    assert.equal(step.verify, '', 'the old verify checked a file that no longer gets written');
  }
});

test('leaves shell steps that are not fetching a page alone', () => {
  for (const command of [
    'npm test',
    "git commit -m 'x'",
    "New-Item -ItemType Directory 'D:\\out'",
    // Talking to Woboo's own dashboard is not browsing.
    "Invoke-WebRequest -Uri 'http://127.0.0.1:4477/health'",
    "curl http://localhost:3000/api",
  ]) {
    const [step] = redirectWebFetches(shellStep(command)).steps;
    assert.equal(step.kind, 'shell', `${command} should not have been rewritten`);
  }
});

test('a plan with no steps does not throw', () => {
  assert.doesNotThrow(() => redirectWebFetches({ steps: [] }));
  assert.doesNotThrow(() => redirectWebFetches({}));
  assert.doesNotThrow(() => redirectWebFetches(null));
});
