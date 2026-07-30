// Woboo's face, as geometry. One source of truth shared by the desktop widget,
// the launcher and the browser console, so the companion on your desktop and the
// app can never drift into being two different characters.
//
// The grid, spacing and dot radius are lifted directly from assets/logo.svg —
// eyes are a 4x4 dot matrix with the corners dropped, the mouth is a seven-dot
// arc — so the rendered face, the logo and the 3D character are the same face
// at three levels of fidelity rather than three drawings that resemble each
// other. Expression is a dot pattern; that is the whole trick.
//
// Pure strings and numbers — no Node APIs, no DOM — so this same module runs in
// the Electron main process, a renderer, and a plain browser page.

export const VIEWBOX = '0 0 240 210';

// Straight from the logo: 9.4 units between dot centres, eyes centred on y=120,
// left eye at x=92 and right at x=148.
const STEP = 9.4;
const DOT = 3.1;
const EYE_Y = 120;
const LEFT_X = 92;
const RIGHT_X = 148;

// A 4x4 grid. '#' lights a dot. The default open eye drops its corners, which
// is what gives the character its rounded, friendly read at any size.
const EYES = {
  open: [
    ' ## ',
    '####',
    '####',
    ' ## ',
  ],
  wide: [
    '####',
    '####',
    '####',
    '####',
  ],
  // Lids down — the eye is closed, not absent.
  closed: [
    '    ',
    '    ',
    '####',
    '    ',
  ],
  // A flat bar: powered but not looking.
  flat: [
    '    ',
    '####',
    '    ',
    '    ',
  ],
  // Narrowed to two rows — the skeptical squint while a check runs.
  squint: [
    '    ',
    '####',
    '####',
    '    ',
  ],
  // An upward arc, the dot-matrix ^^.
  arc: [
    ' ## ',
    '#  #',
    '    ',
    '    ',
  ],
  cross: [
    '#  #',
    ' ## ',
    ' ## ',
    '#  #',
  ],
};

// Mouths are explicit dot runs rather than a grid: an arc reads better when the
// dots follow the curve instead of snapping to rows.
const MOUTHS = {
  // The logo's smile, dot for dot.
  smile: [
    [93.1, 154.9, 3.4], [99.4, 159.1, 2.6], [108.8, 162.0, 2.6], [120, 163.0, 2.6],
    [131.2, 162.0, 2.6], [140.6, 159.1, 2.6], [146.9, 154.9, 3.4],
  ],
  bigsmile: [
    [89, 150, 3.4], [95.5, 157, 3.0], [105, 162.5, 3.0], [120, 164.5, 3.0],
    [135, 162.5, 3.0], [144.5, 157, 3.0], [151, 150, 3.4],
  ],
  flat: [
    [103, 158, 2.6], [111.5, 158, 2.6], [120, 158, 2.6], [128.5, 158, 2.6], [137, 158, 2.6],
  ],
  small: [
    [115, 158, 2.8], [125, 158, 2.8],
  ],
  oh: [
    [120, 151, 2.6], [128, 155, 2.6], [130, 162, 2.6], [120, 166, 2.6],
    [110, 162, 2.6], [112, 155, 2.6],
  ],
  frown: [
    [95, 163, 3.0], [104, 158, 2.6], [112, 155.5, 2.6], [120, 155, 2.6],
    [128, 155.5, 2.6], [136, 158, 2.6], [145, 163, 3.0],
  ],
  // Unsure — a wobble rather than a curve.
  wave: [
    [98, 159, 2.6], [107, 154.5, 2.6], [116, 159, 2.6], [124, 154.5, 2.6],
    [133, 159, 2.6], [142, 154.5, 2.6],
  ],
};

// Every entry is one of the ten states face.mjs can publish. Nothing here is
// decorative: if Woboo is squinting, a verify command is genuinely running.
export const FACES = {
  asleep:    { eye: 'closed', mouth: 'small',    deco: 'zzz' },
  idle:      { eye: 'open',   mouth: 'smile',    blink: true },
  listening: { eye: 'wide',   mouth: 'oh',       blink: true, deco: 'ears' },
  thinking:  { eye: 'open',   mouth: 'flat',     blink: true, look: [0, -1], deco: 'dots' },
  working:   { eye: 'open',   mouth: 'flat',     blink: true, look: [0, 1] },
  testing:   { eye: 'squint', mouth: 'flat',     look: [1, 0] },
  happy:     { eye: 'arc',    mouth: 'bigsmile' },
  confused:  { eye: 'open',   eye2: 'squint',    mouth: 'wave', look: [-1, 0], deco: 'question' },
  error:     { eye: 'cross',  mouth: 'frown' },
  stopped:   { eye: 'flat',   mouth: 'flat',     deco: 'bang' },
};

