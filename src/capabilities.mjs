// How to reach a thing, cheapest route first.
//
// Woboo has three ways to act on the world, and they are not equal:
//
//   1. API     a request to a service that has one            milliseconds
//   2. DOM     a browser page driven through DevTools          ~16ms a step
//   3. VISION  a screenshot, a grid, and a model's best guess  ~153s a step
//
// Those are measured, not estimated. Vision is roughly ten thousand times more
// expensive than the DOM for the same work, and it is also the only rung that
// can be wrong about what it clicked. So it is the last resort, not the default:
// something should only be done by looking at pixels when there is genuinely no
// other way in — a native application with no API and no web version.
//
// This is the map of what can be reached by which rung. It is deliberately a
// small curated list rather than a scrape of the internet: the value is in
// knowing that Gmail has both an API and a web UI, not in listing every SaaS
// product that exists.

import { loadSecrets } from './config.mjs';

// web:  the URL its interface lives at — reachable by DOM today, no setup.
// api:  what an API route would need. Present means "possible", not "wired up".
// hint: what to tell the driver so it does not have to rediscover the layout.
export const APPS = {
  gmail: {
    name: 'Gmail',
    match: /\b(gmail|google mail|my email|send an? email)\b/i,
    web: 'https://mail.google.com',
    api: { name: 'Gmail API', base: 'https://gmail.googleapis.com/gmail/v1', secret: 'googleOAuth' },
    hint: 'Compose is the button top-left. Recipient goes in the "To" field, then Subject, then the body. Send is bottom-left.',
  },
  outlook: {
    name: 'Outlook',
    match: /\b(outlook|hotmail|office ?365 mail)\b/i,
    web: 'https://outlook.live.com/mail',
    api: { name: 'Microsoft Graph', base: 'https://graph.microsoft.com/v1.0', secret: 'msGraphToken' },
  },
  github: {
    name: 'GitHub',
    match: /\bgithub\b/i,
    web: 'https://github.com',
    api: { name: 'GitHub REST', base: 'https://api.github.com', secret: 'githubToken' },
    hint: 'The API is far better than the UI for repos, issues and PRs.',
  },
  telegram: {
    name: 'Telegram',
    match: /\btelegram\b/i,
    web: 'https://web.telegram.org',
    api: { name: 'Telegram Bot API', base: 'https://api.telegram.org', secret: 'telegramToken' },
  },
  drive: {
    name: 'Google Drive',
    match: /\b(google drive|my drive|upload to drive)\b/i,
    web: 'https://drive.google.com',
    api: { name: 'Drive API', base: 'https://www.googleapis.com/drive/v3', secret: 'googleOAuth' },
  },
  calendar: {
    name: 'Google Calendar',
    match: /\b(google calendar|my calendar|schedule a meeting)\b/i,
    web: 'https://calendar.google.com',
    api: { name: 'Calendar API', base: 'https://www.googleapis.com/calendar/v3', secret: 'googleOAuth' },
  },
  notion: { name: 'Notion', match: /\bnotion\b/i, web: 'https://www.notion.so',
    api: { name: 'Notion API', base: 'https://api.notion.com/v1', secret: 'notionToken' } },
  slack: { name: 'Slack', match: /\bslack\b/i, web: 'https://app.slack.com',
    api: { name: 'Slack Web API', base: 'https://slack.com/api', secret: 'slackToken' } },
  discord: { name: 'Discord', match: /\bdiscord\b/i, web: 'https://discord.com/app',
    api: { name: 'Discord API', base: 'https://discord.com/api/v10', secret: 'discordToken' } },
  youtube: { name: 'YouTube', match: /\byoutube\b/i, web: 'https://www.youtube.com',
    api: { name: 'YouTube Data API', base: 'https://www.googleapis.com/youtube/v3', secret: 'googleApiKey' } },
  spotify: { name: 'Spotify', match: /\bspotify\b/i, web: 'https://open.spotify.com',
    api: { name: 'Spotify Web API', base: 'https://api.spotify.com/v1', secret: 'spotifyToken' } },
  linkedin: { name: 'LinkedIn', match: /\blinkedin\b/i, web: 'https://www.linkedin.com' },
  whatsapp: { name: 'WhatsApp', match: /\bwhatsapp\b/i, web: 'https://web.whatsapp.com' },
  maps: { name: 'Google Maps', match: /\b(google maps|directions to)\b/i, web: 'https://www.google.com/maps' },
  chatgpt: { name: 'ChatGPT', match: /\bchatgpt\b/i, web: 'https://chat.openai.com' },
  x: { name: 'X', match: /\b(twitter|x\.com|tweet)\b/i, web: 'https://x.com' },
  amazon: { name: 'Amazon', match: /\bamazon\b/i, web: 'https://www.amazon.com' },
};

