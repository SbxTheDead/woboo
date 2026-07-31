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
import { PATHS } from './config.mjs';
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
        'about:blank',
      ].filter(Boolean),
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    record('browser', `launched ${which} with Woboo's own profile on port ${PORT}`);
    page = await waitForBrowser(20);
    if (!page) return { ok: false, error: 'browser did not open a debuggable page' };
  }

  socket = new WebSocket(page.webSocketDebuggerUrl);
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
  return { ok: true, title: page.title, url: page.url };
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
  const world = frameOf(index);
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
  const result = await evaluate(
    `(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (!el) return { ok: true, landed: '' };
    const now = el.isContentEditable ? (el.innerText || '') : String(el.value ?? '');
    return { ok: now.length > 0, landed: now.slice(0, 60) };
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
