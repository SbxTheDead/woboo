// Driving a browser properly: the DOM, not pixels.
//
// The pilot works by screenshotting the screen, drawing a grid on it, and asking
// a vision model which cell to click. That is the only option for a native app,
// and it is a bad one for a browser: measured on a free tier, one step cost 153
// seconds and the model still had to guess at a coordinate it could not verify.
//
// A browser does not need guessing. Chrome and Edge both speak the DevTools
// Protocol over a WebSocket, which means Woboo can ask the page what is on it —
// every link, button and field, with its real text — click an element by
// identity rather than position, and read back what happened. No screenshot, no
// vision model, no grid. Milliseconds instead of minutes, and it can reach
// things below the fold that a screenshot never showed.
//
// This is the same idea as browser-use, without Python or Playwright: Node has
// had a WebSocket client built in since v22, so it costs no dependency at all.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PATHS, loadSettings, resolveProxy } from './config.mjs';
import { record } from './journal.mjs';
import { assertLive } from './guard.mjs';
import { browserPath } from './toolbox.mjs';

const PORT = 9333;
const HOST = '127.0.0.1';

let socket = null;
let nextId = 1;
const pending = new Map();
let child = null;
let loading = 0;

// One JavaScript world per frame.
//
// Gmail draws its entire interface — the message list, the compose window,
// every field in it — inside iframes. The top-level document is 359 characters
// of navigation chrome. Reading only that document meant the compose window
// genuinely did not exist as far as Woboo could tell, so it asked for a "To"
// field that was never in the list and stalled. Most serious web applications
// are built this way.
const contexts = new Map();

// Which frame each element in the last snapshot came from, so a click goes to
// the world that element actually lives in.
let elementFrames = [];

// ── connection ────────────────────────────────────────────────────────────────

async function targets() {
  const response = await fetch(`http://${HOST}:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  return response.json();
}

async function waitForBrowser(seconds = 20) {
  for (let i = 0; i < seconds * 2; i += 1) {
    try {
      const list = await targets();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// Woboo's own browser profile, kept for good.
//
// It cannot be the owner's real Chrome profile, and that is Chrome's decision
// rather than a limitation here: since Chrome 136, --remote-debugging-port is
// refused outright when the user-data-dir is the default profile. The reason is
// sound — it is precisely how malware steals live sessions — and it is not
// negotiable. Chrome launches, the port never opens, and nothing can attach.
//
// So Woboo keeps a profile of its own, under ~/.woboo rather than TEMP so that
// signing in survives a reboot. Sign in to Gmail there once and it stays signed
// in, exactly like a second browser. That is also the safer arrangement: Woboo
// can only reach the accounts deliberately given to it, not everything the owner
// happens to be logged into.
export function profileDir() {
  return path.join(PATHS.home, 'browser');
}

function profileArgs() {
  return [`--user-data-dir=${profileDir()}`];
}

export async function open({ fresh = false } = {}) {
  assertLive('browser');
  if (socket && socket.readyState === 1) return { ok: true, reused: true };

  const exe = browserPath();
  if (!exe) return { ok: false, error: 'no Chrome or Edge found to drive' };
  const which = /chrome\.exe$/i.test(exe) ? 'Chrome' : 'Edge';
  // Something already listening on the port is a browser Woboo can drive.
  let page = await waitForBrowser(1);
  if (!page) {
    fs.mkdirSync(profileDir(), { recursive: true });

    child = spawn(
      exe,
      [
        `--remote-debugging-port=${PORT}`,
        ...profileArgs(),
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        // A fresh profile has no locale, so sites guess from the IP address and
        // serve whatever language that suggests. Google came back in German and
        // the model spent six steps clicking "Suche".
        '--lang=en-US',
        fresh ? '--incognito' : '',
        // Proxy support: if HTTP_PROXY or HTTPS_PROXY is set, or the owner
        // configured a proxy in settings, route all browser traffic through it.
        resolveProxy() ? '--proxy-server=' + resolveProxy() : '',
        'about:blank',
      ].filter(Boolean),
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    record('browser', `launched ${which} with Woboo's own profile on port ${PORT}`);
    page = await waitForBrowser(20);
    if (!page) return { ok: false, error: 'browser did not open a debuggable page' };
  }

  return attach(page.webSocketDebuggerUrl, { title: page.title, url: page.url });
}

