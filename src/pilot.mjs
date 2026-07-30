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
import { getClient, hasCredentials, provider as brainProvider } from './brain.mjs';
import * as nim from './nim.mjs';
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

// ── driving on NIM ────────────────────────────────────────────────────────────
// NIM has no GUI-grounded model: its vision models describe a screen well but
// cannot point at one, and asking for raw pixels gets you confident mis-clicks.
// So don't ask. Draw a labelled grid over the screenshot and let the model name
// a cell — a multiple-choice question instead of a regression — then keep the
// keyboard as the primary instrument, because most desktop work needs no click
// at all. Measured: raw coordinates were unusable, grid cells land in the right
// region on the models below.

const NIM_SYSTEM = `You are the hands of Woboo, operating its owner's Windows desktop.

You see the screen as a screenshot with an orange grid drawn over it. Cells are
labelled in their top-left corner: columns A-T left to right, rows 1-12 top to
bottom. You act by naming a cell, never by guessing pixel coordinates.

Prefer the keyboard. It is far more reliable than clicking:
  - the Windows key opens search: press it, type an app name, press Enter
  - ctrl+l focuses a browser address bar; type a URL and press Enter
  - ctrl+p prints, ctrl+s saves, ctrl+f finds, alt+Tab switches window
Click only when there is no keyboard route.

Reply with exactly one JSON object and nothing else:
  {"thought":"one short line","action":"...","cell":"F7","text":"...","combo":"ctrl+l","direction":"down","summary":"..."}

action must be one of:
  look    — take a fresh screenshot and look again (use after anything slow)
  click   — click the centre of "cell"
  type    — type "text"
  key     — press "combo", e.g. "ctrl+l" or "Return" or "cmd" for the Windows key
  scroll  — scroll "direction" at "cell"
  zoom    — magnify "cell" to read something too small
  done    — the goal is met; put the outcome in "summary"
  give_up — it cannot be done; explain why in "summary"

Look after every action that changes the screen. Never claim done without
seeing the result first.`;

