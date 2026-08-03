// The desktop companion. A frameless, transparent, always-on-top Woboo that sits
// on your desktop and reacts to what it is actually doing.
//
// This process imports the same modules the CLI does — foreman, guard, face,
// bus — so the widget is a face on the real body, not a remote control talking
// to a server. The HTTP panel is still available from the tray, but the widget
// never needs it.
//
// The renderer is deliberately dumb: Chromium refuses ES-module imports over
// file://, so instead of shipping module plumbing into the window, this process
// renders the face to SVG and hands the markup across. The renderer only draws.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { loadSettings, saveSettings, loadSecrets, PATHS } from '../src/config.mjs';
import { listen } from '../src/server.mjs';
import * as telegram from '../src/telegram.mjs';
import { subscribe } from '../src/bus.mjs';
import { tail, record } from '../src/journal.mjs';
import { face } from '../src/face.mjs';
import { faceSvg, faceColor, FACE_CSS, VIEWBOX } from '../src/faceart.mjs';
import { trayPng } from './icon.mjs';
import * as guard from '../src/guard.mjs';
import * as foreman from '../src/foreman.mjs';
import * as crew from '../src/crew.mjs';
import * as brain from '../src/brain.mjs';
import * as eyes from '../src/eyes.mjs';

// `import ... from 'electron'` is a trap in an ESM main process: the resolver
// finds the npm package in node_modules — a shim whose only export is the path
// to the binary — instead of Electron's built-in module. Electron patches CJS
// require, so going through createRequire is what actually reaches the real API.
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, nativeImage } =
  createRequire(import.meta.url)('electron');

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Two footprints: a head you can leave on the desktop, and a panel that opens
// when there is something to say. The window is resized rather than made large
// and transparent, so idle Woboo never sits on top of a big invisible click trap.
const COMPACT = { width: 236, height: 252 };
const EXPANDED = { width: 344, height: 486 };

let win = null;
let splash = null;
let console_ = null; // the full app window
let tray = null;
let panel = null; // the local server behind the console window
let mode = 'compact';

// ── launcher ──────────────────────────────────────────────────────────────────
// A splash that shows the real boot rather than a stand-in progress bar: each
// line appears when that check actually finished.

function createSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 340,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    center: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    // Shown immediately rather than waiting on 'ready-to-show': that event is
    // unreliable for a transparent frameless window, and a window that never
    // shows is worse than a frame of empty transparency.
    show: true,
    webPreferences: {
      // preload.cjs only touches contextBridge and ipcRenderer, which is
      // exactly the API a sandboxed preload gets — so the sandbox stays on.
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.loadFile(path.join(HERE, 'splash.html'));
  // Boot can outrun the renderer. Anything sent before it is listening would be
  // dropped on the floor, so hold the lines until the page says it is there.
  splash.webContents.once('did-finish-load', () => {
    splashReady = true;
    for (const step of bootQueue) splash.webContents.send('woboo:boot', step);
    bootQueue.length = 0;
  });
  splash.on('closed', () => {
    splash = null;
  });
  return splash;
}

let splashReady = false;
const bootQueue = [];

function bootStep(label, detail = '', level = 'ok') {
  const step = { label, detail, level };
  if (!splash || splash.isDestroyed()) return;
  if (splashReady) splash.webContents.send('woboo:boot', step);
  else bootQueue.push(step);
}

// ── console ───────────────────────────────────────────────────────────────────
// The full window. It loads the same dashboard the browser panel serves, so
// there is exactly one implementation of it — the app just gives it a frame.

function createConsole(url) {
  if (console_ && !console_.isDestroyed()) {
    console_.show();
    console_.focus();
    return console_;
  }

  console_ = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    // backgroundColor covers the load, so there is no white flash to hide behind
    // a deferred show — and no way for the window to get stuck invisible.
    show: true,
    backgroundColor: '#0b0e0d',
    icon: appIcon(),
    title: 'Woboo',
    // A dark native title bar rather than the default light chrome — the
    // difference between "an Electron page" and "an app".
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1512', symbolColor: '#8fb8a4', height: 38 },
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  console_.loadURL(url);
  console_.webContents.once('did-finish-load', () => {
    if (console_ && !console_.isDestroyed()) console_.focus();
  });
  console_.on('closed', () => {
    console_ = null;
  });
  // Links out of the dashboard belong in the real browser, not in this window.
  console_.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  return console_;
}

