# Woboo Architecture

## Overview

Woboo is an AI agent that operates your PC. It plans tasks, drives browsers, uses mouse and keyboard, does research, writes documents, and verifies its own work through a verify/repair loop.

The core loop is: **intake → understand → plan → do → verify → repair → accept → report**

## Module Map

\`\`\`
woboo.mjs          CLI entry point — commands, terminal approvals, journal mirroring
src/
  foreman.mjs      Core mission loop — plan, execute, verify, repair, accept, report
  brain.mjs        AI planning — structured JSON output, Anthropic + NIM providers
  guard.mjs        Safety — STOP latch, command classification, owner approval
  config.mjs       Settings, secrets, paths, .env loading, proxy resolution
  server.mjs       Loopback HTTP server — SSE dashboard, REST API
  browser.mjs      Chrome DevTools Protocol driver — DOM-based interaction
  telegram.mjs     Telegram bot — long-polling, approvals, file delivery
  research.mjs     Research loop — search, read, gap analysis, draft, critique, PDF
  hands.mjs        Real mouse/keyboard — Windows user32.dll via PowerShell
  ui.mjs           Self-contained dashboard HTML/CSS/JS
  journal.mjs      Append-only audit journal with rotation
  audit.mjs        Security decision log (never rotated)
  vault.mjs        Secrets encryption at rest (DPAPI / derived key)
  costs.mjs        API cost tracking — per-call and running totals
  missions.mjs     Mission persistence and history
  cleanup.mjs      Data cleanup — old screenshots, audit rotation
  templates.mjs    Task templates and built-in examples
  schedule.mjs     Mission scheduling — timed and recurring
  faceart.mjs      Face rendering — SVG expressions mapped to state
  bus.mjs          Event bus — SSE publish/subscribe
desktop/
  main.mjs         Electron companion — widget, tray, console window
\`\`\`

## Data Flow

1. **Task submission**: CLI or dashboard → `foreman.runMission()`
2. **Planning**: `brain.plan()` → structured JSON plan with steps
3. **Execution**: `foreman.runStep()` dispatches to the appropriate handler:
   - `research` → `research.mjs` loop
   - `web` → `browser.mjs` CDP driver
   - `shell` → `guard.clearToRun()` → child_process
   - `computer` → `hands.mjs` mouse/keyboard
   - `compose` → direct text generation
   - `delegate` → sub-agent
4. **Verification**: `brain.plan()` again with verify context → verify commands
5. **Repair** (if needed): `brain.repair()` → new plan for failed steps
6. **Report**: Final summary delivered to dashboard/Telegram

## Safety Architecture

- **STOP latch**: File-based, survives crashes. Any process can halt the mission.
- **Command classification**: Allowlist (safe), forbid (dangerous), ask (needs approval)
- **Owner approval**: Timeout-based, travels to Telegram. Auto-denies on timeout.
- **Credential refusal**: Refuses to type passwords or tokens at the typing point.
- **Separate browser profile**: Woboo's browsing never touches the owner's profile.
- **Loopback-only server**: Dashboard only listens on 127.0.0.1.
- **Timing-safe key comparison**: Owner key auth uses constant-time comparison.
- **Rate limiting**: 100 requests/minute per IP.
- **CSP headers**: Content Security Policy on dashboard HTML.

## Key Design Decisions

- **DOM-based, not screenshot-based**: Browser driver reads the DOM directly via CDP. 16ms per action vs 153 seconds for vision-based approaches.
- **No build step**: Dashboard is a single self-contained HTML page. No React, no bundler.
- **Append-only journal**: Audit trail that rotates at 512KB. Torn lines are repaired on read.
- **Per-workspace memory**: Lessons, corrections, and facts persist across missions.
- **Offline fallback**: If no brain is available, a built-in plan handles common cases.
\`\`\`