async function nimAct(messages, model, key) {
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 700, temperature: 0.1, messages }),
  });
  if (!response.ok) {
    throw new Error(`NIM ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }
  const text = ((await response.json()).choices?.[0]?.message?.content || '').trim();
  // Reasoning models narrate before the JSON; take the last object in the reply.
  const objects = text.match(/\{[\s\S]*?\}/g);
  for (const candidate of (objects || []).reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.action) return { step: parsed, raw: text };
    } catch {
      // Not the object we wanted; keep looking backwards.
    }
  }
  throw new Error(`could not read an action from: ${text.slice(0, 200)}`);
}

async function driveWithNim({ goal, maxSteps, onProgress, dryRun = false }) {
  const key = nim.apiKey();
  const model = loadSettings().nimVisionModel || 'meta/llama-3.2-90b-vision-instruct';

  // A dry run proves the whole chain — capture, grid, the model's reading of the
  // screen, the parsed action, the pixel it maps to — without the hands ever
  // moving. It is how you check the wiring before handing over the mouse.
  if (dryRun) {
    const shot = await eyes.capture({ reason: 'dry run', grid: true });
    if (!shot.ok) throw new Error(`cannot see the screen: ${shot.error}`);
    frame = shot;

    const messages = [
      { role: 'system', content: NIM_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Goal: ${goal}\n\nHere is the screen now (${shot.width}x${shot.height}). Decide the single next action.` },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${shot.base64}` } },
        ],
      },
    ];
    const { step: act, raw } = await nimAct(messages, model, key);
    const pixel = act.cell ? eyes.cellToPixel(act.cell, shot) : null;
    return {
      ok: true,
      dryRun: true,
      out:
        `would ${act.action}` +
        (act.cell ? ` at cell ${act.cell} → pixel ${pixel ? pixel.join(',') : 'INVALID'}` : '') +
        (act.text ? ` "${act.text}"` : '') +
        (act.combo ? ` [${act.combo}]` : '') +
        (act.thought ? `\n  reasoning: ${act.thought}` : ''),
      action: act,
      pixel,
      raw,
      screen: `${shot.width}x${shot.height}`,
    };
  }

  await hands.openSession(goal);
  setFace('working', 'driving the screen');

  try {
    let shot = await eyes.capture({ reason: 'starting', grid: true });
    if (!shot.ok) throw new Error(`cannot see the screen: ${shot.error}`);
    record('pilot', `driving toward "${goal}" with ${model} (grid ${eyes.GRID.cols}x${eyes.GRID.rows})`, {
      level: 'warn',
    });

    const history = [];
    for (let step = 1; step <= maxSteps; step += 1) {
      assertLive('pilot');

      const messages = [
        { role: 'system', content: NIM_SYSTEM },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Goal: ${goal}\n` +
                (history.length ? `\nWhat you have done so far:\n${history.slice(-6).join('\n')}\n` : '') +
                `\nHere is the screen now (${shot.width}x${shot.height}). Decide the single next action.`,
            },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${shot.base64}` } },
          ],
        },
      ];

      const { step: act } = await nimAct(messages, model, key);
      const note = `${act.action}${act.cell ? ` ${act.cell}` : ''}${act.text ? ` "${String(act.text).slice(0, 40)}"` : ''}${act.combo ? ` ${act.combo}` : ''}`;
      history.push(`${step}. ${note}${act.thought ? ` — ${act.thought}` : ''}`);
      record('pilot', note);
      if (act.thought) {
        setFace('working', String(act.thought).slice(0, 70));
        if (onProgress) onProgress(act.thought);
      }

      if (act.action === 'done') return { ok: true, out: act.summary || 'done', steps: step, code: 0 };
      if (act.action === 'give_up') return { ok: false, out: act.summary || 'gave up', steps: step, code: 1 };

      const pixel = act.cell ? eyes.cellToPixel(act.cell, shot) : null;
      switch (act.action) {
        case 'click':
          if (!pixel) { history.push('   (that cell was not valid)'); break; }
          await hands.click(...toReal(pixel, shot));
          break;
        case 'type':
          await hands.typeText(String(act.text ?? ''));
          break;
        case 'key':
          await hands.pressKey(toSendKeys(String(act.combo ?? act.text ?? '')));
          break;
        case 'scroll':
          await hands.scroll(...toReal(pixel || [shot.width / 2, shot.height / 2], shot), act.direction || 'down', 3);
          break;
        case 'zoom': {
          if (!pixel) break;
          const [cx, cy] = toReal(pixel, shot);
          const w = Math.round(shot.width / eyes.GRID.cols / (shot.scale || 1));
          const h = Math.round(shot.height / eyes.GRID.rows / (shot.scale || 1));
          const close = await eyes.capture({
            reason: 'zoom',
            region: [cx - w, cy - h, cx + w, cy + h],
          });
          if (close.ok) {
            history.push('   (zoomed — the next screenshot is the magnified region)');
            shot = { ...close, width: shot.width, height: shot.height, base64: close.base64 };
            continue;
          }
          break;
        }
        case 'look':
        default:
          break;
      }

      await new Promise((resolve) => setTimeout(resolve, 700));
      shot = await eyes.capture({ reason: act.action, grid: true });
      if (!shot.ok) throw new Error(`lost sight of the screen: ${shot.error}`);
    }

    return { ok: false, out: `Gave up after ${maxSteps} steps without reaching: ${goal}`, code: 1 };
  } finally {
    hands.closeSession();
  }
}

// Grid cells are in the (possibly downscaled) image's space; the mouse needs
// real pixels.
function toReal([x, y], shot) {
  const scale = shot.scale || 1;
  return [Math.round(x / scale), Math.round(y / scale)];
}

export async function drive({ goal, maxSteps = 24, onProgress, dryRun = false } = {}) {
  // Whichever brain is in charge drives, so "everything on NIM" really is
  // everything — with the grid standing in for grounding NIM does not have.
  if (brainProvider() === 'nim' && nim.hasCredentials()) {
    return driveWithNim({ goal, maxSteps, onProgress, dryRun });
  }

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
