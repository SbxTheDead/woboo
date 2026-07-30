// Woboo's hands: real keystrokes and real clicks into whatever is on screen.
// This is the most dangerous capability in the project, so it defaults to
// asking the owner every single time (settings.hands = 'ask').

import { loadSettings } from './config.mjs';
import { assertLive, requestApproval, onStop, Refused } from './guard.mjs';
import { script, isWindows } from './ps.mjs';
import { record } from './journal.mjs';

// SendKeys treats these as control characters, so they have to be braced.
function escapeSendKeys(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

function psLiteral(text) {
  return String(text).replace(/'/g, "''");
}

const MOUSE_SHIM = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WoboMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, int extra);
}
"@
`;

// ── driving sessions ──────────────────────────────────────────────────────────
// Operating a GUI takes dozens of clicks and keystrokes. Asking the owner to
// approve each one is unusable, and approving each one silently is not
// trustworthy — so the unit of consent is the *goal*, not the keystroke: one
// approval to drive the screen toward a stated objective, then free movement
// inside it. STOP still kills the session instantly, every act is still
// journalled, and the session ends when the step does.

let session = null;

export function drivingSession() {
  return session;
}

export async function openSession(purpose) {
  assertLive('drive the screen');
  const mode = loadSettings().hands;
  if (mode === 'off') throw new Refused('hands are disabled (settings.hands = "off")');

  if (mode === 'ask') {
    const granted = await requestApproval({
      kind: 'drive the screen',
      detail: purpose,
      reason: 'Woboo wants to use the mouse and keyboard until this goal is done',
    });
    if (!granted) throw new Refused('owner declined to let Woboo drive the screen');
  }

  session = { purpose, since: Date.now(), acts: 0 };
  record('hands', `driving session opened: ${purpose}`, { level: 'warn' });
  return session;
}

export function closeSession() {
  if (!session) return;
  record('hands', `driving session closed after ${session.acts} act(s)`, { level: 'ok' });
  session = null;
}

// A halt must not leave the hands authorised.
onStop(() => {
  session = null;
});

async function permit(action, detail) {
  assertLive(action);
  const mode = loadSettings().hands;
  if (mode === 'off') throw new Refused(`hands are disabled (settings.hands = "off")`);
  if (session) {
    session.acts += 1;
    return true;
  }
  if (mode === 'allow') return true;
  const granted = await requestApproval({ kind: action, detail, reason: 'hands are set to ask' });
  if (!granted) throw new Refused(`owner declined: ${action}`);
  return true;
}

function unsupported(action) {
  record('hands', `${action} is only implemented on Windows`, { level: 'warn' });
  return { ok: false, error: 'hands require Windows (PowerShell + user32)' };
}

export async function typeText(text) {
  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  await permit('type', preview);
  if (!isWindows()) return unsupported('type');

  const source = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${psLiteral(escapeSendKeys(text))}')
Write-Output typed
`;
  const result = await script(source, { action: 'type' });
  record('hands', `typed ${text.length} chars`, { level: result.ok ? 'ok' : 'error' });
  return { ok: result.ok, out: result.out };
}