// Attach to anything that speaks the DevTools protocol, given the WebSocket
// URL directly. open() ends up here once it has found or launched a browser;
// the tests arrive here with a fake CDP server instead of a real Chrome, so
// the whole protocol layer below is exercised without one.
export async function attach(wsUrl, { title = '', url = '' } = {}) {
  assertLive('browser');
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('could not attach to the browser')), { once: true });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    // Navigation, watched rather than guessed at. Clicking a link or submitting
    // a search starts a page load, and for a moment afterwards the old page is
    // still there — fully loaded, unchanged, and completely stale. Reading it
    // then returns the previous page's contents while reporting success, which
    // is exactly how a search came back with nothing on it.
    if (message.method === 'Page.frameStartedLoading') loading += 1;
    if (message.method === 'Page.frameStoppedLoading') loading = Math.max(0, loading - 1);

    // Every frame is its own JavaScript world, and the interesting one is
    // usually not the top. Track them as Chrome announces them.
    if (message.method === 'Runtime.executionContextCreated') {
      const ctx = message.params.context;
      contexts.set(ctx.id, {
        id: ctx.id,
        origin: ctx.origin,
        frameId: ctx.auxData?.frameId || null,
        isDefault: ctx.auxData?.isDefault !== false,
      });
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(message.params.executionContextId);
    }
    if (message.method === 'Runtime.executionContextsCleared') contexts.clear();

    // A native dialog freezes everything.
    //
    // alert(), confirm() and beforeunload block the renderer completely: no
    // script runs, no input is delivered, and every CDP call sits there until it
    // times out. Gmail throws one — "Your draft has been modified. Abandon
    // changes?" — and the whole mission died on "Input.dispatchMouseEvent timed
    // out", with no clue on screen unless someone happened to be watching the
    // window.
    //
    // Answer it, always, and answer NO. Woboo is never the one who should agree
    // to abandon the owner's work; a dialog asking to discard something is
    // exactly the thing to decline. Any prompt that genuinely needs a yes is the
    // owner's to give.
    if (message.method === 'Page.javascriptDialogOpening') {
      const { type, message: text } = message.params;
      record('browser', `page asked "${String(text).slice(0, 80)}" — declining`, { level: 'warn' });
      // beforeunload is the one that must be accepted: refusing it leaves the
      // page wedged on a navigation that can never complete.
      send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }).catch(() => {});
    }

    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await surface();
  record('browser', 'attached', { level: 'ok' });
  return { ok: true, title, url };
}

function send(method, params = {}) {
  if (!socket || socket.readyState !== 1) return Promise.reject(new Error('browser is not attached'));
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30_000);
  });
}

// Run JS in the page and get the value back. `contextId` picks a frame; null is
// the top-level document.
async function evaluate(expression, contextId = null) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...(contextId === null ? {} : { contextId }),
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'script failed in the page');
  }
  return result.result?.value;
}

// Move the owner's real cursor to where Woboo is about to click.
//
// The click itself goes through the DevTools protocol, because that is the
// reliable way to hit an element by identity rather than by a coordinate that
// might be wrong. But a click nobody can see does not look like a machine being
// used — "why don't I see it using my mouse" is a fair complaint about an agent
// whose entire promise is being a body.
//
// So the pointer travels to the element first, visibly, and the click lands
// where the pointer is. If moving it fails, or the owner has turned it off, the
// click still happens: this is presentation, not mechanism.
let screenOffset = null;

