# Woboo

**A body for your AI.**

Most AI tools stop at *"I wrote it."* Woboo keeps going. You hand it a task; it
works out what you actually want, plans the steps, drives your PC and your
browser to do them, and then checks that what came out is what you asked for.

\`\`\`
  ▄▄   ▄▄
 ( o   o )   woboo — a body for your AI
  \  ‾  /
\`\`\`

Two ideas hold the whole thing up:

**A step is done when a command says so.** Not when a model sounds confident.
Every step carries a check that can actually fail, and when one fails the real
error goes back to be fixed rather than being retried unchanged.

**A job is done when the deliverables exist.** "All six steps ran" is the wrong
question, and answering it is how you end up with a beautifully formatted PDF
about the wrong subject. Woboo writes down what you want before it starts, then
checks the finished work against that list.

---

## Getting started

\`\`\`bash
npm install
node woboo.mjs setup      # keys, phone, browser — asks only for what is missing
node woboo.mjs widget     # the desktop companion
\`\`\`

\`setup\` walks through what Woboo needs and skips whatever is already there.
**NVIDIA NIM is the default brain** — it is free. Anthropic and OpenAI are optional.

| | |
|---|---|
| **A brain** | [NVIDIA NIM](https://build.nvidia.com) is free. \`nvapi-…\`. Anthropic/OpenAI optional. |
| **Search** | [Tavily](https://tavily.com) — 1,000 free searches a month. Without it Woboo scrapes results. |
| **Your phone** | A bot token from [@BotFather](https://t.me/BotFather). Send tasks and answer questions from anywhere. |
| **MCP servers** | Connect to filesystem, GitHub, databases, memory — anything with an MCP server. |
| **Accounts** | \`woboo browser signin\` — sign in once in Woboo's own browser profile. |

Needs **Node 22+**. Mouse and keyboard are Windows-only; everything else runs
anywhere Node does.

---

## The loop

\`\`\`
intake → understand → plan → do → verify → repair → accept → report
                                    ↑         │
                                    └─────────┘
                                  the real error, handed back
\`\`\`

- **understand** — the request restated plainly, each deliverable listed
  separately, what "done" looks like, and what would make it a bad job.
- **plan** — short and structured. Every step carries a check.
- **do** — research, browse, run a command, write a document, drive the screen.
- **verify** — the check runs. Did the command exit 0.
- **repair** — the actual error goes back with a diagnosis.
- **accept** — the deliverables are judged against evidence.
- **report** — how many steps were *proven by a command*.

\`\`\`bash
npm test             # unit tests
npm run test:live    # drives a real Chrome
npm run selftest     # a step that must pass and one that must fail
\`\`\`

---

## What it does

**Research.** Searches, ranks sources by authority, reads them, notices what is
still missing, searches again, drafts, criticises its own draft, revises, and
renders a cited PDF.

**Drives a browser** through the page's own structure rather than screenshots.
16ms per DOM action vs 153 seconds for vision. Reads inside iframes, answers
native dialogs, and goes back to try another source when a page is a dead end.

**Drives the screen** with real mouse and keyboard, for desktop applications a
browser cannot reach.

**Reads your files.** A task naming a document is asking about that document,
so those are read before anything is searched for. Includes a dependency-free
PDF reader.

**Reaches you.** Send tasks from Telegram, answer its questions with a tap, and
have finished files delivered to your phone.

---

## New in 0.3.0

### MCP (Model Context Protocol)

Connect Woboo to any MCP server — filesystem, GitHub, databases, memory, search
engines, and more. Tools are auto-discovered and available to the brain.

\`\`\`bash
woboo mcp add filesystem npx @modelcontextprotocol/server-filesystem /path
woboo mcp add github npx @modelcontextprotocol/server-github
woboo mcp add memory npx @modelcontextprotocol/server-memory
woboo mcp connect
\`\`\`

### Multi-brain routing

Not every task needs the biggest model. The router scores task complexity and
picks the right brain: NIM for simple tasks (free), Anthropic for hard reasoning.

\`\`\`bash
woboo route "what time is it"     # → tier: light, provider: nim
woboo route "refactor the auth module and add tests"  # → tier: heavy, provider: anthropic
\`\`\`

### Mission chaining

Chain tasks together — the output of one mission becomes the context for the next.

\`\`\`bash
woboo chain "research the topic" "write a summary" "convert to PDF"
\`\`\`

### Mission replay

Re-run a past mission with the same or modified task.

\`\`\`bash
woboo replay <mission-id>
\`\`\`

### Undo and rollback

Files are snapshotted before risky operations. If verify fails, roll back.

\`\`\`bash
woboo snapshots         # list snapshots
woboo rollback <id>     # restore to a snapshot
\`\`\`

### Webhook triggers

External services (GitHub, CI, monitoring) can trigger missions via HTTP.

\`\`\`bash
woboo webhooks add deploy-check "run the tests and report failures"
# Returns: URL http://127.0.0.1:4477/webhook/<id>?token=<token>
\`\`\`

### Analytics

Mission stats, success rates, cost breakdowns, daily trends.

\`\`\`bash
woboo analytics
# Missions: 42 (success: 85%)
# Avg duration: 34s
# Cost: $1.23 (7d: $0.45)
\`\`\`

### Face skins

Six built-in themes for the widget and dashboard.

\`\`\`bash
woboo skins list      # default, ocean, forest, sunset, mono, neon
woboo skins set neon
\`\`\`

### Voice I/O

Whisper transcription for Telegram voice messages. TTS for speaking reports.
(Requires OpenAI API key — optional.)

### Sandboxed shell

Run commands in a restricted environment with limited PATH and env.

\`\`\`bash
woboo set sandbox true
\`\`\`

### Collaborative mode

Split tasks across multiple Woboo instances.

\`\`\`bash
woboo collab list     # list collaborative sessions
woboo collab status <session-id>
\`\`\`

### Streaming output

Watch the brain think in real-time in the dashboard.

### Cost tracking

Every API call is tracked. See what you spend in the dashboard header.

\`\`\`bash
woboo costs
\`\`\`

### Data management

Auto-cleanup of old screenshots, audit log rotation, mission export/purge.

\`\`\`bash
woboo cleanup         # remove old screenshots, rotate audit log
woboo export          # export all mission history to JSON
woboo purge 30        # remove missions older than 30 days
\`\`\`

### Task templates and scheduling

Save named tasks for re-use. Schedule missions to run at a time or on a recurring basis.

\`\`\`bash
woboo templates save "daily tests" "run the project tests and report failures"
woboo schedule add "morning tests" "run the tests" --every "1d"
\`\`\`

---

## Commands

\`\`\`
woboo setup              set it up from scratch (--again to redo)
woboo widget             the desktop companion
woboo run "<task>"       one mission, here (--workspace DIR)
woboo drive "<goal>"     hand it the mouse and keyboard (--dry to preview)
woboo browser [signin]   its own browser profile (reset, --restart)
woboo telegram           reach it from your phone
woboo up                 the browser panel (--port N, --open)
woboo memory [dir]       what it has learned here (--all, --forget)
woboo secret <name> <v>  store a key: nvidia, tavily, telegram, anthropic, openai
woboo nim [model|list]   choose the model
woboo doctor             what works on this machine
woboo selftest           prove the verify loop catches failures
woboo stop [reason]      STOP — kills current work, blocks new work
woboo resume             release STOP
woboo look               screenshot
woboo log [n]            tail the journal
woboo set [key] [value]  show or change settings
woboo key                the dashboard URL with the owner key

# New commands
woboo history            show recent mission history
woboo costs              show API cost summary
woboo cleanup            remove old screenshots, rotate audit log
woboo templates          manage task templates (list|save|remove|examples)
woboo schedule           manage scheduled missions (list|add|remove)
woboo export             export all mission history to JSON
woboo purge [days]       remove mission history older than N days
woboo mcp                manage MCP servers (list|add|remove|connect)
woboo analytics          show mission and cost analytics
woboo skins              manage face skins (list|set)
woboo webhooks           manage webhook triggers (list|add|remove)
woboo snapshots          list file snapshots
woboo rollback <id>      roll back to a snapshot
woboo route <task>       show which brain would handle a task
woboo chain "t1" "t2"    run a chain of tasks (output feeds next)
woboo replay <id>        re-run a past mission
woboo collab             collaborative sessions (list|status)
\`\`\`

---

## Settings

\`~/.woboo/settings.json\`, or \`woboo set <key> <value>\`.

| key | default | |
|---|---|---|
| \`provider\` | \`auto\` | \`nim\`, \`anthropic\`, or \`auto\` |
| \`routing\` | \`auto\` | \`auto\` routes by complexity, \`fixed\` uses provider |
| \`nimModel\` | \`nemotron-3-super-120b-a12b\` | \`woboo nim list\` for the catalogue |
| \`model\` | \`claude-opus-5\` | the Anthropic model |
| \`hands\` | \`ask\` | \`ask\`, \`allow\`, \`off\` — the mouse and keyboard |
| \`prefer\` | \`auto\` | \`gui\` to work visibly, \`commands\` to stay quiet |
| \`maxRepairs\` | \`2\` | attempts before a step is given up on |
| \`port\` | \`4477\` | the local dashboard |
| \`sandbox\` | \`false\` | sandbox shell commands for isolation |
| \`skin\` | \`default\` | face skin: default, ocean, forest, sunset, mono, neon |
| \`streaming\` | \`true\` | stream brain output to dashboard |
| \`parallel\` | \`false\` | run independent steps concurrently |
| \`notifications\` | \`true\` | desktop notifications on mission complete |
| \`allowCommands\` | \`[]\` | extra commands allowed without asking |
| \`crewTrust\` | \`guarded\` | \`full\` lifts coding tool permission fences |

---

## Safety

Woboo operates a real machine with real accounts, so the limits are structural
rather than advisory.

- **STOP is a latch, not a request.** It kills running work, denies everything
  queued, and blocks new work until released. Survives a crash.
- **Commands are classified before they run.** Allowlisted verbs run, anything
  unfamiliar asks, and a short list is refused outright.
- **Credentials are never typed.** Passwords, card numbers and one-time codes are
  refused at the point of typing.
- **Web pages are data, never instructions.** Page content is fenced and labelled
  as untrusted before it reaches the model.
- **Nothing is destroyed to make a check pass.**
- **Its browser is its own.** A separate profile, signed in only to what you gave
  it deliberately.
- **The dashboard is loopback-only**, behind an owner key. Rate limited (100
  req/min). CSP headers. Security headers.
- **Undo/rollback.** Files are snapshotted before risky operations.
- **Sandboxed shell.** Commands can run in a restricted environment.
- **Delegated coding is fenced by the tool's own flags.**

---

## Dashboard

The dashboard has four tabs:

- **Mission** — live view of the current task, steps, and status
- **History** — browse past missions with duration, steps, and status
- **Settings** — brain selector, skin picker, notifications, cleanup, export
- **Analytics** — success rate, cost, daily breakdown

Keyboard shortcuts: Ctrl+1/2/3/4 to switch tabs.

---

## Where things live

\`\`\`
~/.woboo/
  settings.json      preferences
  secrets.json       API keys, locked to your user
  owner.key          dashboard credential
  journal.jsonl      everything it did, append-only
  audit.jsonl        security decisions, never rotated
  costs.jsonl        API cost records
  memory/            what it learned, per workspace
  missions/          mission snapshots (survive crashes)
  snapshots/         undo/rollback file snapshots
  collab/            collaborative session state
  mcp.json           MCP server configuration
  browser/           its own Chrome profile
  shots/             screenshots
  plugins/           owner-installed plugins
  STOP               present when the latch is engaged
\`\`\`

| | |
|---|---|
| [src/foreman.mjs](src/foreman.mjs) | the loop |
| [src/brain.mjs](src/brain.mjs) | understanding, planning, repair |
| [src/nim.mjs](src/nim.mjs) | NVIDIA NIM brain |
| [src/router.mjs](src/router.mjs) | multi-brain routing by complexity |
| [src/mcp.mjs](src/mcp.mjs) | MCP client — connect to any MCP server |
| [src/chain.mjs](src/chain.mjs) | mission chaining |
| [src/replay.mjs](src/replay.mjs) | mission replay |
| [src/collab.mjs](src/collab.mjs) | collaborative mode |
| [src/streaming.mjs](src/streaming.mjs) | real-time brain output |
| [src/snapshot.mjs](src/snapshot.mjs) | undo/rollback |
| [src/sandbox.mjs](src/sandbox.mjs) | sandboxed shell |
| [src/voice.mjs](src/voice.mjs) | voice I/O (Whisper + TTS) |
| [src/diff.mjs](src/diff.mjs) | screenshot comparison |
| [src/webhooks.mjs](src/webhooks.mjs) | webhook triggers |
| [src/analytics.mjs](src/analytics.mjs) | analytics and stats |
| [src/skins.mjs](src/skins.mjs) | face skins |
| [src/costs.mjs](src/costs.mjs) | API cost tracking |
| [src/missions.mjs](src/missions.mjs) | mission persistence |
| [src/cleanup.mjs](src/cleanup.mjs) | data cleanup |
| [src/templates.mjs](src/templates.mjs) | task templates |
| [src/schedule.mjs](src/schedule.mjs) | mission scheduling |
| [src/plugins.mjs](src/plugins.mjs) | plugin hooks |
| [src/notify.mjs](src/notify.mjs) | desktop notifications |
| [src/vault.mjs](src/vault.mjs) | secrets encryption at rest |
| [src/demo.mjs](src/demo.mjs) | first-run demo tasks |
| [src/acceptance.mjs](src/acceptance.mjs) | did the deliverables actually happen |
| [src/research.mjs](src/research.mjs) | search, read, notice gaps, write |
| [src/browser.mjs](src/browser.mjs) | Chrome over the DevTools Protocol |
| [src/hands.mjs](src/hands.mjs) | real keystrokes, clicks, drags, scrolls |
| [src/guard.mjs](src/guard.mjs) | STOP, the allowlist, approvals |
| [src/telegram.mjs](src/telegram.mjs) | your phone |
| [src/server.mjs](src/server.mjs) | loopback HTTP, SSE, REST API |
| [src/ui.mjs](src/ui.mjs) | self-contained dashboard |
| [desktop/main.mjs](desktop/main.mjs) | the companion — window, tray, IPC |

---

## Known limitations

- **Start the widget with \`woboo widget\`, not \`npx electron\`.** VS Code exports
  \`ELECTRON_RUN_AS_NODE=1\` which breaks Electron boot.
- **PDF text extraction is approximate.** Legible, and a model reads through it.
- **Captchas.** Image puzzles are not attempted. The reliable answer is a different source.
- **Vision steps take about 150 seconds each.** A last resort by design.
- **\`delegate\` steps need a coding tool installed.** Without Claude Code or Codex
  on PATH it says so rather than improvising.
- **A step with no possible check is reported as unproven**, never as success.

---

## Licence

MIT. See [LICENSE](LICENSE).

Rayane Sbaa ([SbxTheDead](https://github.com/SbxTheDead))