// Native applications: no API, no web version. These are the only things that
// genuinely need eyes.
export const NATIVE = /\b(notepad|explorer|file explorer|settings|control panel|task manager|paint|calculator|cmd|powershell|terminal|vs ?code|visual studio|word|excel|powerpoint|photoshop|steam|obs)\b/i;

// A browser is a browser whatever the site — anything with a URL is DOM work.
const WEB_ISH = /\b(https?:\/\/|www\.|\.com|\.org|\.net|\.io|browser|chrome|edge|firefox|website|web ?page|online|search (for|the web))\b/i;

// Language about the machine itself rather than about the world. These are the
// tasks a browser genuinely cannot do, so they are worth the slow rung.
const DESKTOP_ISH =
  /\b(desktop|start menu|taskbar|system tray|wallpaper|screenshot|screen|window|dialog|installer|install .*\.exe|my (files|folder|drive)|this pc|recycle bin|device manager|printer|bluetooth|wi-?fi settings)\b/i;

export function identify(goal) {
  const text = String(goal || '');
  for (const [key, app] of Object.entries(APPS)) {
    if (app.match?.test(text)) return { key, ...app };
  }
  return null;
}

// Which rung this goal should be attempted on, and why. The reason matters:
// when Woboo falls back to vision it should be able to say what was missing,
// rather than silently taking the slowest road.
export function route(goal) {
  const app = identify(goal);
  const secrets = loadSecrets();

  if (app?.api && secrets[app.api.secret]) {
    return { rung: 'api', app, why: `${app.name} has an API and a credential is stored` };
  }
  if (app?.web) {
    return {
      rung: 'dom',
      app,
      url: app.web,
      why: app.api
        ? `${app.name} has an API but no ${app.api.secret} stored, so the web UI it is`
        : `${app.name} is a web app`,
    };
  }
  if (NATIVE.test(goal)) {
    return { rung: 'vision', why: 'a native application — no API and no web version, so this needs eyes' };
  }
  if (WEB_ISH.test(goal)) {
    return { rung: 'dom', url: null, why: 'this happens in a browser' };
  }
  if (DESKTOP_ISH.test(goal)) {
    return { rung: 'vision', why: 'this is about the desktop itself, which only eyes can see' };
  }
  // Everything else goes to the browser.
  //
  // This used to fall back to vision, which meant "find the cheapest flight to
  // Lisbon" — an obvious browser task that simply named no known site — took the
  // 153-second-per-step road instead of the 16-millisecond one. Vision is the
  // most expensive thing Woboo can do and it is now chosen only on a positive
  // signal that it is needed, never by default. A browser is where most tasks
  // live, and if the browser turns out to be wrong the foreman can still escalate.
  return { rung: 'dom', url: null, why: 'nothing named a local app, so try the browser before the screen' };
}

// What the planner is told, so it routes tasks the same way rather than
// defaulting to the most expensive rung.
export function describe() {
  const secrets = loadSecrets();
  const wired = Object.values(APPS).filter((a) => a.api && secrets[a.api.secret]).map((a) => a.name);
  const web = Object.values(APPS).filter((a) => a.web).map((a) => a.name);

  return [
    'How Woboo reaches things, cheapest first — always prefer the highest rung available:',
    wired.length
      ? `  1. API — credentials stored for: ${wired.join(', ')}. Use these directly; they are instant and exact.`
      : '  1. API — no service credentials stored yet, so this rung is unavailable.',
    `  2. BROWSER ("web" step) — anything with a web interface, driven through the DOM: real clicks on real`,
    `     elements, exact text and colours, ~16ms a step. Covers ${web.slice(0, 8).join(', ')} and any website.`,
    '  3. SCREEN ("computer" step) — screenshots and a grid. Roughly 150 seconds per action and it can be',
    '     wrong about what it clicked. Use ONLY for native desktop apps with no web version: Notepad,',
    '     Explorer, Settings, VS Code, Word.',
    'Sending an email, searching, filling a form or reading a site is browser work, never screen work.',
  ].join('\n');
}
