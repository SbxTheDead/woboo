// A tray icon, drawn from the same face and painted in the same state colour as
// the widget — so the taskbar tells you what Woboo is doing even when the
// companion is hidden. Encoded here rather than shipped as an asset: a 32×32
// PNG is a few hundred bytes of zlib, and a repo with no build step should not
// need a binary blob for two eyes and a mouth.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

const SIZE = 32;

function blot(pixels, x0, y0, x1, y1, rgba) {
  for (let y = Math.max(0, y0); y <= Math.min(SIZE - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(SIZE - 1, x1); x += 1) {
      const i = (y * SIZE + x) * 4;
      pixels[i] = rgba[0];
      pixels[i + 1] = rgba[1];
      pixels[i + 2] = rgba[2];
      pixels[i + 3] = rgba[3];
    }
  }
}

// The tray is 32 pixels of real estate, so this is the face reduced to what
// still reads at that size: two eyes and a mouth. Shape follows the state.
export function trayPng(color = '#58d68d', state = 'idle') {
  const [r, g, b] = hexToRgb(color);
  const ink = [r, g, b, 255];
  const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

  if (state === 'asleep' || state === 'stopped') {
    // Closed / flat eyes: a pair of bars.
    blot(pixels, 6, 14, 13, 16, ink);
    blot(pixels, 19, 14, 26, 16, ink);
  } else if (state === 'testing' || state === 'confused') {
    // Squint: shorter, thicker.
    blot(pixels, 7, 13, 13, 17, ink);
    blot(pixels, 19, 13, 25, 17, ink);
  } else if (state === 'error') {
    // Crosses, drawn as two diagonals per eye.
    for (let i = 0; i < 8; i += 1) {
      blot(pixels, 6 + i, 10 + i, 7 + i, 11 + i, ink);
      blot(pixels, 13 - i, 10 + i, 14 - i, 11 + i, ink);
      blot(pixels, 19 + i, 10 + i, 20 + i, 11 + i, ink);
      blot(pixels, 26 - i, 10 + i, 27 - i, 11 + i, ink);
    }
  } else {
    blot(pixels, 6, 9, 13, 20, ink);
    blot(pixels, 19, 9, 26, 20, ink);
  }

  if (state === 'happy') {
    blot(pixels, 10, 24, 22, 26, ink);
    blot(pixels, 8, 22, 10, 24, ink);
    blot(pixels, 22, 22, 24, 24, ink);
  } else {
    blot(pixels, 10, 24, 22, 26, ink);
  }

  // PNG wants each scanline prefixed with its filter byte; 0 means "none".
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0;
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