function appIcon() {
  try {
    return nativeImage.createFromBuffer(trayPng(faceColor('idle'), 'idle'));
  } catch {
    return undefined;
  }
}

// ── window ────────────────────────────────────────────────────────────────────

function corner(size) {
  const { workArea } = screen.getPrimaryDisplay();
  const saved = loadSettings().widget;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    return { x: saved.x, y: saved.y };
  }
  return {
    x: Math.round(workArea.x + workArea.width - size.width - 24),
    y: Math.round(workArea.y + workArea.height - size.height - 24),
  };
}

function createWindow() {
  const spot = corner(COMPACT);

  win = new BrowserWindow({
    ...COMPACT,
    ...spot,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // A companion should not steal focus every time it changes expression.
    focusable: true,
    webPreferences: {
      // Same preload as the splash: contextBridge and ipcRenderer only, so the
      // renderer runs sandboxed.
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(HERE, 'widget.html'));

  // Remember where it was left, anchored by the corner the user dragged it to.
  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    saveSettings({ widget: { x, y, mode } });
  };
  win.on('moved', remember);
  win.on('closed', () => {
    win = null;
  });
}

// Grow and shrink around the bottom-right corner, so a widget parked at the
// edge of the screen expands inward instead of walking off it.
function setMode(next) {
  if (!win || win.isDestroyed() || next === mode) return;
  const target = next === 'expanded' ? EXPANDED : COMPACT;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();

  const { workArea } = screen.getPrimaryDisplay();
  let nextX = x + w - target.width;
  let nextY = y + h - target.height;
  nextX = Math.max(workArea.x, Math.min(nextX, workArea.x + workArea.width - target.width));
  nextY = Math.max(workArea.y, Math.min(nextY, workArea.y + workArea.height - target.height));

  mode = next;
  win.setBounds({ x: Math.round(nextX), y: Math.round(nextY), ...target }, false);
}

// ── talking to the renderer ───────────────────────────────────────────────────

function paint(state, note = '') {
  return { state, note, svg: faceSvg(state), color: faceColor(state) };
}

function toRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function snapshot() {
  const current = face();
  return {
    face: paint(current.state, current.note),
    mission: foreman.currentMission(),
    busy: foreman.isBusy(),
    guard: { stopped: guard.isStopped(), reason: guard.stopReason() },
    approvals: guard.pendingApprovals(),
    settings: loadSettings(),
    brain: { ...brain.status(), installed: brain.installed() },
    crew: await crew.discover(),
    log: tail(60),
    css: FACE_CSS,
    viewBox: VIEWBOX,
    home: PATHS.home,
  };
}

// ── tray ──────────────────────────────────────────────────────────────────────

function trayImage(state) {
  return nativeImage.createFromBuffer(trayPng(faceColor(state), state));
}

function buildTray() {
  try {
    tray = new Tray(trayImage('idle'));
  } catch {
    // No tray on this desktop; the widget alone is still fully usable.
    return;
  }

  const refresh = () => {
    if (!tray || tray.isDestroyed()) return;
    const stopped = guard.isStopped();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Woboo', click: () => win?.show() },
        { label: 'Hide Woboo', click: () => win?.hide() },
        { type: 'separator' },
        {
          label: stopped ? 'Release STOP' : 'STOP',
          click: () => (stopped ? guard.clearStop() : guard.engageStop('owner pressed STOP (tray)')),
        },
        { label: 'Look at the screen', click: () => eyes.screenshot({ reason: 'tray' }) },
        { type: 'separator' },
        { label: 'Open Woboo console', click: () => openPanel() },
        { label: 'Open in browser…', click: () => openPanel({ external: true }) },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  };

  tray.setToolTip('Woboo — idle');
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()));
  refresh();
  return refresh;
}

// The console window is the expanded view. The same page is also reachable in a
// real browser, for when you want it on a second screen.
async function openPanel({ external = false } = {}) {
  try {
    if (!panel) panel = await listen({});
    if (external) shell.openExternal(panel.url);
    else createConsole(panel.url);
  } catch (err) {
    toRenderer('woboo:toast', err.message);
  }
}

// ── ipc ───────────────────────────────────────────────────────────────────────

