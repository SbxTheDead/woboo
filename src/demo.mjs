// First-run demo. When the owner has never run a mission, the dashboard shows
// example tasks they can click to try. This module provides the demo task that
// runs when they pick "Try a demo" — something safe, fast, and impressive.

import { record } from './journal.mjs';

export const DEMO_TASKS = [
  {
    name: 'Take a screenshot',
    task: 'Take a screenshot of the current screen and describe what you see.',
    description: 'See what Woboo sees on your screen right now.',
  },
  {
    name: 'Research something',
    task: 'Research the top 3 benefits of drinking water. Write a short summary.',
    description: 'Watch Woboo search the web, read sources, and write a report.',
  },
  {
    name: 'Run a command',
    task: 'Run the command "echo hello from woboo" and show me the output.',
    description: 'See how Woboo safely runs shell commands with your approval.',
  },
  {
    name: 'Check the time',
    task: 'What time is it right now? Tell me in a friendly way.',
    description: 'A simple task to see the plan-execute-verify loop in action.',
  },
];

export function pickDemo() {
  return DEMO_TASKS[Math.floor(Math.random() * DEMO_TASKS.length)];
}
