// Multi-brain routing.
//
// Not every task needs the biggest model. A simple classification runs through
// the cheap model; a complex multi-step mission gets the heavy one. The router
// picks the brain based on task complexity, available credentials, and cost.
//
// Tiers:
//   - 'light'  → NIM free tier (fast, cheap, good for classification and simple tasks)
//   - 'medium' → NIM heavy or Claude Sonnet (balanced)
//   - 'heavy'  → Claude Opus (expensive, best reasoning)

import { loadSettings, loadSecrets } from './config.mjs';
import { record } from './journal.mjs';
import * as nim from './nim.mjs';

export function tier(task) {
  const settings = loadSettings();
  if (settings.routing === 'fixed') return settings.provider || 'nim';

  // Heuristic complexity scoring.
  const text = String(task || '').toLowerCase();
  let score = 0;

  // Length signals.
  if (text.length > 500) score += 2;
  if (text.length > 2000) score += 2;

  // Multi-step signals.
  const steps = ['then', 'after that', 'next', 'finally', 'also', 'and also', 'plus'];
  for (const s of steps) {
    if (text.includes(s)) score += 1;
  }

  // Complexity signals.
  const complex = ['research', 'analyse', 'analyze', 'compare', 'evaluate', 'architect', 'design', 'refactor', 'migrate'];
  for (const c of complex) {
    if (text.includes(c)) score += 2;
  }

  // Simple signals.
  const simple = ['what time', 'screenshot', 'hello', 'test', 'check if', 'is it'];
  for (const s of simple) {
    if (text.includes(s)) score -= 2;
  }

  if (score <= 0) return 'light';
  if (score <= 3) return 'medium';
  return 'heavy';
}

export function providerFor(tierName) {
  const secrets = loadSecrets();
  const hasAnthropic = Boolean(secrets.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  const hasNim = nim.hasCredentials();

  switch (tierName) {
    case 'light':
      if (hasNim) return 'nim';
      if (hasAnthropic) return 'anthropic';
      return 'nim';
    case 'medium':
      if (hasAnthropic) return 'anthropic';
      if (hasNim) return 'nim';
      return 'nim';
    case 'heavy':
      if (hasAnthropic) return 'anthropic';
      if (hasNim) return 'nim';
      return 'nim';
    default:
      return hasNim ? 'nim' : 'anthropic';
  }
}

export function route(task) {
  const t = tier(task);
  const p = providerFor(t);
  record('router', 'routed to ' + p + ' (tier: ' + t + ')', { level: 'info' });
  return { tier: t, provider: p };
}