function wireIpc() {
  ipcMain.handle('woboo:snapshot', () => snapshot());

  ipcMain.on('woboo:mode', (_event, next) => setMode(next === 'expanded' ? 'expanded' : 'compact'));

  ipcMain.on('woboo:task', (_event, task) => {
    const text = String(task || '').trim();
    if (!text) return;
    if (foreman.isBusy()) return toRenderer('woboo:toast', 'Woboo is already on a mission.');
    if (guard.isStopped()) return toRenderer('woboo:toast', `STOP is engaged: ${guard.stopReason()}`);
    setMode('expanded');
    foreman.runMission(text).catch((err) => toRenderer('woboo:toast', err.message));
    return undefined;
  });

  ipcMain.on('woboo:stop', () => guard.engageStop('owner pressed STOP (widget)'));
  ipcMain.on('woboo:resume', () => guard.clearStop());
  ipcMain.on('woboo:approve', (_event, { id, decision }) => guard.resolveApproval(id, decision));
  ipcMain.on('woboo:hide', () => win?.hide());
  ipcMain.on('woboo:quit', () => app.quit());
  // Wrapped, not passed directly: ipcMain hands the listener an event object,
  // which would land in openPanel's options argument.
  ipcMain.on('woboo:panel', () => openPanel());

  ipcMain.on('woboo:look', async () => {
    const shot = await eyes.screenshot({ reason: 'widget' });
    if (!shot.ok) toRenderer('woboo:toast', shot.error || 'screen capture unavailable');
  });
}

// ── boot ──────────────────────────────────────────────────────────────────────

