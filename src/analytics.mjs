// Analytics and stats.
//
// Aggregates mission data, costs, and performance metrics for the analytics
// dashboard. Reads from the missions directory, costs file, and journal.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { history as missionHistory } from './missions.mjs';
import { recentCosts, totalCost } from './costs.mjs';

export function overview() {
  const missions = missionHistory(1000);
  const costs = recentCosts(30);

  const total = missions.length;
  const done = missions.filter((m) => m.state === 'done').length;
  const failed = missions.filter((m) => m.state === 'failed').length;
  const running = missions.filter((m) => m.state === 'running').length;

  const durations = missions
    .filter((m) => m.duration != null)
    .map((m) => m.duration);
  const avgDuration = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  const totalSteps = missions.reduce((sum, m) => sum + (m.steps || 0), 0);
  const avgSteps = total ? Math.round(totalSteps / total) : 0;

  const cost7d = costs
    .filter((c) => new Date(c.t) > new Date(Date.now() - 7 * 86_400_000))
    .reduce((sum, c) => sum + (c.cost || 0), 0);
  const cost30d = costs.reduce((sum, c) => sum + (c.cost || 0), 0);

  return {
    missions: { total, done, failed, running, successRate: total ? Math.round((done / total) * 100) : 0 },
    duration: { avg: avgDuration, min: durations.length ? Math.min(...durations) : 0, max: durations.length ? Math.max(...durations) : 0 },
    steps: { total: totalSteps, avg: avgSteps },
    costs: { total: totalCost(), last7d: Math.round(cost7d * 100) / 100, last30d: Math.round(cost30d * 100) / 100 },
  };
}

export function dailyBreakdown(days = 14) {
  const missions = missionHistory(1000);
  const days_map = {};
  const now = Date.now();

  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    days_map[d] = { missions: 0, done: 0, failed: 0, cost: 0 };
  }

  for (const m of missions) {
    const day = m.startedAt ? new Date(m.startedAt).toISOString().slice(0, 10) : null;
    if (day && days_map[day]) {
      days_map[day].missions++;
      if (m.state === 'done') days_map[day].done++;
      if (m.state === 'failed') days_map[day].failed++;
    }
  }

  const costs = recentCosts(days);
  for (const c of costs) {
    const day = c.t ? c.t.slice(0, 10) : null;
    if (day && days_map[day]) {
      days_map[day].cost += c.cost || 0;
    }
  }

  return Object.entries(days_map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, data]) => ({ day, ...data, cost: Math.round(data.cost * 100) / 100 }));
}