async function showPointer(viewportX, viewportY) {
  // Off unless asked for. Moving the owner's real pointer looked like the
  // answer to "why can't I see it working" and was not: the cursor wandered to
  // places that did not match where the click actually went, which reads as a
  // machine flailing rather than one working. The click itself is precise —
  // this was only ever decoration, and wrong decoration is worse than none.
  if (loadSettings().visibleCursor !== true) return;
  try {
    if (!screenOffset) {
      // Where the page's top-left sits on the actual screen. Read once per
      // attach; a moved window is corrected on the next one.
      const box = await evaluate(
        `({ x: window.screenX + (window.outerWidth - window.innerWidth),
            y: window.screenY + (window.outerHeight - window.innerHeight) })`,
      );
      if (!box || typeof box.x !== 'number') return;
      screenOffset = box;
    }
    const hands = await import('./hands.mjs');
    await hands.showCursor(screenOffset.x + viewportX, screenOffset.y + viewportY);
  } catch {
    // A cursor that will not move is not a reason to fail a click.
  }
}

// Bring the window forward, and keep the page treated as visible.
//
// A Chrome window behind everything else is marked hidden, and Chrome then
// throttles it: layout is deferred, timers are slowed, and applications that
// check for it simply do not act. Gmail's Compose button was clicked correctly,
// with a real mouse press, at the right coordinates — and nothing opened,
// because as far as the page was concerned nobody was looking at it.
//
// The owner also asked to see their machine being used. A window they cannot
// see is not that.
async function surface() {
  await send('Page.bringToFront').catch(() => {});
  // Belt and braces: tell the renderer the page is visible and focused even if
  // the window manager disagrees, so a mission does not stall because the owner
  // clicked on something else.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

// The "verify you are human" checkbox.
//
// Cloudflare renders it inside a cross-origin iframe, so it never appears in the
// element list — Woboo could see a page that was clearly a challenge and had
// nothing on it to act on. The iframe itself is visible in the top document
// though, and the checkbox sits at a predictable spot near its left edge.
//
// Worth being straight about what this is and is not. It clicks a control the
// owner could click themselves, on a page they asked to visit. It does not
// solve puzzles, does not use a solving service, and does not disguise the
// browser. Turnstile also scores pointer movement and timing, not just the
// click, so this often will not pass — which is why the loop's real answer to a
// blocked page is to go and read a different source.
export async function clickHumanCheck() {
  assertLive('browser');
  const box = await evaluate(`(() => {
    const frame = [...document.querySelectorAll('iframe')].find((f) =>
      /challenges\\.cloudflare\\.com|turnstile|hcaptcha\\.com|recaptcha/.test(f.src || ''));
    if (!frame) return null;
    const b = frame.getBoundingClientRect();
    if (b.width < 40 || b.height < 20) return null;
    // The checkbox sits at the left of the widget, vertically centred.
    return { x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2), w: Math.round(b.width) };
  })()`);

  if (!box) return { ok: false, error: 'no human-verification widget on this page' };

  await surface();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 40, y: box.y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 });
  const at = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
  record('browser', 'clicked the human-verification checkbox', { level: 'warn' });

  // Give it a moment, then say whether the page actually moved on.
  await new Promise((r) => setTimeout(r, 4000));
  const still = await evaluate(
    `/just a moment|verify you are human|checking your browser|needs to review the security/i.test(document.body.innerText || '')`,
  );
  return still
    ? { ok: false, error: 'the check did not pass — it scores how the pointer moved, not just the click' }
    : { ok: true };
}

// Go back, the way a person does when a link turns out to be a dead end.
//
// history.back() is unreliable here: Page.navigate does not always leave an
// entry to go back to, so the model asked to go back three times, watched
// nothing happen, and concluded the page was broken. Woboo keeps its own trail
// instead, which is exactly as long as it needs to be.
const trail = [];

export async function back() {
  assertLive('browser');
  trail.pop(); // where we are now
  const previous = trail[trail.length - 1];
  if (!previous) return { ok: false, error: 'nowhere to go back to — this is the first page' };
  await send('Page.navigate', { url: previous });
  await settle();
  record('browser', `went back to ${previous}`);
  return { ok: true, url: previous };
}

// Which frame an element from the last snapshot lives in. Null means the top
// document, which is also the honest answer for an index never seen.
function frameOf(index) {
  return elementFrames[Number(index)] ?? null;
}

export function close() {
  try {
    socket?.close();
  } catch {
    // Already gone.
  }
  socket = null;
  pending.clear();
  contexts.clear();
  elementFrames = [];
  screenOffset = null;
}

// ── what is on the page ───────────────────────────────────────────────────────

