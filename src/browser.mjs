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

import { spawn } from 'node:child_process';
import { loadSettings, saveSettings } from './config.mjs';
import { record } from './journal.mjs';
import { assertLive } from './guard.mjs';
import { exec } from './ps.mjs';
import * as consult from './consult.mjs';
import { browserPath, profileRoot, listProfiles } from './toolbox.mjs';

const PORT = 9333;
const HOST = '127.0.0.1';

let socket = null;
let nextId = 1;
const pending = new Map();
let child = null;

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

// Attach to a browser already running with debugging enabled, or start one.
// A separate user-data-dir keeps this out of the owner's real profile: their
// tabs, cookies and logins are not Woboo's to rummage through by default.
// Woboo's own browser profile, or the owner's real one.
//
// A scratch profile is the safe default: Woboo cannot see the owner's history,
// cookies or sessions. It is also useless for anything that needs a login —
// asked to open Gmail it lands on a sign-in page and has no way past it.
//
// Using the real profile is the owner's call, so it is a setting. The catch is
// Chrome's: a profile can only be open in one process, so if Chrome is already
// running the flag is ignored and a new window quietly joins the existing
// process — with no debugging port. That failure is silent, which is worse than
// loud, so it is detected and explained rather than guessed at.
function profileArgs() {
  const settings = loadSettings();
  if (settings.browserProfile !== 'mine') {
    return [`--user-data-dir=${process.env.TEMP || '.'}\\woboo-browser`];
  }
  // Which of the owner's profiles, named explicitly. Never a default: a person
  // with three profiles has three inboxes, and guessing means sending mail as
  // the wrong one.
  return [`--user-data-dir=${profileRoot()}`, `--profile-directory=${settings.chromeProfile}`];
}

// Is a browser of this kind already running? If so its profile is locked and
// a new launch cannot take the debugging port.
async function alreadyRunning(exeName) {
  const result = await exec('tasklist.exe', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV'], {
    timeout: 8000,
    action: 'check browser',
  }).catch(() => ({ ok: false, out: '' }));
  return result.ok && result.out.toLowerCase().includes(exeName.toLowerCase());
}

export async function open({ fresh = false } = {}) {
  assertLive('browser');
  if (socket && socket.readyState === 1) return { ok: true, reused: true };

  const exe = browserPath();
  if (!exe) return { ok: false, error: 'no Chrome or Edge found to drive' };
  const which = /chrome\.exe$/i.test(exe) ? 'Chrome' : 'Edge';
  const exeName = which === 'Chrome' ? 'chrome.exe' : 'msedge.exe';
  const settings = loadSettings();
  const wantsReal = settings.browserProfile === 'mine';

  // Decide whose browser this is BEFORE attaching to anything. A debuggable
  // browser left over from an earlier run will happily accept a connection, and
  // attaching to it would quietly ignore the profile the owner chose — acting as
  // the wrong account while reporting success.
  let profileDir = settings.chromeProfile;
  if (wantsReal && !profileDir) {
    const choices = listProfiles();
    if (!choices.length) {
      return { ok: false, error: `no ${which} profile found to use` };
    }
    if (choices.length === 1) {
      profileDir = choices[0].dir;
    } else {
      // Ask, wherever the owner is — the widget, the console, or their phone —
      // and keep the answer. Guessing here means acting as the wrong person.
      profileDir = await consult.ask({
        key: 'browser.profile',
        question: `Which ${which} profile should Woboo use?`,
        detail: 'It will act as that account: its mail, its logins, its sessions.',
        options: choices.map((p) => ({
          label: `${p.name}${p.email ? ` — ${p.email}` : ''}`,
          value: p.dir,
        })),
      });
      if (!profileDir) {
        return {
          ok: false,
          needsProfile: choices,
          error:
            `Woboo asked which ${which} profile to use and got no answer. ` +
            `Choose one with \`woboo browser use "<name>"\`, or answer the question in Telegram.`,
        };
      }
      saveSettings({ chromeProfile: profileDir });
    }
  }

  // Something already listening on the port is a browser Woboo can drive.
  let page = await waitForBrowser(1);
  if (!page) {
    if (wantsReal && (await alreadyRunning(exeName))) {
      // Chrome allows one process per profile, so reaching the owner's
      // logged-in profile means restarting it. That is their window and their
      // tabs, so ask — but ask rather than dead-ending, because "I cannot do
      // this" when a single tap would fix it is a bad answer.
      const restart = await consult.ask({
        question: `Restart ${which} so Woboo can use your logged-in profile?`,
        detail:
          `${which} only allows one process per profile, and the one running now has no debugging port. ` +
          `Your tabs will restore.`,
        options: [
          { label: `Yes, restart ${which}`, value: 'restart' },
          { label: 'No, use a blank profile instead', value: 'own' },
        ],
        timeout: 180,
      });

      if (restart === 'own') {
        saveSettings({ browserProfile: 'own' });
        record('browser', 'owner chose a blank profile instead of restarting', { level: 'warn' });
      } else if (restart === 'restart') {
        record('browser', `restarting ${which} to attach to the owner's profile`, { level: 'warn' });
        await exec('taskkill.exe', ['/F', '/IM', exeName], { timeout: 15_000, action: 'restart browser' }).catch(
          () => {},
        );
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        return {
          ok: false,
          needsRestart: which,
          error:
            `${which} is already running and Woboo cannot attach to your logged-in profile while it is — ` +
            `${which} allows one process per profile, and the running one has no debugging port. ` +
            `Close ${which} and try again, or run \`woboo browser --restart\`.`,
        };
      }
    }

    child = spawn(
      exe,
      [
        `--remote-debugging-port=${PORT}`,
        ...profileArgs(),
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        fresh ? '--incognito' : '',
        'about:blank',
      ].filter(Boolean),
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    record('browser', `launched ${which} (${wantsReal ? 'your profile' : "Woboo's own profile"}) on port ${PORT}`);
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
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  await send('Page.enable');
  await send('Runtime.enable');
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

// Run JS in the page and get the value back.
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'script failed in the page');
  }
  return result.result?.value;
}

