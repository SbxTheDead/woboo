// Woboo on your phone.
//
// Long polling, not a webhook: a machine under your desk should not need a
// public URL, a tunnel, or an inbound port to be reachable. Woboo dials out.
//
// The important part is not "send a task from the sofa" — it is that the
// approval gate travels with you. An approval that times out into a denial is
// useless if you are the only one who can answer it and you are not at the
// keyboard. With this, the ALLOW/DENY buttons are in your pocket.
//
// No dependencies: fetch, FormData and Blob are all built into Node 20+.

import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { loadSettings, saveSettings } from './config.mjs';
import { subscribe } from './bus.mjs';
import { record, tail } from './journal.mjs';
import * as guard from './guard.mjs';
import * as consult from './consult.mjs';
import * as foreman from './foreman.mjs';
import * as eyes from './eyes.mjs';
import * as memory from './memory.mjs';

const API = 'https://api.telegram.org';
const TEXT_LIMIT = 3900; // Telegram caps at 4096; leave room for formatting.

function esc(text) {
  return String(text ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// Node's HTTP stack, deliberately, not fetch.
//
// Inside Electron's main process `fetch` is Chromium's implementation, and it
// will not hold Telegram's long-polling connection open — every getUpdates came
// back "fetch failed" while the identical call from plain Node returned in a
// second. Messages piled up unread and the bot looked dead. node:https is the
// same in both hosts, so the bot behaves identically however Woboo is started.
function request(url, payload, timeout) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Telegram returned unparseable JSON (${res.statusCode})`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export function createBot({ token }) {
  const call = (method, body, { timeout = 30_000 } = {}) =>
    request(`${API}/bot${token}/${method}`, body, timeout);

  const send = (chatId, text, extra = {}) =>
    call('sendMessage', {
      chat_id: chatId,
      text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…` : text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });

  const sendPhoto = async (chatId, filePath, caption) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('photo', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), 'screen.png');
    const response = await fetch(`${API}/bot${token}/sendPhoto`, { method: 'POST', body: form });
    return response.json();
  };

  return { call, send, sendPhoto };
}

// ── the loop ──────────────────────────────────────────────────────────────────