// Collect everything a person could interact with, each with a stable index and
// the text they would actually see. This replaces the screenshot: it is what the
// model reads to decide what to do, and it is a few kilobytes of text rather
// than a few hundred of image.
const COLLECT = (startIndex = 0) => `((START) => {
  const out = [];
  const seen = new Set();

  // Where this frame sits in the top-level viewport. A real mouse click is
  // dispatched in page coordinates, so an element inside an iframe has to have
  // its frame's offset added or the click lands somewhere else entirely.
  let offX = 0, offY = 0, depth = 0;
  try {
    let w = window;
    while (w !== w.parent && w.frameElement && depth < 8) {
      const fb = w.frameElement.getBoundingClientRect();
      offX += fb.left; offY += fb.top; w = w.parent; depth += 1;
    }
  } catch {
    // A cross-origin parent cannot be measured. Such a frame is not ours to
    // drive anyway, and reporting it with wrong coordinates would be worse.
    return { elements: [], crossOrigin: true, text: '' };
  }
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox], [role=searchbox], [role=combobox], [onclick], [contenteditable=true]';
  const label = (el) => (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.value ||
    (el.innerText || '').trim().replace(/\\s+/g, ' ') ||
    el.getAttribute('name') ||
    el.getAttribute('alt') || ''
  ).slice(0, 90);

  // When a dialog is open, it is the page.
  //
  // Gmail's inbox has several hundred interactive elements and its compose
  // window is a dialog on top of them. Collecting the document in source order
  // and stopping at a cap meant the compose fields — the only things that
  // mattered — never appeared in the list at all, so the model kept asking for
  // an element that was not there and the loop stalled on "To". A person looking
  // at that screen sees a compose window, not four hundred inbox rows.
  const dialogs = [...document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]')]
    .filter((d) => {
      const b = d.getBoundingClientRect();
      return b.width > 80 && b.height > 60;
    });
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;

  // In view first, so a cap trims what is off-screen rather than whatever the
  // page happened to declare last.
  const candidates = [...scope.querySelectorAll(sel)].sort((a, b) => {
    const ay = a.getBoundingClientRect().top;
    const by = b.getBoundingClientRect().top;
    const aIn = ay >= 0 && ay < innerHeight ? 0 : 1;
    const bIn = by >= 0 && by < innerHeight ? 0 : 1;
    return aIn - bIn;
  });

  for (const el of candidates) {
    const box = el.getBoundingClientRect();
    // Skip what a person could not interact with either.
    const style = getComputedStyle(el);
    if (box.width < 2 || box.height < 2) continue;
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (el.disabled) continue;

    const text = label(el);
    const editable = el.isContentEditable;
    if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !editable) continue;
    const key = el.tagName + '|' + text + '|' + Math.round(box.top) + '|' + Math.round(box.left);
    if (seen.has(key)) continue;
    seen.add(key);

    const index = START + out.length;
    out.push({
      i: index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || el.getAttribute('role') || '',
      text,
      href: (el.getAttribute('href') || '').slice(0, 120),
      inView: box.top >= 0 && box.top < innerHeight,
      // What is currently IN the field. Without this the model cannot tell that
      // it already typed here, so it types again, and again — the page looks
      // identical to it every time. A contenteditable has no .value at all,
      // which is most of a mail compose window.
      value: (editable ? (el.innerText || '') : el.value === undefined ? '' : String(el.value)).slice(0, 60),
      focused: el === document.activeElement,
    });
    el.setAttribute('data-woboo', String(index));
    if (out.length >= 150) break;
  }
  return {
    url: location.href,
    title: document.title,
    elements: out,
    // Say when the list is only part of the page, so a missing element reads as
    // "not shown" rather than "does not exist".
    dialog: dialogs.length ? (dialogs[dialogs.length - 1].getAttribute('aria-label') || 'dialog') : null,
    truncated: out.length >= 150,
    text: ((scope === document ? document.body : scope).innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000),
  };
})(${Number(startIndex)})`;

