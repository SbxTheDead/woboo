// The pilot: Woboo actually operating the machine like a person would.
//
// Everything else in Woboo delegates typing to a coding tool. This is the part
// that doesn't — it looks at the real screen, decides where to click, clicks
// there, then looks again. Open a browser, search for something, poke around
// VS Code's extension list: work that has no command-line equivalent.
//
//   capture → model sees pixels → returns an action → hands perform it → capture
//
// Two things keep it honest:
//   * Coordinates come back in the model's image space. We do the downscaling
//     ourselves rather than letting the API do it silently, so the scale factor
//     is known and every coordinate maps back to a real pixel.
//   * Consent is per-goal, not per-click (see hands.openSession). STOP still
//     kills it mid-stride, and every act lands in the journal.

import { loadSettings } from './config.mjs';
import { record } from './journal.mjs';
import { publish } from './bus.mjs';
import { setFace } from './face.mjs';
import { assertLive, Refused } from './guard.mjs';
import { getClient, hasCredentials } from './brain.mjs';
import * as eyes from './eyes.mjs';
import * as hands from './hands.mjs';

const TOOL_VERSION = 'computer_20251124';
const BETA = 'computer-use-2025-11-24';

const SYSTEM = `You are the hands of Woboo, operating its owner's Windows desktop.

You see the screen through screenshots and act through the computer tool. Work the
way a careful person would:

- Look before you act. After anything that changes the screen, take a screenshot
  and confirm it did what you expected before moving on.
- Prefer keyboard over mouse when it is more reliable: the Windows key to search
  and launch apps, ctrl+l for a browser address bar, Enter to confirm.
- Apps take time to open. If the screen has not changed yet, wait and look again
  rather than clicking blindly.
- Use zoom when text is too small to read rather than guessing at it.
- When the goal is met, stop and say plainly what you did and what is on screen.
  If you cannot achieve it, stop and say exactly what blocked you — do not keep
  clicking hopefully.

Do only what the goal asks. Do not open, close, install, buy, send, or delete
anything that is not needed for it.`;

// The screenshot the model just looked at, so a coordinate can be turned back
// into a real pixel on a real monitor.
let frame = { scale: 1 };

function toScreen(coordinate) {
  const [x, y] = coordinate || [0, 0];
  const scale = frame.scale || 1;
  return [Math.round(x / scale), Math.round(y / scale)];
}

async function look({ reason, region } = {}) {
  const shot = await eyes.capture({ reason, region });
  if (!shot.ok) throw new Error(`cannot see the screen: ${shot.error}`);
  if (!region) frame = shot;
  return shot;
}

function imageResult(id, base64) {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }],
  };
}

function textResult(id, text, isError = false) {
  return { type: 'tool_result', tool_use_id: id, content: text, is_error: isError };
}

// One action from the model, performed on the real machine. Every branch ends
// with a fresh screenshot: the model's next decision should be based on what
// the screen looks like now, not on what it hoped would happen.
async function perform(block) {
  assertLive('screen action');
  const { action, coordinate, text, scroll_direction: dir, scroll_amount: amt, region, duration } =
    block.input || {};

  publish({ type: 'pilot', action, detail: coordinate || text || region || dir || '' });
  record('pilot', `${action}${coordinate ? ` @ ${coordinate.join(',')}` : ''}${text ? `: ${text.slice(0, 60)}` : ''}`);

  switch (action) {
    case 'screenshot':
      return imageResult(block.id, (await look({ reason: 'model asked' })).base64);

    case 'zoom': {
      if (!region) return textResult(block.id, 'zoom needs a region', true);
      // The region arrives in image space; crop the real screen behind it.
      const [x1, y1] = toScreen([region[0], region[1]]);
      const [x2, y2] = toScreen([region[2], region[3]]);
      const shot = await look({ reason: 'zoom', region: [x1, y1, x2, y2] });
      return imageResult(block.id, shot.base64);
    }

    case 'mouse_move':
      await hands.moveTo(...toScreen(coordinate));
      break;

    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const button = action.startsWith('right') ? 'right' : action.startsWith('middle') ? 'middle' : 'left';
      const count = action.startsWith('double') ? 2 : action.startsWith('triple') ? 3 : 1;
      await hands.click(...toScreen(coordinate), { button, count });
      break;
    }

    case 'left_mouse_down':
      await hands.mouseDown(...toScreen(coordinate));
      break;

    case 'left_mouse_up':
      await hands.mouseUp(...toScreen(coordinate));
      break;

    case 'left_click_drag':
      await hands.dragTo(toScreen(block.input.start_coordinate || coordinate), toScreen(coordinate));
      break;

    case 'type':
      await hands.typeText(String(text ?? ''));
      break;

    case 'key':
      await hands.pressKey(toSendKeys(String(text ?? '')));
      break;

    case 'scroll':
      await hands.scroll(...toScreen(coordinate), dir || 'down', amt ?? 3);
      break;

    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, Math.min(5, Number(duration) || 1) * 1000));
      break;

    default:
      return textResult(block.id, `Woboo cannot do "${action}" on Windows. Try another way.`, true);
  }

  // Give the desktop a beat to repaint before looking at it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return imageResult(block.id, (await look({ reason: action })).base64);
}