export async function start({ token, onPairCode } = {}) {
  const settings = loadSettings();
  if (!token) throw new Error('no Telegram token — run `wobo secret telegram <token>`');

  const bot = createBot({ token });

  const me = await bot.call('getMe');
  if (!me.ok) throw new Error(`Telegram rejected the token: ${me.description || 'unknown error'}`);
  record('telegram', `connected as @${me.result.username}`, { level: 'ok' });

  // Whoever holds the bot token can message the bot; that must not be enough to
  // drive the machine. Until an owner chat is paired, the only accepted message
  // is a one-time code printed on the machine itself.
  let owner = loadSettings().telegramChatId || null;
  const pairCode = owner ? null : String(crypto.randomInt(100_000, 999_999));
  if (pairCode) {
    record('telegram', `waiting to be paired — send "/pair ${pairCode}" to @${me.result.username}`, {
      level: 'warn',
    });
    if (onPairCode) onPairCode(pairCode, me.result.username);
  }

  let offset = 0;
  let alive = true;
  const seenSteps = new Set();

  const tell = (text, extra) => (owner ? bot.send(owner, text, extra).catch(() => {}) : null);

  // ── outbound: mission progress ──────────────────────────────────────────────
  const unsubscribe = subscribe((event) => {
    if (!owner) return;

    if (event.type === 'approval') {
      const { id, kind, detail, timeout } = event.request;
      tell(
        `⚠️ <b>${esc(kind)}</b>\n<code>${esc(detail)}</code>\n\n<i>auto-denies in ${timeout}s</i>`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Allow', callback_data: `ok:${id}` },
                { text: '⛔ Deny', callback_data: `no:${id}` },
              ],
            ],
          },
        },
      );
      return;
    }

    // A question Woboo cannot answer for itself. Buttons, because typing an
    // exact profile name on a phone is how people pick the wrong one.
    if (event.type === 'consult') {
      const { id, question, detail, options, timeout } = event.request;
      tell(
        `🤔 <b>${esc(question)}</b>${detail ? `\n<i>${esc(detail)}</i>` : ''}\n\n` +
          `<i>Woboo will remember this answer.</i>`,
        {
          reply_markup: {
            // One per row: option labels are long enough that side-by-side
            // buttons truncate to uselessness.
            inline_keyboard: options.slice(0, 8).map((o, i) => [
              { text: o.label.slice(0, 60), callback_data: `c:${id}:${i}` },
            ]),
          },
        },
      );
      return;
    }

    if (event.type === 'guard') {
      tell(event.stopped ? `🛑 STOP engaged — ${esc(event.reason)}` : '▶️ STOP released');
      return;
    }

    if (event.type === 'mission' && event.mission) {
      const m = event.mission;

      // Planning can take a minute, and silence in a chat reads as "broken"
      // rather than "working". Say it started, once.
      if (m.state === 'planning' && !seenSteps.has(`think:${m.id}`)) {
        seenSteps.add(`think:${m.id}`);
        tell('🧠 <i>working out how to do that…</i>');
      }

      if (m.state === 'running' && m.summary && !seenSteps.has(`plan:${m.id}`)) {
        seenSteps.add(`plan:${m.id}`);
        const steps = m.steps.map((s, i) => `${i + 1}. ${esc(s.title)}`).join('\n');
        tell(`🧠 <b>Plan</b>\n${esc(m.summary)}\n\n${steps}`);
      }
      // One line per step, once, as it settles.
      for (const step of m.steps || []) {
        const key = `${m.id}:${step.i}:${step.status}`;
        if (step.status !== 'ok' && step.status !== 'failed') continue;
        if (seenSteps.has(key)) continue;
        seenSteps.add(key);
        // A bare ❌ tells the owner nothing. The reason is the whole message:
        // "Chrome is already running" is actionable, "failed" is not.
        const why = step.status === 'failed' ? (step.output || step.verifyOutput || '').trim() : '';
        tell(
          `${step.status === 'ok' ? '✅' : '❌'} ${esc(step.title)}` +
            (why ? `\n<i>${esc(why.slice(0, 400))}</i>` : ''),
        );
      }
      if ((m.state === 'done' || m.state === 'failed' || m.state === 'stopped') && !seenSteps.has(`end:${m.id}`)) {
        seenSteps.add(`end:${m.id}`);
        const mark = m.state === 'done' ? '🎉' : m.state === 'stopped' ? '🛑' : '💥';
        tell(`${mark} <b>${esc(m.state)}</b>\n${esc(m.report)}`);
      }
    }
  });

  // ── inbound ─────────────────────────────────────────────────────────────────

  async function handleText(chatId, text) {
    const trimmed = text.trim();

    // Pairing is the only thing an unknown chat may do.
    if (!owner) {
      if (trimmed === `/pair ${pairCode}`) {
        owner = chatId;
        saveSettings({ telegramChatId: chatId });
        record('telegram', `paired with chat ${chatId}`, { level: 'ok' });
        await bot.send(chatId, '🤖 Paired. Send me a task, or /help.');
      } else {
        record('telegram', `ignored message from unpaired chat ${chatId}`, { level: 'warn' });
      }
      return;
    }
    if (chatId !== owner) {
      record('telegram', `ignored message from chat ${chatId} (not the owner)`, { level: 'warn' });
      return;
    }

    const [command, ...rest] = trimmed.split(/\s+/);
    const argument = rest.join(' ');

    switch (command) {
      case '/start':
      case '/help':
        return tell(
          '<b>Woboo</b>\n' +
            'Send any message to start a mission.\n\n' +
            '/status — what it is doing\n' +
            '/stop — engage STOP\n' +
            '/resume — release STOP\n' +
            '/look — screenshot\n' +
            '/drive &lt;goal&gt; — take the mouse and keyboard\n' +
            '/log — recent journal\n' +
            '/memory — what it remembers here\n' +
            '/note &lt;text&gt; — remember this, do not repeat it',
        );

      case '/status': {
        const m = foreman.currentMission();
        const stopped = guard.isStopped();
        if (stopped) return tell(`🛑 STOP engaged — ${esc(guard.stopReason())}`);
        if (!m) return tell('😴 Idle. Send a task.');
        const done = (m.steps || []).filter((s) => s.status === 'ok').length;
        return tell(
          `<b>${esc(m.state)}</b> — ${esc(m.task)}\n${done}/${(m.steps || []).length} steps done`,
        );
      }

      case '/stop':
        guard.engageStop('owner pressed STOP (telegram)');
        return undefined; // the guard event already announces it

      case '/resume':
        guard.clearStop();
        return undefined;

      case '/look': {
        const shot = await eyes.screenshot({ reason: 'telegram' });
        if (!shot.ok) return tell(`could not look: ${esc(shot.error)}`);
        return bot.sendPhoto(owner, shot.path, 'what Woboo sees').catch(() => {});
      }

      case '/log': {
        const lines = tail(20)
          .map((e) => `${e.t.slice(11, 19)} ${e.kind}: ${e.msg}`)
          .join('\n');
        return tell(`<pre>${esc(lines || 'nothing yet')}</pre>`);
      }

      case '/memory': {
        const cwd = loadSettings().workspace || process.cwd();
        const digest = memory.recall(cwd);
        return tell(digest ? `<b>Remembers about ${esc(cwd)}</b>\n${esc(digest)}` : 'Nothing remembered here yet.');
      }

      case '/drive': {
        if (!argument) return tell('give it a goal: <code>/drive open Edge and search for X</code>');
        if (foreman.isBusy()) return tell('busy — /status, or /stop first.');
        if (guard.isStopped()) return tell('STOP is engaged — /resume first.');
        tell(`🖱 <i>taking the mouse: ${esc(argument)}</i>`);
        const pilot = await import('./pilot.mjs');
        pilot
          .drive({ goal: argument, onProgress: (note) => tell(`  <i>${esc(note)}</i>`) })
          .then((r) => tell(`${r.ok ? '✅' : '❌'} ${esc(r.out)}`))
          .catch((err) => tell(`💥 ${esc(err.message)}`));
        return undefined;
      }

      case '/note': {
        if (!argument) return tell('give me something to remember: /note always run tests before pushing');
        memory.learnFromOwner(loadSettings().workspace || process.cwd(), argument);
        return tell('📝 noted — I will not need telling again.');
      }

      default: {
        if (command.startsWith('/')) return tell('unknown command — /help');
        if (foreman.isBusy()) return tell('already on a mission — /status, or /stop first.');
        if (guard.isStopped()) return tell(`STOP is engaged — /resume first.`);
        tell(`🎯 <i>${esc(trimmed)}</i>`);
        foreman
          .runMission(trimmed)
          .catch((err) => tell(`💥 ${esc(err.message)}`));
        return undefined;
      }
    }
  }

  async function handleCallback(query) {
    const chatId = query.message?.chat?.id;
    if (!owner || chatId !== owner) return;
    const parts = String(query.data || '').split(':');

    // A consultation carries three parts, an approval two.
    if (parts[0] === 'c') {
      const [, id, index] = parts;
      const chosen = consult.choose(id, index);
      await bot.call('answerCallbackQuery', {
        callback_query_id: query.id,
        text: chosen ? `Chose ${chosen.label}`.slice(0, 60) : 'too late — that question expired',
      });
      if (chosen) {
        await bot
          .call('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => {});
        await tell(`✅ <b>${esc(chosen.label)}</b> — remembered, so you will not be asked again.`);
      }
      return;
    }

    const [verdict, id] = parts;
    const handled = guard.resolveApproval(id, verdict === 'ok' ? 'allow' : 'deny');
    await bot.call('answerCallbackQuery', {
      callback_query_id: query.id,
      text: handled ? (verdict === 'ok' ? 'Allowed' : 'Denied') : 'too late — it already timed out',
    });
    // Replace the buttons so a stale message cannot be answered twice.
    if (handled) {
      await bot
        .call('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      await tell(verdict === 'ok' ? '✅ allowed' : '⛔ denied');
    }
  }

  const poll = async () => {
    while (alive) {
      try {
        // Telegram holds the request open until something happens or the timeout
        // expires, so this loop is idle-cheap rather than a busy poll.
        const updates = await bot.call(
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          { timeout: 35_000 },
        );
        if (!updates.ok) {
          // Telegram allows exactly one long-poll consumer per bot. A second
          // Woboo — the app when the CLI is already running, say — would
          // otherwise fight the first forever, each stealing the other's
          // updates. Stand down instead of looping on it.
          if (/conflict/i.test(updates.description || '')) {
            record('telegram', 'another Woboo is already polling this bot — standing down', {
              level: 'warn',
            });
            alive = false;
            unsubscribe();
            return;
          }
          record('telegram', `getUpdates failed: ${updates.description}`, { level: 'warn' });
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        for (const update of updates.result) {
          offset = update.update_id + 1;
          try {
            if (update.message?.text) {
              await handleText(update.message.chat.id, update.message.text);
            } else if (update.callback_query) {
              await handleCallback(update.callback_query);
            }
          } catch (err) {
            record('telegram', `handler failed: ${err.message}`, { level: 'error' });
          }
        }
      } catch (err) {
        if (!alive) return;
        // Network blip, laptop asleep, Telegram hiccup — back off and continue.
        record('telegram', `poll error: ${err.message}`, { level: 'warn' });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  poll();

  return {
    username: me.result.username,
    pairCode,
    paired: () => owner,
    stop() {
      alive = false;
      unsubscribe();
      record('telegram', 'bot stopped');
    },
  };
}
