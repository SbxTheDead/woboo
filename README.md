# Woboo

**A body for your AI.**

Most AI tools stop at *"I wrote it."* Woboo keeps going. You hand it a task; it
works out what you actually want, plans the steps, drives your PC and your
browser to do them, and then checks that what came out is what you asked for.

```
  ▄▄   ▄▄
 ( o   o )   woboo — a body for your AI
  \  ‾  /
```

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

```bash
npm install
node woboo.mjs setup      # keys, phone, browser — asks only for what is missing
node woboo.mjs widget     # the desktop companion
```

`setup` walks through what Woboo needs and skips whatever is already there.
Everything is optional except a brain.

| | |
|---|---|
| **A brain** | [NVIDIA NIM](https://build.nvidia.com) is free. `nvapi-…` |
| **Search** | [Tavily](https://tavily.com) — 1,000 free searches a month. Without it Woboo scrapes results, which is slower and thinner. |
| **Your phone** | A bot token from [@BotFather](https://t.me/BotFather). Send tasks and answer questions from anywhere. |
| **Accounts** | `woboo browser signin` — sign in once in Woboo's own browser profile and it stays signed in. |

Needs **Node 22+**. Mouse and keyboard are Windows-only; everything else runs
anywhere Node does.

---

## The loop

```
intake → understand → plan → do → verify → repair → accept → report
                                    ↑         │
                                    └─────────┘
                                  the real error, handed back
```

- **understand** — the request restated plainly, each deliverable listed
  separately, what "done" looks like, and what would make it a bad job. Printed
  before any work starts, so a misunderstanding is caught while it is still cheap.
- **plan** — short and structured. Every step carries a check.
- **do** — research, browse, run a command, write a document, drive the screen.
- **verify** — the check runs. Did the command exit 0.
- **repair** — the actual error goes back with a diagnosis. A command with a
  syntax error is rewritten, not run again unchanged.
- **accept** — the deliverables are judged against evidence: what is on disk, how
  many pages, and the first six hundred characters of it.
- **report** — how many steps were *proven by a command*, and plainly when
  nothing was checkable.

```bash
npm test             # 89 unit tests
npm run test:live    # drives a real Chrome
npm run selftest     # a step that must pass and one that must fail
```

---

## What it does

**Research.** Searches, ranks sources by authority, reads them, notices what is
still missing, searches again, drafts, criticises its own draft, revises, and
renders a cited PDF. Content farms and marketing pages are refused outright
rather than ranked low.

**Drives a browser** through the page's own structure rather than screenshots: it
reads every link, button and field with its real text, clicks elements by
identity, and reads back what happened. Measured on one machine, a DOM action
costs 16ms against 153 seconds for a vision step. It reads inside iframes,
answers native dialogs, and goes back to try another source when a page is a dead
end.

**Drives the screen** with real mouse and keyboard, for desktop applications a
browser cannot reach. Slow, so it is chosen only when nothing cheaper will do.

**Reads your files.** A task naming a document — a résumé, a report — is asking
about that document, so those are read before anything is searched for. Includes
a dependency-free PDF reader.

**Reaches you.** Send tasks from Telegram, answer its questions with a tap, and
have finished files delivered to your phone.

---

## Commands

```
woboo setup              set it up from scratch (--again to redo)
woboo widget             the desktop companion
woboo run "<task>"       one mission, here (--workspace DIR)
woboo drive "<goal>"     hand it the mouse and keyboard (--dry to preview)
woboo browser [signin]   its own browser profile (reset, --restart)
woboo telegram           reach it from your phone
woboo up                 the browser panel (--port N, --open)
woboo memory [dir]       what it has learned here (--all, --forget)
woboo secret <name> <v>  store a key: nvidia, tavily, telegram, anthropic
woboo nim [model|list]   choose the model
woboo doctor             what works on this machine
woboo selftest           prove the verify loop catches failures
woboo stop [reason]      STOP — kills current work, blocks new work
woboo resume             release STOP
woboo look               screenshot
woboo log [n]            tail the journal
woboo set [key] [value]  show or change settings
woboo key                the dashboard URL with the owner key
```

Installed as a package, the CLI answers to both `woboo` and `wobo` — the old
name is kept as an alias so existing scripts and muscle memory keep working.

---

## Settings

`~/.woboo/settings.json`, or `woboo set <key> <value>`.

| key | default | |
|---|---|---|
| `provider` | `auto` | `nim`, `anthropic`, or `auto` |
| `nimModel` | `nemotron-3-super-120b-a12b` | `woboo nim list` for the catalogue |
| `hands` | `ask` | `ask`, `allow`, `off` — the mouse and keyboard |
| `prefer` | `auto` | `gui` to work visibly, `commands` to stay quiet |
| `maxRepairs` | `2` | attempts before a step is given up on |
| `port` | `4477` | the local dashboard |
| `allowCommands` | `[]` | extra commands allowed without asking |
| `crewTrust` | `guarded` | `full` lets the delegated coding tool bypass its permission prompts |
| `visibleCursor` | `false` | move the real pointer to where it clicks |

---

## Safety

Woboo operates a real machine with real accounts, so the limits are structural
rather than advisory.

- **STOP is a latch, not a request.** It kills running work, denies everything
  queued, and blocks new work until released. It lives in a file, so it survives
  a crash and can be set without the app running.
- **Commands are classified before they run.** Allowlisted verbs run, anything
  unfamiliar asks, and a short list is refused outright: recursive deletes, disk
  formatting, force pushes, running a downloaded string as code. Every segment of
  a compound command is judged on its own, so `npm test && <anything>` cannot
  ride in on the first verb.
- **Credentials are never typed.** Passwords, card numbers and one-time codes are
  refused at the point of typing, whatever a page claims to need. Woboo stops and
  hands the keyboard back to you.
- **Web pages are data, never instructions.** Page content is fenced and labelled
  as untrusted before it reaches the model, and a page that tries to give orders
  is a reason to stop rather than to comply.
- **Nothing is destroyed to make a check pass.** "Discard", "Delete" and "Don't
  save" are not clicked unless the task asked for it.
- **Its browser is its own.** A separate profile, signed in only to what you gave
  it deliberately — not to everything you happen to be logged into.
- **The dashboard is loopback-only**, behind an owner key compared in constant
  time. Secrets are written with inheritance removed and access granted only to
  you.
- **Delegated coding is fenced by the tool's own flags, not just trusted.** A
  `delegate` step hands work to an installed coding CLI, and that CLI answers to
  its own permission system — Woboo's allowlist cannot see inside it. So the
  brief goes out with the most restrictive flags that still let the tool work:
  Claude Code runs in `acceptEdits` mode with destructive shell patterns denied,
  Codex runs in a `workspace-write` sandbox. Setting `crewTrust` to `full`
  lifts the fence (`bypassPermissions` / `danger-full-access`) — that is the
  owner's call to make, never a default.

---

## Where things live

```
~/.woboo/
  settings.json      preferences
  secrets.json       API keys, locked to your user
  owner.key          dashboard credential
  journal.jsonl      everything it did, append-only
  memory/            what it learned, per workspace
  preferences.json   answers you gave, so it stops asking
  browser/           its own Chrome profile
  shots/             screenshots
  STOP               present when the latch is engaged
```

| | |
|---|---|
| [src/foreman.mjs](src/foreman.mjs) | the loop |
| [src/brain.mjs](src/brain.mjs) | understanding, planning, repair |
| [src/acceptance.mjs](src/acceptance.mjs) | did the deliverables actually happen |
| [src/research.mjs](src/research.mjs) | search, read, notice gaps, write |
| [src/sources.mjs](src/sources.mjs) | find, rank, fetch, choose passages |
| [src/critic.mjs](src/critic.mjs) | reads the draft against the brief |
| [src/document.mjs](src/document.mjs) | print stylesheet and PDF |
| [src/browser.mjs](src/browser.mjs) | Chrome over the DevTools Protocol |
| [src/webpilot.mjs](src/webpilot.mjs) | the decide-act loop for the web |
| [src/capabilities.mjs](src/capabilities.mjs) | which rung a task belongs on |
| [src/pilot.mjs](src/pilot.mjs) | the screen, for what a browser cannot reach |
| [src/hands.mjs](src/hands.mjs) | real keystrokes, clicks, drags, scrolls |
| [src/eyes.mjs](src/eyes.mjs) | screenshots, no native modules |
| [src/guard.mjs](src/guard.mjs) | STOP, the allowlist, approvals |
| [src/telegram.mjs](src/telegram.mjs) | your phone |
| [src/memory.mjs](src/memory.mjs) | lessons that outlive a mission |
| [src/consult.mjs](src/consult.mjs) | asking you, and not asking twice |
| [src/crew.mjs](src/crew.mjs) | finds and briefs installed coding tools |
| [src/shell.mjs](src/shell.mjs) | the only place a command ever runs |
| [src/journal.mjs](src/journal.mjs) | the append-only record |
| [src/server.mjs](src/server.mjs) | loopback HTTP and SSE |
| [desktop/main.mjs](desktop/main.mjs) | the companion — window, tray, IPC |
| [src/faceart.mjs](src/faceart.mjs) | the face as geometry, one source of truth |

---

## Known limitations

- **Start the widget with `woboo widget`, not `npx electron`.** VS Code exports
  `ELECTRON_RUN_AS_NODE=1` and a child inherits it, which makes `electron.exe`
  boot as plain Node with no window. The CLI strips it; a raw invocation does not.
- **PDF text extraction is approximate.** Fonts are merged rather than tracked
  per text run, so some letters come out substituted — `CoUpter Science
  BacSelor` for `Computer Science Bachelor`. Legible, and a model reads through
  it, but not right.
- **Captchas.** The "verify you are human" checkbox is clicked once. Those checks
  also score pointer movement and timing, so it often will not pass, and image
  puzzles are not attempted. The reliable answer is a different source.
- **Vision steps take about 150 seconds each.** A last resort by design.
- **`delegate` steps need a coding tool installed.** Woboo does not write code —
  that is the whole idea. Without Claude Code or Codex on PATH it says so rather
  than improvising.
- **The free model tier is a ceiling.** Multi-step follow-through suffers first.
  `woboo nim list` for heavier options.
- **A step with no possible check is reported as unproven**, never as success.

---

## Licence

MIT. See [LICENSE](LICENSE).

Rayane Sbaa ([SbxTheDead](https://github.com/SbxTheDead))