// The model speaks xdotool-ish key names; SendKeys wants its own notation.
const KEY_NAMES = {
  Return: '{ENTER}', enter: '{ENTER}', Enter: '{ENTER}',
  Tab: '{TAB}', tab: '{TAB}',
  Escape: '{ESC}', escape: '{ESC}', esc: '{ESC}',
  BackSpace: '{BACKSPACE}', backspace: '{BACKSPACE}',
  Delete: '{DELETE}', delete: '{DELETE}',
  Home: '{HOME}', End: '{END}',
  Page_Up: '{PGUP}', Page_Down: '{PGDN}',
  Up: '{UP}', Down: '{DOWN}', Left: '{LEFT}', Right: '{RIGHT}',
  space: ' ',
};

export function toSendKeys(combo) {
  return combo
    .split(/\s+/)
    .map((chord) =>
      chord
        .split('+')
        .map((part) => {
          const key = part.trim();
          if (/^ctrl$/i.test(key)) return '^';
          if (/^(alt|meta)$/i.test(key)) return '%';
          if (/^shift$/i.test(key)) return '+';
          if (/^(super|win|cmd)$/i.test(key)) return '^{ESC}'; // no Win key in SendKeys; Start menu is the intent
          if (KEY_NAMES[key]) return KEY_NAMES[key];
          if (/^F\d{1,2}$/i.test(key)) return `{${key.toUpperCase()}}`;
          return key.length === 1 ? key : `{${key.toUpperCase()}}`;
        })
        .join(''),
    )
    .join(' ');
}

// ── the loop ──────────────────────────────────────────────────────────────────

export async function drive({ goal, maxSteps = 24, onProgress } = {}) {
  if (!hasCredentials()) {
    return {
      ok: false,
      out: 'Driving the screen needs a brain — the model has to see the screenshots. Set ANTHROPIC_API_KEY and try again.',
      missing: true,
    };
  }

  const settings = loadSettings();
  const anthropic = await getClient();

  await hands.openSession(goal);
  setFace('working', 'driving the screen');

  try {
    const first = await look({ reason: 'starting' });
    const tool = {
      type: TOOL_VERSION,
      name: 'computer',
      display_width_px: first.width,
      display_height_px: first.height,
      enable_zoom: true,
    };

    record('pilot', `driving toward: ${goal} (${first.width}x${first.height}, scale ${first.scale.toFixed(2)})`, {
      level: 'warn',
    });

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Goal: ${goal}\n\nHere is the screen right now.` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: first.base64 } },
        ],
      },
    ];

    let steps = 0;
    while (steps < maxSteps) {
      assertLive('pilot');
      steps += 1;

      const response = await anthropic.beta.messages.create({
        model: settings.model,
        max_tokens: 8000,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: settings.effort },
        betas: [BETA],
        tools: [tool],
        messages,
      });

      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category || 'unspecified';
        throw new Refused(`the brain declined to drive the screen (${category})`);
      }

      messages.push({ role: 'assistant', content: response.content });

      const said = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (said) {
        setFace('working', said.slice(0, 70));
        record('pilot', said.slice(0, 300));
        if (onProgress) onProgress(said);
      }

      const calls = response.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) {
        // Nothing left to do — the model has stopped acting and is reporting.
        return { ok: true, out: said || 'done', steps, code: 0 };
      }

      const results = [];
      for (const call of calls) {
        try {
          results.push(await perform(call));
        } catch (err) {
          if (err.name === 'Halted') throw err;
          results.push(textResult(call.id, `that failed: ${err.message}`, true));
        }
      }
      // All results for one assistant turn go back in a single user message.
      messages.push({ role: 'user', content: results });
    }

    return {
      ok: false,
      out: `Gave up after ${maxSteps} steps without reaching: ${goal}`,
      steps,
      code: 1,
    };
  } finally {
    hands.closeSession();
  }
}