export async function snapshot() {
  // A page with nothing interactive on it is almost never a finished page.
  //
  // Gmail's compose window takes a few seconds to draw, and the first look
  // found zero elements — so the model saw an empty page, guessed it was a
  // login screen, and gave up on a window that appeared a second later. Look
  // again before believing it.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const page = await readAllFrames();
    if (page.elements.length || attempt === 3) return page;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return readAllFrames();
}

async function readAllFrames() {
  assertLive('browser');

  // Read every frame, not just the top one. They are numbered in one sequence
  // so the model still names a single element by a single number and never has
  // to know that frames exist.
  //
  // Each world exactly once. Passing `null` for the top document AND its own
  // context id collected the same document twice, and the second pass renumbered
  // the data-woboo tags the first pass had just written — so every element the
  // model had been shown reported "no longer on the page" the moment it was
  // used. The main frame goes first so its url and title are the page's.
  const tree = await send('Page.getFrameTree').catch(() => null);
  const mainFrameId = tree?.frameTree?.frame?.id || null;
  const defaults = [...contexts.values()].filter((c) => c.isDefault);
  const main = defaults.find((c) => c.frameId && c.frameId === mainFrameId);
  const worlds = defaults.length
    ? [main?.id ?? null, ...defaults.filter((c) => c !== main).map((c) => c.id)]
    : [null];
  const merged = [];
  const frames = [];
  let head = null;
  const texts = [];

  for (const contextId of worlds) {
    let part;
    try {
      part = await evaluate(COLLECT(merged.length), contextId);
    } catch {
      continue; // A frame that went away mid-read is not an error.
    }
    if (!part || part.crossOrigin || !Array.isArray(part.elements)) continue;
    if (!head) head = part; // the main frame is read first
    for (const element of part.elements) {
      merged.push(element);
      frames.push(contextId);
    }
    if (part.text) texts.push(part.text);
    if (merged.length >= 300) break;
  }

  elementFrames = frames;
  // Every page Woboo actually ends up on, however it got there. Recording only
  // deliberate navigations meant a result reached by clicking left no trail, so
  // "back" had nowhere to go and reported the page was stuck.
  const here = head?.url || '';
  if (here && trail[trail.length - 1] !== here) trail.push(here);
  if (trail.length > 30) trail.shift();

  const page = {
    url: head?.url || '',
    title: head?.title || '',
    elements: merged,
    dialog: head?.dialog || null,
    // The top document of an application like Gmail says almost nothing; the
    // frames say everything.
    text: texts.join('\n\n').slice(0, 8000),
    frames: worlds.length,
  };
  record(
    'browser',
    `read ${merged.length} elements${worlds.length > 1 ? ` across ${worlds.length} frames` : ''} on ${page.title || page.url}`.slice(
      0,
      160,
    ),
  );
  return page;
}

// ── acting ────────────────────────────────────────────────────────────────────

export async function goto(url) {
  assertLive('browser');
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  await send('Page.navigate', { url: target });
  await settle();
  // Remember where we have been, so "back" has somewhere to go.
  record('browser', `went to ${target}`);
  return { ok: true, url: target };
}