// combo uses SendKeys syntax: '^s' is Ctrl+S, '%{F4}' is Alt+F4, '{ENTER}'.
export async function pressKey(combo) {
  await permit('press key', combo);
  if (!isWindows()) return unsupported('press key');

  const source = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${psLiteral(combo)}')
Write-Output pressed
`;
  const result = await script(source, { action: 'press key' });
  record('hands', `pressed ${combo}`, { level: result.ok ? 'ok' : 'error' });
  return { ok: result.ok, out: result.out };
}

// mouse_event flag pairs, down then up.
const BUTTONS = {
  left: ['0x0002', '0x0004'],
  right: ['0x0008', '0x0010'],
  middle: ['0x0020', '0x0040'],
};

export async function click(x, y, { button = 'left', count = 1 } = {}) {
  const times = Math.max(1, Math.min(3, Number(count) | 0));
  await permit('click', `${button}${times > 1 ? ` x${times}` : ''} at ${x},${y}`);
  if (!isWindows()) return unsupported('click');

  const [down, up] = BUTTONS[button] || BUTTONS.left;
  const pulses = Array.from(
    { length: times },
    () => `[WoboMouse]::mouse_event(${down}, 0, 0, 0, 0)
[WoboMouse]::mouse_event(${up}, 0, 0, 0, 0)
Start-Sleep -Milliseconds 30`,
  ).join('\n');

  const source = `
$ErrorActionPreference = 'Stop'
${MOUSE_SHIM}
[WoboMouse]::SetCursorPos(${Number(x) | 0}, ${Number(y) | 0})
Start-Sleep -Milliseconds 40
${pulses}
Write-Output clicked
`;
  const result = await script(source, { action: 'click' });
  record('hands', `${button}-clicked ${x},${y}${times > 1 ? ` (x${times})` : ''}`, {
    level: result.ok ? 'ok' : 'error',
  });
  return { ok: result.ok, out: result.out };
}

// Held-button primitives, so the model can do its own drag when it wants finer
// control than dragTo gives it.
export async function mouseDown(x, y, { button = 'left' } = {}) {
  await permit('press mouse', `${button} down at ${x},${y}`);
  if (!isWindows()) return unsupported('press mouse');
  const [down] = BUTTONS[button] || BUTTONS.left;
  const result = await script(
    `$ErrorActionPreference = 'Stop'
${MOUSE_SHIM}
[WoboMouse]::SetCursorPos(${Number(x) | 0}, ${Number(y) | 0})
[WoboMouse]::mouse_event(${down}, 0, 0, 0, 0)
Write-Output down`,
    { action: 'press mouse' },
  );
  return { ok: result.ok, out: result.out };
}

export async function mouseUp(x, y, { button = 'left' } = {}) {
  await permit('release mouse', `${button} up at ${x},${y}`);
  if (!isWindows()) return unsupported('release mouse');
  const [, up] = BUTTONS[button] || BUTTONS.left;
  const result = await script(
    `$ErrorActionPreference = 'Stop'
${MOUSE_SHIM}
[WoboMouse]::SetCursorPos(${Number(x) | 0}, ${Number(y) | 0})
[WoboMouse]::mouse_event(${up}, 0, 0, 0, 0)
Write-Output up`,
    { action: 'release mouse' },
  );
  return { ok: result.ok, out: result.out };
}

// Press, glide, release. The intermediate moves matter: apps that implement
// drag with mousemove handlers ignore a jump straight from origin to target.
export async function dragTo(from, to, { button = 'left' } = {}) {
  await permit('drag', `${from[0]},${from[1]} → ${to[0]},${to[1]}`);
  if (!isWindows()) return unsupported('drag');

  const [down, up] = BUTTONS[button] || BUTTONS.left;
  const steps = 12;
  const glide = Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    const x = Math.round(from[0] + (to[0] - from[0]) * t);
    const y = Math.round(from[1] + (to[1] - from[1]) * t);
    return `[WoboMouse]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 16`;
  }).join('\n');

  const result = await script(
    `$ErrorActionPreference = 'Stop'
${MOUSE_SHIM}
[WoboMouse]::SetCursorPos(${from[0] | 0}, ${from[1] | 0})
Start-Sleep -Milliseconds 40
[WoboMouse]::mouse_event(${down}, 0, 0, 0, 0)
${glide}
[WoboMouse]::mouse_event(${up}, 0, 0, 0, 0)
Write-Output dragged`,
    { action: 'drag', timeout: 45_000 },
  );
  record('hands', `dragged ${from[0]},${from[1]} → ${to[0]},${to[1]}`, {
    level: result.ok ? 'ok' : 'error',
  });
  return { ok: result.ok, out: result.out };
}

export async function scroll(x, y, direction = 'down', amount = 3) {
  await permit('scroll', `${direction} x${amount} at ${x},${y}`);
  if (!isWindows()) return unsupported('scroll');

  // WHEEL 0x0800 (vertical) / HWHEEL 0x1000 (horizontal). One notch is 120,
  // and the flag takes an unsigned int, so negatives wrap.
  const horizontal = direction === 'left' || direction === 'right';
  const flag = horizontal ? '0x1000' : '0x0800';
  const sign = direction === 'down' || direction === 'left' ? -1 : 1;
  const clicks = Math.max(1, Math.min(20, Number(amount) | 0));
  const delta = sign * 120;
  const unsigned = delta < 0 ? 4_294_967_296 + delta : delta;

  const pulses = Array.from(
    { length: clicks },
    () => `[WoboMouse]::mouse_event(${flag}, 0, 0, ${unsigned}, 0)
Start-Sleep -Milliseconds 25`,
  ).join('\n');

  const result = await script(
    `$ErrorActionPreference = 'Stop'
${MOUSE_SHIM}
[WoboMouse]::SetCursorPos(${Number(x) | 0}, ${Number(y) | 0})
Start-Sleep -Milliseconds 30
${pulses}
Write-Output scrolled`,
    { action: 'scroll', timeout: 45_000 },
  );
  record('hands', `scrolled ${direction} x${clicks}`, { level: result.ok ? 'ok' : 'error' });
  return { ok: result.ok, out: result.out };
}

export async function moveTo(x, y) {
  await permit('move pointer', `${x},${y}`);
  if (!isWindows()) return unsupported('move pointer');

  const source = `
$ErrorActionPreference = 'Stop'
${MOUSE_SHIM}
[WoboMouse]::SetCursorPos(${Number(x) | 0}, ${Number(y) | 0})
Write-Output moved
`;
  const result = await script(source, { action: 'move pointer' });
  return { ok: result.ok, out: result.out };
}

// Bring a window to the front by title fragment, so typing lands in the right
// place. Useful before delegating on-screen instead of through a CLI.
export async function focusWindow(titleFragment) {
  await permit('focus window', titleFragment);
  if (!isWindows()) return unsupported('focus window');

  const source = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WoboWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
}
"@
$match = Get-Process | Where-Object { $_.MainWindowTitle -like '*${psLiteral(titleFragment)}*' } | Select-Object -First 1
if ($null -eq $match) { Write-Output 'no window'; exit 1 }
[WoboWin]::ShowWindowAsync($match.MainWindowHandle, 9) | Out-Null
[WoboWin]::SetForegroundWindow($match.MainWindowHandle) | Out-Null
Write-Output $match.MainWindowTitle
`;
  const result = await script(source, { action: 'focus window' });
  record('hands', `focused "${result.out || titleFragment}"`, { level: result.ok ? 'ok' : 'warn' });
  return { ok: result.ok, out: result.out };
}

export function handsMode() {
  return loadSettings().hands;
}