// Two Woboos on one desktop would fight over STOP and the journal.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    win?.show();
    win?.focus();
  });

  app.whenReady().then(async () => {
    wireIpc();
    createSplash();

    // ── boot ────────────────────────────────────────────────────────────────
    // Real checks, surfaced as they complete. Nothing here is decorative: if a
    // line says the crew is missing, the crew is missing.
    const settled = (ms) => new Promise((r) => setTimeout(r, ms));
    await settled(500); // let the splash paint before the first line lands

    // Every probe below is wrapped. A boot check that fails is information to
    // put on the splash, never a reason to leave the owner staring at it — and
    // the app must start even when Woboo is forbidden from acting, or STOP
    // becomes a lockout: it blocks the boot, and releasing it needs the app.
    const probe = async (label, fn, describe) => {
      try {
        const value = await fn();
        const [detail, level] = describe(value);
        bootStep(label, detail, level || 'ok');
        return value;
      } catch (err) {
        bootStep(label, err.message.slice(0, 44), 'warn');
        return null;
      }
    };

    loadSecrets();
    bootStep('waking up', path.basename(PATHS.home));
    await settled(160);

    // Say it first and plainly: nothing else on the list matters while it holds.
    if (guard.isStopped()) {
      bootStep('STOP is engaged', guard.stopReason().slice(0, 40) || 'release it to work', 'warn');
      await settled(160);
    }

    await probe('crew', () => crew.discover(), (members) => {
      const ready = (members || []).filter((m) => m.available);
      return ready.length
        ? [ready.map((m) => m.label).join(', '), 'ok']
        : ['no coding tool — delegate steps disabled', 'warn'];
    });
    await settled(160);

    await probe('brain', async () => brain.status(), (state) =>
      state?.credentials ? [state.model, 'ok'] : ['offline — deterministic plans', 'warn'],
    );
    await settled(160);

    await probe('eyes', () => eyes.screenSize(), (screen_) =>
      screen_?.ok ? [`${screen_.width}x${screen_.height}`, 'ok'] : ['unavailable', 'warn'],
    );
    await settled(160);

    let consoleUrl = null;
    try {
      panel = await listen({});
      consoleUrl = panel.url;
      bootStep('console ready', `127.0.0.1:${panel.port}`);
    } catch (err) {
      bootStep('console unavailable', err.message, 'warn');
    }
    await settled(160);

    const secrets = loadSecrets();
    if (secrets.telegramToken) {
      // Keep trying, and say so somewhere it can still be read afterwards.
      //
      // This gave up after a single attempt and reported the failure only on
      // the splash screen, which is gone two seconds later. One refused
      // connection at boot — the wifi not quite up — meant no phone control for
      // the whole session, with nothing in the journal to explain it. What the
      // owner saw was "the telegram bot dont work now" and no way to find out
      // why.
      const connect = async () => {
        for (let attempt = 1; attempt <= 20; attempt += 1) {
          try {
            const bot = await telegram.start({ token: secrets.telegramToken });
            if (attempt > 1) record('telegram', `connected on attempt ${attempt}`, { level: 'ok' });
            bootStep('phone reachable', `@${bot.username}`);
            return;
          } catch (err) {
            record('telegram', `could not start (attempt ${attempt}): ${err.message}`, { level: 'warn' });
            if (attempt === 1) bootStep('phone not up yet', 'retrying in the background', 'warn');
            await new Promise((r) => setTimeout(r, Math.min(60_000, attempt * 5000)));
          }
        }
        record('telegram', 'gave up starting the bot after 20 attempts', { level: 'error' });
      };
      // Deliberately not awaited: a bot that cannot connect must not hold up
      // the desktop, and this used to block the rest of the boot.
      connect();
    } else {
      bootStep('phone not linked', 'woboo secret telegram', 'warn');
    }

    bootStep('', '', 'ok');
    if (splash && !splash.isDestroyed()) splash.webContents.send('woboo:boot', { done: true });
    await settled(700);

    // ── open ────────────────────────────────────────────────────────────────
    createWindow();
    if (consoleUrl) createConsole(consoleUrl);

    // Window creation can succeed while the window never becomes visible —
    // transparency, an off-screen bound, a 'ready-to-show' that never fires.
    // That failure is otherwise silent: no error, just a blank desktop. So say
    // so, and only when something is actually wrong.
    for (const [name, ref, expected] of [
      ['widget', win, true],
      ['console', console_, Boolean(consoleUrl)],
    ]) {
      if (!expected) continue;
      if (!ref || ref.isDestroyed()) {
        record('app', `${name} window was not created`, { level: 'error' });
      } else if (!ref.isVisible()) {
        const b = ref.getBounds();
        record('app', `${name} window exists but is not visible (${b.width}x${b.height} at ${b.x},${b.y})`, {
          level: 'error',
        });
      }
    }

    if (splash && !splash.isDestroyed()) splash.close();

    const refreshTray = buildTray();

    // The bus is the single source of truth; the widget and the tray are both
    // just subscribers, exactly like the browser panel.
    subscribe((event) => {
      if (event.type === 'face') {
        const painted = paint(event.state, event.note);
        toRenderer('woboo:face', painted);
        if (tray && !tray.isDestroyed()) {
          tray.setImage(trayImage(event.state));
          tray.setToolTip(`Woboo — ${event.state}${event.note ? `: ${event.note}` : ''}`);
        }
        return;
      }

      if (event.type === 'approval') {
        // An unanswered request auto-denies, so make sure it can actually be seen.
        setMode('expanded');
        win?.showInactive();
      }
      if (event.type === 'guard' && refreshTray) refreshTray();

      toRenderer('woboo:event', event);
    });

    // Hover detection has to live out here. The head is a `-webkit-app-region:
    // drag` surface so you can throw the widget around the screen, and Chromium
    // hands those regions to the window manager — no mousemove ever reaches the
    // document. Polling the OS cursor against the window bounds is immune to
    // that. The renderer still decides what to do with it, because that is where
    // the "don't collapse mid-mission" rules live.
    let hovering = false;
    const watchCursor = setInterval(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const point = screen.getCursorScreenPoint();
      const box = win.getBounds();
      const inside =
        point.x >= box.x && point.x < box.x + box.width &&
        point.y >= box.y && point.y < box.y + box.height;
      if (inside === hovering) return;
      hovering = inside;
      toRenderer('woboo:hover', inside);
    }, 160);
    if (typeof watchCursor.unref === 'function') watchCursor.unref();

    foreman.startIdleWatch();
  }).catch((err) => {
    // The last line of defence. Whatever went wrong during boot, the owner ends
    // up with a working app rather than a splash screen that never leaves —
    // they can read the journal, press STOP, or fix the thing that broke. An
    // app that will not open is worse than one that opens with a warning.
    record('app', `boot failed: ${err.message}`, { level: 'error' });
    try {
      if (splash && !splash.isDestroyed()) splash.close();
      if (!win) createWindow();
      buildTray();
    } catch {
      // If even this fails there is nothing sensible left to try.
    }
  });

  // The widget is the app: closing the window should not leave a ghost process,
  // but hiding it to the tray should not quit either.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (panel?.server) panel.server.close();
  });
}
