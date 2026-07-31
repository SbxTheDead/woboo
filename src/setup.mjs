// The first five minutes.
//
// Everything Woboo needs was configurable and nothing was discoverable: a new
// owner had to know that `woboo secret nvidia`, `woboo set provider`, `woboo
// secret telegram`, a /pair from their phone and `woboo browser signin` all
// existed, and in roughly that order. Anyone who did not read the source got a
// widget that blinked and did nothing.
//
// So: one command that asks for what is missing, in order, and skips what is
// already there. Every step is optional — Woboo works without Telegram, and
// without a browser login — and every step says what it buys you, because
// "paste an API key" is not a thing anyone does on faith.

import readline from 'node:readline/promises';
import { loadSettings, saveSettings, loadSecrets, saveSecret, PATHS } from './config.mjs';
import * as nim from './nim.mjs';
import * as telegram from './telegram.mjs';

// What a fully-configured Woboo has. Order matters: the brain first, because
// nothing works without it, then the things that make it better.
export function state() {
  const secrets = loadSecrets();
  const settings = loadSettings();
  return {
    brain: {
      done: Boolean(secrets.nvidiaApiKey || secrets.anthropicApiKey),
      detail: secrets.nvidiaApiKey ? `NVIDIA NIM — ${nim.model()}` : secrets.anthropicApiKey ? 'Anthropic' : '',
    },
    search: { done: Boolean(secrets.tavilyApiKey), detail: secrets.tavilyApiKey ? 'Tavily' : '' },
    telegram: {
      done: Boolean(secrets.telegramToken && settings.telegramChatId),
      detail: secrets.telegramToken
        ? settings.telegramChatId
          ? `paired with chat ${settings.telegramChatId}`
          : 'token stored, phone not paired'
        : '',
    },
    browser: { done: true, detail: PATHS.home },
  };
}

export function isConfigured() {
  return state().brain.done;
}

const KEY_SHAPES = {
  nvidiaApiKey: /^nvapi-[\w-]{20,}$/,
  tavilyApiKey: /^tvly-[\w-]{10,}$/,
  telegramToken: /^\d{6,}:[\w-]{30,}$/,
};

// Catch a paste that went wrong before it becomes a 401 an hour later.
export function looksRight(name, value) {
  const shape = KEY_SHAPES[name];
  if (!shape) return true;
  return shape.test(String(value || '').trim());
}

export async function run({ say, colors, force = false } = {}) {
  const { bold, dim, green, yellow, cyan, red } = colors;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question) => (await rl.question(question)).trim();
  const yes = async (question) => /^y(es)?$/i.test(await ask(`${question} ${dim('[y/N]')} `));

  const done = [];
  try {
    say('');
    say(`  ${bold('Setting Woboo up.')} Three questions, all skippable with Enter.`);
    say(dim(`  Keys are stored in ${PATHS.secrets}, readable only by you.`));
    say('');

    // ── 1. a brain ────────────────────────────────────────────────────────────
    const current = state();
    if (current.brain.done && !force) {
      say(`  ${green('✓')} brain      ${dim(current.brain.detail)}`);
    } else {
      say(`  ${bold('1. A brain.')} Woboo plans and writes with a model.`);
      say(dim('     NVIDIA NIM is free: build.nvidia.com → sign in → any model → "Get API Key".'));
      const key = await ask(`     ${cyan('nvapi-...')} (Enter to skip) `);
      if (key) {
        if (!looksRight('nvidiaApiKey', key)) {
          say(`     ${yellow('that does not look like an NVIDIA key (they start nvapi-) — storing it anyway')}`);
        }
        saveSecret('nvidiaApiKey', key);
        saveSettings({ provider: 'nim' });
        process.stdout.write(`     ${dim('checking…')}`);
        try {
          const models = await nim.listModels();
          say(`\r     ${green('✓')} key works — ${models.length} models available, using ${nim.model()}      `);
          done.push('brain');
        } catch (err) {
          say(`\r     ${red('✗')} the key was stored but did not work: ${err.message}`);
        }
      } else {
        say(dim('     skipped — Woboo will fall back to offline plans, which are poor.'));
      }
    }
    say('');

    // ── 2. search ─────────────────────────────────────────────────────────────
    if (current.search.done && !force) {
      say(`  ${green('✓')} search     ${dim(current.search.detail)}`);
    } else {
      say(`  ${bold('2. Search.')} Without a key Woboo scrapes results, which is slower and thinner.`);
      say(dim('     tavily.com gives 1,000 free searches a month.'));
      const key = await ask(`     ${cyan('tvly-...')} (Enter to skip) `);
      if (key) {
        saveSecret('tavilyApiKey', key);
        say(`     ${green('✓')} stored`);
        done.push('search');
      } else {
        say(dim('     skipped — research still works, just less well.'));
      }
    }
    say('');

    // ── 3. the phone ──────────────────────────────────────────────────────────
    if (current.telegram.done && !force) {
      say(`  ${green('✓')} telegram   ${dim(current.telegram.detail)}`);
    } else {
      say(`  ${bold('3. Your phone.')} Send Woboo tasks and answer its questions from anywhere.`);
      say(dim('     Message @BotFather on Telegram, /newbot, and paste the token it gives you.'));
      const token = loadSecrets().telegramToken || (await ask(`     ${cyan('token')} (Enter to skip) `));
      if (token) {
        if (!looksRight('telegramToken', token)) {
          say(`     ${yellow('that does not look like a bot token (digits:letters) — storing it anyway')}`);
        }
        saveSecret('telegramToken', token);
        const live = await telegram.reachable();
        if (!live.ok) {
          say(`     ${red('✗')} Telegram would not accept it: ${live.error}`);
        } else {
          say(`     ${green('✓')} connected as ${cyan(`@${live.username}`)}`);
          say(`     now message it ${bold('/pair')} from your phone, and it will tell you the code to send back.`);
          done.push('telegram');
        }
      } else {
        say(dim('     skipped — the widget and CLI still work.'));
      }
    }
    say('');

    // ── 4. accounts ───────────────────────────────────────────────────────────
    say(`  ${bold('4. Accounts.')} Woboo drives a browser profile of its own, signed in to nothing.`);
    say(dim('     Chrome refuses a debugging port on your real profile, so this is the only way.'));
    if (await yes(`     Open it now so you can sign in to Google?`)) {
      const browser = await import('./browser.mjs');
      const opened = await browser.open();
      if (!opened.ok) {
        say(`     ${red('✗')} ${opened.error}`);
      } else {
        await browser.goto('https://accounts.google.com');
        say(`     ${green('✓')} signed-in state is kept — do it once and it stays.`);
        say(dim('     Woboo never types passwords or one-time codes itself.'));
        done.push('browser');
      }
    } else {
      say(dim('     later: `woboo browser signin`'));
    }

    say('');
    say(`  ${green('Ready.')} ${dim('`woboo widget` to start it, `woboo doctor` to check it.')}`);
    return { ok: true, configured: done };
  } finally {
    rl.close();
  }
}