// The palette is the brand's: warm amber through coral, never leaving the
// family. Colour is the fastest read on the widget — you catch it from across
// the room before you can focus on the eyes.
export const COLORS = {
  asleep: '#7A4A2C',
  idle: '#FFB55C',
  listening: '#FFD9A0',
  thinking: '#FF9264',
  working: '#FFB55C',
  testing: '#FF9264',
  happy: '#FFC978',
  confused: '#FF9264',
  error: '#FF5A3D',
  stopped: '#FF5A3D',
};

function dot(x, y, r = DOT) {
  return `<circle class="px" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`;
}

// Render a 4x4 pattern around a centre, optionally nudged one cell to show
// where the eyes are pointing.
function eye(kind, cx, look) {
  const rows = EYES[kind] || EYES.open;
  const [dx, dy] = look || [0, 0];
  const originX = cx - STEP * 1.5 + dx * (STEP * 0.34);
  const originY = EYE_Y - STEP * 1.5 + dy * (STEP * 0.34);

  let out = '';
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      if (rows[r][c] !== '#') continue;
      out += dot(originX + c * STEP, originY + r * STEP);
    }
  }
  return out;
}

function mouth(kind) {
  const dots = MOUTHS[kind] || MOUTHS.flat;
  return dots.map(([x, y, r]) => dot(x, y, r)).join('');
}

function deco(kind) {
  if (kind === 'zzz') {
    return '<g class="deco">' +
      '<text class="snore" x="188" y="96">z</text>' +
      '<text class="snore" x="199" y="84" style="animation-delay:1s">z</text>' +
      '<text class="snore" x="210" y="72" style="animation-delay:2s">z</text></g>';
  }
  if (kind === 'dots') {
    return '<g class="think">' + [104, 120, 136].map((x, i) =>
      `<circle class="px" cx="${x}" cy="78" r="3.4" style="animation-delay:${i * 0.2}s"/>`).join('') + '</g>';
  }
  if (kind === 'question') return '<text class="deco" x="196" y="92">?</text>';
  if (kind === 'bang') return '<text class="deco" x="200" y="92">!</text>';
  if (kind === 'ears') {
    return '<g class="pulse">' +
      '<circle class="px" cx="28" cy="120" r="3.4"/><circle class="px" cx="28" cy="132" r="3.4"/>' +
      '<circle class="px" cx="212" cy="120" r="3.4"/><circle class="px" cx="212" cy="132" r="3.4"/></g>';
  }
  return '';
}

// The inner markup for an <svg viewBox={VIEWBOX}>. The caller owns the chassis:
// the widget draws a head around it, the console draws a screen.
export function faceSvg(state) {
  const name = FACES[state] ? state : 'idle';
  const spec = FACES[name];
  const eyes =
    `<g class="eyes${spec.blink ? ' blink' : ''}">` +
    eye(spec.eye, LEFT_X, spec.look) +
    eye(spec.eye2 || spec.eye, RIGHT_X, spec.look) +
    '</g>';
  return eyes + mouth(spec.mouth) + deco(spec.deco);
}

export function faceColor(state) {
  return COLORS[state] || COLORS.idle;
}

// Shared so every surface animates identically. `--fc` is the only hook a
// consumer needs to set; the glow is what sells the dots as lit pixels rather
// than printed ink.
export const FACE_CSS = `
  .px { fill: var(--fc); filter: drop-shadow(0 0 4px var(--fc)); }
  .deco { fill: var(--fc); font: 700 24px ui-monospace, monospace; }

  .eyes { transform-origin: 120px 120px; }
  .blink { animation: blink 5.4s infinite; }
  @keyframes blink {
    0%, 93%, 100% { transform: scaleY(1); }
    96% { transform: scaleY(.12); }
  }
  .think circle { animation: think 1.4s infinite; }
  @keyframes think { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
  .snore { animation: snore 3s ease-in-out infinite; }
  @keyframes snore {
    0% { opacity: 0; transform: translate(0, 4px); }
    40% { opacity: .9; }
    100% { opacity: 0; transform: translate(7px, -16px); }
  }
  .pulse { animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
`;
