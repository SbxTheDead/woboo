// Keyboard combos. SendKeys could not press the Windows key at all — Woboo
// typed the literal text "{WINDOWS}" into whatever had focus — so combos are
// parsed here into virtual key codes and pressed through keybd_event.
//
// The codes are asserted rather than the names, because the codes are what
// actually reaches the operating system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCombo } from '../src/hands.mjs';

const CTRL = 17;
const SHIFT = 16;
const ALT = 18;
const WIN = 91;
const ch = (c) => c.toUpperCase().charCodeAt(0);

const CASES = [
  // "win" alone is a real instruction: open Start. It is a modifier with
  // nothing to modify, and it used to parse to nothing at all.
  ['win', [], WIN],
  ['windows key', [], WIN],
  ['ctrl+c', [CTRL], ch('c')],
  ['ctrl+shift+esc', [CTRL, SHIFT], 27],
  ['alt+tab', [ALT], 9],
  ['win+r', [WIN], ch('r')],
  ['f7', [], 118],
  ['enter', [], 13],
  ['CTRL+ALT+DEL', [CTRL, ALT], 46],
  ['ctrl + s', [CTRL], ch('s')],
  ['control+c', [CTRL], ch('c')],
  ['cmd+c', [WIN], ch('c')],
  // The planner writes prose as often as it writes combos.
  ['press the F7 key', [], 118],
  ['{ENTER}', [], 13],
];

test('parses every combo Woboo is asked to press', () => {
  const wrong = [];
  for (const [input, mods, main] of CASES) {
    const got = parseCombo(input);
    if (!got) {
      wrong.push(`${input} -> nothing`);
      continue;
    }
    if (got.main !== main || got.mods.join(',') !== mods.join(',')) {
      wrong.push(`${input} -> [${got.mods}] ${got.main}, wanted [${mods}] ${main}`);
    }
  }
  assert.equal(wrong.length, 0, `\n  ${wrong.join('\n  ')}`);
});

test('nonsense does not become a keystroke', () => {
  // Better to press nothing than to press something arbitrary into whatever
  // window the owner happens to have focused.
  for (const junk of ['', '   ', '+', '++', null, undefined]) {
    assert.equal(parseCombo(junk), null, `${JSON.stringify(junk)} produced a keystroke`);
  }
});
