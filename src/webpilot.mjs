// Driving the web: look at the page as a list of things, not a picture.
//
// Same shape as the pilot — see, decide, act, see again — but every part is
// cheaper and surer. The "seeing" is a snapshot of the real elements with their
// real text, so the model picks element 14 rather than guessing which grid cell
// a button might be under. Nothing is a coordinate, so nothing can be off by a
// few pixels, and a text model does the deciding instead of a vision one.
//
// Measured against the vision pilot on the same machine: 16ms a look versus
// 153 seconds.

import { record } from './journal.mjs';
import { publish } from './bus.mjs';
import { setFace } from './face.mjs';
import { assertLive } from './guard.mjs';
import * as browser from './browser.mjs';

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', description: 'One short sentence on why this is the next move.' },
    action: {
      type: 'string',
      enum: ['goto', 'click', 'type', 'submit', 'scroll', 'read', 'done', 'stuck'],
      description:
        'goto = navigate to a url; click/type/submit = act on an element by index; ' +
        'scroll = move down the page; read = the answer is in the page text; ' +
        'done = the goal is met; stuck = it cannot be done and you should say why.',
    },
    index: { type: 'integer', description: 'Which element, from the list. -1 when not acting on one.' },
    text: { type: 'string', description: 'Text to type, the url for goto, or the reason for done/stuck.' },
  },
  required: ['thought', 'action', 'index', 'text'],
  additionalProperties: false,
};

const SYSTEM = `You are operating a real web browser for Woboo's owner.

Each turn you are given the page's URL, title, its visible text, and a numbered
list of everything interactive on it. Choose ONE next action.

- Act on elements by their number. They are real elements, so a click lands
  exactly on the thing you named — you never have to guess at a position.
- Elements marked "below" are further down the page. You can still click them;
  the page scrolls to them first. Do not scroll just to reach one.
- Type into a field, then "submit" to send it — that presses Enter properly.
- When the page already answers the goal, use "read": the text you were given is
  what a person would see, so quote from it rather than clicking further.
- Use "done" the moment the goal is met, with a plain summary in text.
- Use "stuck" if the page needs a login you do not have, a payment, a captcha,
  or anything you should not do on someone's behalf. Say exactly what blocked
  you. Do not keep clicking hopefully.

Never buy, send, post, delete or confirm anything that the goal did not ask for.`;

function pageForModel(page) {
  const list = page.elements
    .map((e) => {
      const filled = e.value ? `  ← currently contains: "${e.value}"` : '';
      return `[${e.i}] ${e.tag}${e.type ? `/${e.type}` : ''} ${e.inView ? '' : '(below) '}${e.text}${filled}`;
    })
    .join('\n');
  return `URL: ${page.url}
TITLE: ${page.title}

INTERACTIVE ELEMENTS:
${list || '(none found)'}

PAGE TEXT:
${page.text.slice(0, 3500)}`;
}

export async function browse({ goal, url = null, maxSteps = 14, ask, onProgress } = {}) {
  const say = (message, level = 'info') => {
    record('web', message, { level });
    if (onProgress) onProgress(message);
  };

  setFace('working', 'opening the browser');
  const opened = await browser.open();
  if (!opened.ok) return { ok: false, out: `could not open a browser: ${opened.error}` };
  await browser.watchErrors();

  if (url) {
    say(`going to ${url}`);
    await browser.goto(url);
  }

  const history = [];
  const recent = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    assertLive('web');
    const page = await browser.snapshot();

    const decision = await ask({
      system: SYSTEM,
      prompt:
        `Goal: ${goal}\n\n${pageForModel(page)}\n\n` +
        (history.length ? `What you have done so far:\n${history.join('\n')}\n\n` : '') +
        'What is the single next action?',
      schema: ACTION_SCHEMA,
      name: 'web_action',
      maxTokens: 1200,
      think: false,
    });

    const label = page.elements[decision.index]?.text?.slice(0, 40) || '';

    // Repeating the same move on the same element means the page is not
    // responding the way the model expects, and doing it a fourth time will not
    // help. Stop and say what is stuck rather than hammering the field forever.
    const signature = `${decision.action}:${decision.index}:${decision.text?.slice(0, 30) || ''}`;
    recent.push(signature);
    if (recent.length > 4) recent.shift();
    if (recent.length >= 3 && recent.slice(-3).every((s) => s === signature)) {
      setFace('confused', 'stuck in a loop');
      return {
        ok: false,
        out:
          `Stuck: tried to ${decision.action} on "${label || decision.text}" three times and the page did not ` +
          `move on. It is probably waiting for something Woboo cannot supply — a login, a captcha, or a ` +
          `field that rejects what was typed.`,
        steps: step,
        url: page.url,
      };
    }

    say(`${decision.action}${decision.index >= 0 ? ` [${decision.index}] ${label}` : ''} — ${decision.thought}`);
    publish({ type: 'web', action: decision.action, detail: label || decision.text });

    if (decision.action === 'done') {
      setFace('happy', 'done');
      return { ok: true, out: decision.text || 'done', steps: step, url: page.url };
    }
    if (decision.action === 'stuck') {
      setFace('confused', 'blocked');
      return { ok: false, out: `stopped: ${decision.text}`, steps: step, url: page.url };
    }
    if (decision.action === 'read') {
      const text = await browser.readText();
      return { ok: true, out: decision.text || text.slice(0, 2000), steps: step, url: page.url, text };
    }

    switch (decision.action) {
      case 'goto':
        await browser.goto(decision.text);
        break;
      case 'click':
        await browser.click(decision.index);
        break;
      case 'type':
        await browser.type(decision.index, decision.text);
        break;
      case 'submit':
        await browser.pressEnter(decision.index);
        break;
      case 'scroll':
        await browser.scroll(700);
        break;
      default:
        break;
    }
    history.push(`${step}. ${decision.action} ${label || decision.text || ''}`.slice(0, 110));
  }

  return { ok: false, out: `gave up after ${maxSteps} steps without finishing: ${goal}` };
}

// What the page is really made of — for "check this site" work, where the
// answer is a fact about the page rather than an action on it.
export async function inspect({ url, ask } = {}) {
  const opened = await browser.open();
  if (!opened.ok) return { ok: false, out: opened.error };
  await browser.watchErrors();
  if (url) await browser.goto(url);

  const page = await browser.snapshot();
  const problems = await browser.problems();
  const styles = [];
  for (const el of page.elements.slice(0, 12)) {
    const style = await browser.styleOf(el.i, ['color', 'background-color', 'font-family', 'font-size']);
    if (style) styles.push({ text: el.text.slice(0, 40), ...style });
  }

  return {
    ok: true,
    out: `${page.title} — ${page.elements.length} interactive elements, ${problems.errors.length} console error(s), ${problems.brokenImages.length} broken image(s)`,
    page,
    problems,
    styles,
  };
}
