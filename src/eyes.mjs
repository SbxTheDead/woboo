// Woboo's eyes. A screenshot is how it checks the real screen instead of
// trusting what a tool claimed — the software stand-in for the HDMI capture on
// the hardware version.
//
// No native modules: on Windows this is .NET via PowerShell, which is always
// present. macOS gets screencapture, Linux gets ImageMagick if installed.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureHome } from './config.mjs';
import { script, isWindows } from './ps.mjs';
import { publish } from './bus.mjs';
import { record } from './journal.mjs';

const WINDOWS_CAPTURE = (target) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
Write-Output ("{0}x{1}" -f $bounds.Width, $bounds.Height)
`;

let lastShot = null;

export function latestShot() {
  return lastShot;
}

export async function screenshot({ reason = '' } = {}) {
  ensureHome();
  const target = path.join(PATHS.shots, `screen-${Date.now()}.png`);

  let source;
  if (isWindows()) {
    source = WINDOWS_CAPTURE(target);
  } else if (process.platform === 'darwin') {
    source = `screencapture -x "${target}" && echo captured`;
  } else {
    source = `import -window root "${target}" 2>/dev/null && echo captured`;
  }

  const result = await script(source, { action: 'screenshot' });
  if (!result.ok || !fs.existsSync(target)) {
    record('eyes', `screen capture unavailable: ${result.out || 'no output'}`, { level: 'warn' });
    return { ok: false, error: result.out || 'capture failed' };
  }

  // Keep the shot directory from growing without bound across long sessions.
  prune();

  lastShot = { path: target, at: Date.now(), reason, size: result.out };
  record('eyes', `looked at the screen${reason ? ` (${reason})` : ''}`, { level: 'ok' });
  publish({ type: 'shot', at: lastShot.at, reason });
  return { ok: true, ...lastShot };
}

// ── seeing, for the brain ─────────────────────────────────────────────────────
// A capture the model can actually look at: base64 PNG plus the scale factor
// between what it sees and what is really on screen.
//
// Claude returns coordinates for the image it was given. The API silently
// downscales anything oversized before the model sees it — which would leave us
// clicking the wrong pixels with no way to know by how much. So we do the
// resizing here, where we can keep the factor and map coordinates back.
//
// Opus 5 accepts 2576px on the long edge and ~3.75MP total, so an ordinary
// 1920x1080 desktop goes across untouched at scale 1.

const LONG_EDGE_MAX = 2576;
const PIXELS_MAX = 3_750_000;

export function scaleFor(width, height) {
  const longEdge = Math.max(width, height);
  return Math.min(1, LONG_EDGE_MAX / longEdge, Math.sqrt(PIXELS_MAX / (width * height)));
}

const WINDOWS_CAPTURE_SCALED = (target, scale) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$shot = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($shot)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$w = [int]($bounds.Width * ${scale}); $h = [int]($bounds.Height * ${scale})
if ($w -lt 1) { $w = 1 }; if ($h -lt 1) { $h = 1 }
if ($w -ne $bounds.Width -or $h -ne $bounds.Height) {
  $small = New-Object System.Drawing.Bitmap $w, $h
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($shot, 0, 0, $w, $h)
  $small.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
  $g2.Dispose(); $small.Dispose()
} else {
  $shot.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
}
$gfx.Dispose(); $shot.Dispose()
Write-Output ("{0} {1} {2} {3}" -f $w, $h, $bounds.Width, $bounds.Height)
`;