// A click by identity, not by coordinate. The element is the one the model named,
// wherever it happens to be on the page.
export async function click(index) {
  assertLive('browser');

  // A real mouse press, not el.click().
  //
  // A synthetic click has isTrusted:false and carries no mousedown or mouseup.
  // Applications built out of divs — Gmail's Compose is one — listen for the
  // real sequence and ignore the synthetic one entirely. Clicking Compose
  // appeared to succeed and nothing opened, so the model went looking for a
  // "To" field that was never going to exist.
  //
  // This is the one place browser-use genuinely does better than a naive DOM
  // driver, and the reason is Playwright sending real input rather than Python.
  // CDP sends the same events from here.
  const world = frameOf(index);
  const spot = await evaluate(
    `(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (!el) return { ok: false, error: 'element ${index} is no longer on the page' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const b = el.getBoundingClientRect();
    // Add the offset of every frame this element sits inside, so the click lands
    // where it looks rather than where the frame thinks it is.
    let offX = 0, offY = 0, w = window, depth = 0;
    try {
      while (w !== w.parent && w.frameElement && depth < 8) {
        const fb = w.frameElement.getBoundingClientRect();
        offX += fb.left; offY += fb.top; w = w.parent; depth += 1;
      }
    } catch { /* cross-origin parent; use the frame's own coordinates */ }
    return {
      ok: true,
      x: Math.round(offX + b.left + b.width / 2),
      y: Math.round(offY + b.top + b.height / 2),
      text: (el.innerText || el.value || '').slice(0, 60),
      offScreen: b.bottom < 0 || b.top > innerHeight || b.width < 1,
    };
  })()`,
    world,
  );

  if (!spot.ok) {
    record('browser', `click failed: ${spot.error}`, { level: 'warn' });
    return spot;
  }

  let result = spot;
  if (spot.offScreen) {
    // Nothing to aim at; fall back to the element's own click handler.
    result = await evaluate(
      `(() => {
      const el = document.querySelector('[data-woboo="${Number(index)}"]');
      if (!el) return { ok: false, error: 'element ${index} is no longer on the page' };
      el.click();
      return { ok: true, text: (el.innerText || el.value || '').slice(0, 60) };
    })()`,
      world,
    );
  } else {
    // Let the owner watch the pointer go there.
    await showPointer(spot.x, spot.y);

    // `buttons` is the bitmask of what is held down, and it is not optional:
    // without it Chrome delivers a press that many handlers quietly ignore.
    const at = { x: spot.x, y: spot.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: spot.x,
      y: spot.y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
  }
  await settle();
  record('browser', result.ok ? `clicked ${index} "${result.text}"` : `click failed: ${result.error}`, {
    level: result.ok ? 'ok' : 'warn',
  });
  return result;
}

export async function type(index, text) {
  assertLive('browser');

  // Focus and clear in the page, then let the browser deliver the text.
  //
  // Setting el.value works on a plain input and does nothing at all on a
  // contenteditable — which is what a mail compose window is made of. Gmail's
  // To field took the value and threw it away, so the model typed the same
  // address three times into a field that never changed.
  //
  // Input.insertText goes through the browser's own input pipeline, so the page
  // cannot tell it from a person and every widget handles it: React inputs,
  // contenteditable, and the chip-style recipient fields mail clients use.
  //
  // It delivers to whatever the *browser* considers focused, though, and
  // el.focus() inside an iframe focuses within that frame without giving the
  // frame itself focus. In Gmail — where every field is in a frame — the
  // address, the subject and the body all went into the To field, one after
  // another, because focus never actually moved.
  //
  // Clicking the field first was the obvious fix and the wrong one: it put
  // stray clicks on a live inbox and selected fifty conversations. DOM.focus is
  // the right tool — it sets focus at the browser level, in the correct frame,
  // touching nothing else.
  const world = frameOf(index);
  const handle = await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-woboo="${Number(index)}"]')`,
    ...(world === null ? {} : { contextId: world }),
  }).catch(() => null);
  if (handle?.result?.objectId) {
    await send('DOM.focus', { objectId: handle.result.objectId }).catch(() => {});
    await send('Runtime.releaseObject', { objectId: handle.result.objectId }).catch(() => {});
  }

  const focused = await evaluate(
    `(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (!el) return { ok: false, error: 'field ${index} is no longer on the page' };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = '';
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    } else if ('value' in el) {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
      if (setter) setter.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true };
  })()`,
    world,
  );
  if (!focused.ok) {
    record('browser', `type failed: ${focused.error}`, { level: 'warn' });
    return focused;
  }

  await send('Input.insertText', { text: String(text) });

  // Confirm rather than assume. A field that silently rejected the text is the
  // exact failure this replaced, and reporting success on it wastes three more
  // steps before the loop-breaker notices.
  const wanted = JSON.stringify(String(text).slice(0, 60));
  const result = await evaluate(
    `(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (!el) return { ok: true, landed: '' };
    const now = el.isContentEditable ? (el.innerText || '') : String(el.value ?? '');
    if (now.length) return { ok: true, landed: now.slice(0, 60) };

    // An empty field is not proof the text was rejected. A chip field — mail
    // recipients, tag pickers — swallows what you type and shows it as a block
    // beside the input, leaving the input itself blank. Reading only the input
    // reported failure on the one case that had actually worked, so the model
    // typed the address again, and again, into a field that kept accepting it.
    const box = el.closest('[role=dialog], form, [role=main]') || document.body;
    const near = (box.innerText || '');
    if (near.includes(${wanted})) return { ok: true, landed: ${wanted}, chip: true };
    return { ok: false, landed: '' };
  })()`,
    world,
  );
  if (!result.ok) result.error = `the field did not accept the text`;
  record('browser', result.ok ? `typed into ${index}` : `type failed: ${result.error}`, {
    level: result.ok ? 'ok' : 'warn',
  });
  return result;
}

