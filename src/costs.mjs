// Tracking what the brain costs. Every API call burns tokens, and tokens are
// money. Without a running total the owner has no idea what a week of Woboo
// costs, and a model that plans six steps when two would do is invisible.
//
// The file is append-only like the journal, with a rolling total kept in
// settings so the dashboard can show it without reading the whole file.

import fs from 'node:fs';
import { PATHS, ensureHome, loadSettings, saveSettings } from './config.mjs';

const COST_FILE = () => PATHS.home + '/costs.jsonl';

// Rough pricing per 1M tokens, in USD. Updated for the models Woboo actually
// uses; the owner can override in settings.costs.
const PRICES = {
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'nvidia/nemotron-3-super-120b-a12b': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'meta/llama-3.2-90b-vision-instruct': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function recordUsage({ model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, purpose = '' }) {
  const prices = loadSettings().costs?.[model] || PRICES[model] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost =
    (inputTokens / 1_000_000) * prices.input +
    (outputTokens / 1_000_000) * prices.output +
    (cacheReadTokens / 1_000_000) * prices.cacheRead +
    (cacheWriteTokens / 1_000_000) * prices.cacheWrite;

  const entry = {
    t: new Date().toISOString(),
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost: Math.round(cost * 10000) / 10000,
    purpose,
  };

  try {
    ensureHome();
    fs.appendFileSync(COST_FILE(), JSON.stringify(entry) + '\n');
  } catch {
    // A disk that refuses the write must not fail the step.
  }

  // Update the running total in settings.
  const settings = loadSettings();
  const total = (settings.totalCost || 0) + entry.cost;
  saveSettings({
    totalCost: Math.round(total * 10000) / 10000,
    lastCostAt: entry.t,
  });

  return entry;
}

export function totalCost() {
  return loadSettings().totalCost || 0;
}

export function recentCosts(days = 7) {
  try {
    const data = fs.readFileSync(COST_FILE(), 'utf8');
    const cutoff = Date.now() - days * 86_400_000;
    const entries = data.trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return entries.filter((e) => new Date(e.t).getTime() > cutoff);
  } catch {
    return [];
  }
}

export function usageSummary() {
  const costs = recentCosts(30);
  const byModel = {};
  let totalTokens = 0;
  let totalCost = 0;
  for (const c of costs) {
    totalTokens += (c.inputTokens || 0) + (c.outputTokens || 0);
    totalCost += c.cost || 0;
    byModel[c.model] = (byModel[c.model] || 0) + (c.cost || 0);
  }
  return { totalCost: Math.round(totalCost * 100) / 100, totalTokens, byModel, calls: costs.length };
}