// Crop a region of the real screen at full resolution — the model's "zoom",
// for reading small text it cannot resolve in a full-screen shot.
const WINDOWS_CROP = (target, x, y, w, h) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$shot = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($shot)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$rect = New-Object System.Drawing.Rectangle ${x}, ${y}, ${w}, ${h}
$crop = $shot.Clone($rect, $shot.PixelFormat)
$crop.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose(); $gfx.Dispose(); $shot.Dispose()
Write-Output ("{0} {1}" -f ${w}, ${h})
`;

// Naming a labelled cell is a far easier question than guessing a pixel, and
// vision models that cannot ground a coordinate can still read a label. The grid
// turns "where is the button" from a regression problem into a multiple choice
// one — which is the difference between a model that can drive a screen and one
// that only describes it.
export const GRID = { cols: 20, rows: 12 };
const COL_NAMES = 'ABCDEFGHIJKLMNOPQRST';

const WINDOWS_GRID = (target, scale, cols, rows) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$shot = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$gfx = [System.Drawing.Graphics]::FromImage($shot)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

$w = [int]($bounds.Width * ${scale}); $h = [int]($bounds.Height * ${scale})
$canvas = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($canvas)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($shot, 0, 0, $w, $h)

$cw = $w / ${cols}; $ch = $h / ${rows}
$line = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 255, 90, 40)), 1
$font = New-Object System.Drawing.Font 'Consolas', 11, ([System.Drawing.FontStyle]::Bold)
$ink  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 170, 60))
$pad  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 0, 0, 0))
$names = '${COL_NAMES}'

for ($c = 0; $c -lt ${cols}; $c++) { $g2.DrawLine($line, [int]($c*$cw), 0, [int]($c*$cw), $h) }
for ($r = 0; $r -lt ${rows}; $r++) { $g2.DrawLine($line, 0, [int]($r*$ch), $w, [int]($r*$ch)) }
for ($c = 0; $c -lt ${cols}; $c++) {
  for ($r = 0; $r -lt ${rows}; $r++) {
    $label = $names[$c] + [string]($r + 1)
    $x = [int]($c*$cw) + 2; $y = [int]($r*$ch) + 1
    $g2.FillRectangle($pad, $x, $y, 26, 15)
    $g2.DrawString($label, $font, $ink, $x, $y)
  }
}
$canvas.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$line.Dispose(); $font.Dispose(); $ink.Dispose(); $pad.Dispose()
$g2.Dispose(); $canvas.Dispose(); $gfx.Dispose(); $shot.Dispose()
Write-Output ("{0} {1} {2} {3}" -f $w, $h, $bounds.Width, $bounds.Height)
`;

// Turn "F7" back into the real pixel at the centre of that cell.
export function cellToPixel(cell, screen) {
  const match = /^([A-T])(\d{1,2})$/i.exec(String(cell || '').trim());
  if (!match) return null;
  const col = COL_NAMES.indexOf(match[1].toUpperCase());
  const row = Number(match[2]) - 1;
  if (col < 0 || row < 0 || row >= GRID.rows) return null;
  const cw = screen.width / GRID.cols;
  const ch = screen.height / GRID.rows;
  return [Math.round(col * cw + cw / 2), Math.round(row * ch + ch / 2)];
}

export async function capture({ reason = '', region = null, grid = false } = {}) {
  ensureHome();
  const target = path.join(PATHS.shots, `frame-${Date.now()}.png`);

  if (!isWindows()) {
    // The plain capture path still works elsewhere; only the scaling maths here
    // is Windows-specific.
    const shot = await screenshot({ reason });
    if (!shot.ok) return shot;
    return { ok: true, base64: fs.readFileSync(shot.path).toString('base64'), scale: 1 };
  }

  let source;
  let expected = null;
  if (region) {
    const [x1, y1, x2, y2] = region;
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    source = WINDOWS_CROP(target, x1 | 0, y1 | 0, w | 0, h | 0);
    expected = { region: true };
  } else {
    // Measure first so the scale factor is known before the pixels are resized.
    const size = await screenSize();
    if (!size.ok) return { ok: false, error: size.error };
    const scale = scaleFor(size.width, size.height);
    source = grid
      ? WINDOWS_GRID(target, scale, GRID.cols, GRID.rows)
      : WINDOWS_CAPTURE_SCALED(target, scale);
  }

  const result = await script(source, { action: 'capture', timeout: 45_000 });
  if (!result.ok || !fs.existsSync(target)) {
    record('eyes', `capture failed: ${result.out || 'no output'}`, { level: 'warn' });
    return { ok: false, error: result.out || 'capture failed' };
  }

  const [w, h, realW, realH] = result.out.trim().split(/\s+/).map(Number);
  const base64 = fs.readFileSync(target).toString('base64');
  prune();

  lastShot = { path: target, at: Date.now(), reason, size: `${w}x${h}` };
  publish({ type: 'shot', at: lastShot.at, reason });

  return {
    ok: true,
    base64,
    path: target,
    width: w,
    height: h,
    // How to get from a coordinate the model gives us back to a real pixel.
    scale: expected?.region ? 1 : (realW ? w / realW : 1),
    screen: expected?.region ? null : { width: realW, height: realH },
  };
}

export async function screenSize() {
  if (!isWindows()) return { ok: false, error: 'screen size is Windows-only' };
  const result = await script(
    `Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output ("{0} {1}" -f $b.Width, $b.Height)`,
    { action: 'screen size', timeout: 15_000 },
  );
  if (!result.ok) return { ok: false, error: result.out };
  const [width, height] = result.out.trim().split(/\s+/).map(Number);
  return { ok: true, width, height };
}

function prune(keep = 12) {
  try {
    const files = fs
      .readdirSync(PATHS.shots)
      .filter((f) => f.endsWith('.png'))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
      fs.unlinkSync(path.join(PATHS.shots, stale));
    }
  } catch {
    // Pruning is housekeeping; never let it break a capture.
  }
}