export async function pressEnter(index) {
  assertLive('browser');
  // Focus the field first, then send the key through the browser's own input
  // pipeline rather than dispatching a synthetic event. A page can tell the two
  // apart — KeyboardEvent.isTrusted is false for the synthetic one — and search
  // boxes are precisely the kind of thing that checks.
  await evaluate(
    `(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (el) el.focus();
  })()`,
    frameOf(index),
  );
  for (const type of ['keyDown', 'char', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r',
    });
  }
  await settle();
  return { ok: true };
}

export async function scroll(amount = 600) {
  await evaluate(`window.scrollBy(0, ${Number(amount)})`);
  return { ok: true };
}

// Everything a reader would see, for when the task is "what does this page say".
export async function readText() {
  return evaluate(`(document.body.innerText || '').slice(0, 20000)`);
}

// The exact rendered colour of an element — the thing a screenshot can only
// approximate and a person checking a design actually needs.
export async function styleOf(index, properties = ['color', 'background-color', 'font-family', 'font-size']) {
  return evaluate(`(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (!el) return null;
    const s = getComputedStyle(el);
    const out = {};
    for (const p of ${JSON.stringify(properties)}) out[p] = s.getPropertyValue(p).trim();
    const b = el.getBoundingClientRect();
    out.box = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    return out;
  })()`);
}

// Anything the page itself complained about. A screenshot cannot show you a
// console error or a failed request, and those are usually the actual bug.
export async function problems() {
  return evaluate(`(() => {
    const errors = window.__wobooErrors || [];
    return {
      errors: errors.slice(-20),
      brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src).slice(0, 20),
    };
  })()`);
}

// Start recording errors as soon as we attach, so a later check has something
// to report rather than only catching what happens after someone asks.
export async function watchErrors() {
  await evaluate(`(() => {
    if (window.__wobooErrors) return;
    window.__wobooErrors = [];
    addEventListener('error', (e) => window.__wobooErrors.push(String(e.message)));
    addEventListener('unhandledrejection', (e) => window.__wobooErrors.push('unhandled: ' + String(e.reason)));
  })()`);
}

// Wait for the page to stop changing, rather than sleeping a fixed guess.
async function settle(timeout = 12_000) {
  const deadline = Date.now() + timeout;

  // A click or an Enter does not navigate instantly — the page decides, a
  // fraction of a second later. Give it that fraction before concluding
  // anything is settled, or the "settled" page is the one we just left.
  const grace = Date.now() + 900;
  while (loading === 0 && Date.now() < grace) {
    await new Promise((r) => setTimeout(r, 60));
  }

  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (loading > 0) {
      last = '';
      continue;
    }
    let now;
    try {
      now = await evaluate(
        `document.readyState + ':' + location.href + ':' + document.querySelectorAll('*').length`,
      );
    } catch {
      // Mid-navigation the context is torn down; try again.
      last = '';
      continue;
    }
    if (now === last && String(now).startsWith('complete')) return;
    last = now;
  }
}

// A raw expression in the page, for diagnosing why a real site is not behaving.
// Not used by the pilot — the pilot acts through the numbered elements.
export function evaluateForDebug(expression) {
  return evaluate(expression);
}

// A single key, through the browser's real input pipeline. Applications often
// have keyboard shortcuts that are far more reliable than their buttons.
export async function pressKeyRaw(key) {
  assertLive('browser');
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    text: key.length === 1 ? key : undefined,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  return { ok: true };
}

// A picture of the page, for when a person needs to see what Woboo is looking at.
export async function screenshot() {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  return shot.data;
}
