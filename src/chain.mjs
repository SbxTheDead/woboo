// Mission chaining.
//
// The output of one mission becomes the input of the next. A chain is a
// sequence of missions where each one receives the previous mission's report
// as context. The owner defines the chain; Woboo runs them in order.

import { record } from './journal.mjs';
import { publish } from './bus.mjs';
import * as foreman from './foreman.mjs';

export async function runChain(steps, initialContext = '') {
  const results = [];
  let context = initialContext;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const task = typeof step === 'string' ? step : step.task;
    const fullTask = context ? task + '\n\nContext from previous step:\n' + context : task;

    record('chain', 'step ' + (i + 1) + '/' + steps.length + ': ' + task.slice(0, 80), { level: 'info' });
    publish({ type: 'chain', step: i + 1, total: steps.length, task });

    try {
      const mission = await foreman.runMission(fullTask);
      const report = mission.report || 'No report produced.';
      results.push({ task, report, state: mission.state });
      context = report;
    } catch (err) {
      record('chain', 'step ' + (i + 1) + ' failed: ' + err.message, { level: 'error' });
      results.push({ task, error: err.message, state: 'failed' });
      break;
    }
  }

  const summary = results.map((r, i) => 'Step ' + (i + 1) + ': ' + (r.state === 'done' ? 'OK' : 'FAIL') + ' — ' + r.task).join('\n');
  record('chain', 'completed: ' + results.length + '/' + steps.length + ' steps', { level: results.every((r) => r.state === 'done') ? 'ok' : 'warn' });
  return { results, summary };
}
