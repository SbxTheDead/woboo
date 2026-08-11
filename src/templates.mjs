// Saved task templates. A template is a named task the owner can re-run:
// "research X and PDF it", "check the tests and push", "summarise my inbox".
// Stored in settings so they travel with everything else.

import { loadSettings, saveSettings } from './config.mjs';

export function list() {
  return loadSettings().templates || [];
}

export function save(name, task) {
  const settings = loadSettings();
  const templates = settings.templates || [];
  const existing = templates.findIndex((t) => t.name === name);
  if (existing >= 0) {
    templates[existing] = { name, task, updatedAt: new Date().toISOString() };
  } else {
    templates.push({ name, task, createdAt: new Date().toISOString() });
  }
  saveSettings({ templates });
  return templates;
}

export function remove(name) {
  const settings = loadSettings();
  const templates = (settings.templates || []).filter((t) => t.name !== name);
  saveSettings({ templates });
  return templates;
}

export function get(name) {
  return (loadSettings().templates || []).find((t) => t.name === name) || null;
}

// Built-in examples shown on first run.
export const EXAMPLES = [
  { name: 'Research a topic', task: 'Research the top 5 advantages and disadvantages of remote work in 2025. Deliver a PDF.' },
  { name: 'Run tests', task: 'Run the project tests and report any failures.' },
  { name: 'Check the screen', task: 'Take a screenshot and describe what is on screen.' },
  { name: 'Summarise a file', task: 'Read the README in this workspace and summarise it in one paragraph.' },
  { name: 'Find internships', task: 'Find 5 software engineering internships in Europe. For each, collect title, company, city, and application link.' },
];