export function close() {
  try {
    socket?.close();
  } catch {
    // Already gone.
  }
  socket = null;
  pending.clear();
}

// ── what is on the page ───────────────────────────────────────────────────────

// Collect everything a person could interact with, each with a stable index and
// the text they would actually see. This replaces the screenshot: it is what the
// model reads to decide what to do, and it is a few kilobytes of text rather
// than a few hundred of image.
const COLLECT = `(() => {
  const out = [];
  const seen = new Set();
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox], [role=searchbox], [onclick], [contenteditable=true]';
  const label = (el) => (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.value ||
    (el.innerText || '').trim().replace(/\\s+/g, ' ') ||
    el.getAttribute('name') ||
    el.getAttribute('alt') || ''
  ).slice(0, 90);

  for (const el of document.querySelectorAll(sel)) {
    const box = el.getBoundingClientRect();
    // Skip what a person could not interact with either.
    const style = getComputedStyle(el);
    if (box.width < 2 || box.height < 2) continue;
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (el.disabled) continue;

    const text = label(el);
    if (!text && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') continue;
    const key = el.tagName + '|' + text + '|' + Math.round(box.top) + '|' + Math.round(box.left);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      i: out.length,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || el.getAttribute('role') || '',
      text,
      href: (el.getAttribute('href') || '').slice(0, 120),
      inView: box.top >= 0 && box.top < innerHeight,
      // What is currently IN the field. Without this the model cannot tell that
      // it already typed here, so it types again, and again — the page looks
      // identical to it every time.
      value: (el.value === undefined ? '' : String(el.value)).slice(0, 60),
      focused: el === document.activeElement,
    });
    el.setAttribute('data-woboo', String(out.length - 1));
    if (out.length >= 120) break;
  }
  return {
    url: location.href,
    title: document.title,
    elements: out,
    text: (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000),
  };
})()`;

export async function snapshot() {
  assertLive('browser');
  const page = await evaluate(COLLECT);
  record('browser', `read ${page.elements.length} elements on ${page.title || page.url}`.slice(0, 160));
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
  const result = await evaluate(`(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (!el) return { ok: false, error: 'element ${index} is no longer on the page' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, text: (el.innerText || el.value || '').slice(0, 60) };
  })()`);
  await settle();
  record('browser', result.ok ? `clicked ${index} "${result.text}"` : `click failed: ${result.error}`, {
    level: result.ok ? 'ok' : 'warn',
  });
  return result;
}

export async function type(index, text) {
  assertLive('browser');
  const escaped = JSON.stringify(String(text));
  const result = await evaluate(`(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]');
    if (!el) return { ok: false, error: 'field ${index} is no longer on the page' };
    el.focus();
    el.value = '';
    // Type through the setter React and friends listen to, or nothing updates.
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
    if (setter) setter.call(el, ${escaped}); else el.value = ${escaped};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
  record('browser', result.ok ? `typed into ${index}` : `type failed: ${result.error}`, {
    level: result.ok ? 'ok' : 'warn',
  });
  return result;
}

export async function pressEnter(index) {
  assertLive('browser');
  await evaluate(`(() => {
    const el = document.querySelector('[data-woboo="${Number(index)}"]') || document.activeElement;
    if (!el) return;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.form?.requestSubmit?.();
  })()`);
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
async function settle(timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    let now;
    try {
      now = await evaluate(`document.readyState + ':' + document.querySelectorAll('*').length`);
    } catch {
      // Mid-navigation the context is torn down; try again.
      continue;
    }
    if (now === last && String(now).startsWith('complete')) return;
    last = now;
  }
}
