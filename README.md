# Woboo

**A body for your AI.**

Woboo is a body for your AI. Where most coding tools stop at *"I wrote the code,"* Woboo keeps going: you hand it a task, and it plans the work, operates your PC and drives your existing coding tools to do it, and then — crucially — **tests the result before handing it back**. Its core is a foreman loop, `intake → plan → delegate → verify → repair → report`, built around the one part that actually matters: verify/repair. A step isn't "done" because the model claims it is; it's done only when a real command says so. When a check fails, Woboo takes the concrete error, hands it back to the crew, and tries again — so what you get back is work that's been proven, not just promised. It runs offline with a deterministic fallback plan when no model is reachable, keeps an honest little face that reflects what it's actually doing (thinking, working, testing, or dozing off while it waits), and stays under your control with a STOP you can hit at any time.

```
  ▄▄   ▄▄
 ( o   o )   wobo — a body for your AI
  \  ‾  /
```

---

## The loop

```
intake  →  plan  →  delegate  →  verify  →  repair  →  report
                        ↑                      │
                        └──────────────────────┘
                          concrete error, handed back
```

- **intake** — you give it a sentence.
- **plan** — the brain returns a short, structured plan. Every step carries a `verify` command.
- **delegate** — the building goes to a coding tool you already have installed (Claude Code or Codex).
- **verify** — Woboo runs the check. Not "did the model sound confident" — did the command exit 0.
- **repair** — on failure, the actual error text goes back to the crew with a diagnosis, up to `maxRepairs` times.
- **report** — the summary says how many steps were *proven by a command*, and it says so honestly when nothing was checkable.

The self-test exists to prove this is real:

```bash
wobo selftest
```

It runs two steps — one that must pass its check and one that must **fail** it — and only passes if the failing step was actually caught and retried.

---

## Install

Requires **Node 20+**.

```bash
git clone <this repo> wobo
cd wobo
npm install
npm link          # optional — puts `wobo` on your PATH
```

Then see what your machine can actually do:

```bash
wobo doctor
```

```
  ✓ node          v24.11.1
  ✓ home          C:\Users\you\.wobo
  ✓ brain sdk     @anthropic-ai/sdk present
  ! brain auth    no credentials — Woboo will use offline plans
  ! crew: claude  not installed
  ✓ port          4477 available
  ✓ eyes          captured 1920x1080
  ✓ hands         mode: ask
  ✓ stop latch    clear
```

Nothing in that list is fatal. Missing credentials means deterministic plans instead of clever ones; a missing coding tool means `delegate` steps can't run and Woboo will tell you so rather than pretending.

---

## Use

```bash
wobo widget                # the desktop companion — this is the main way to run it
wobo up                    # browser panel — prints a URL carrying your owner key
wobo up --port 4500 --open # pick a port, open the browser

wobo run "add a /health endpoint and a test that hits it"
wobo run "fix the failing build" --workspace ./api

wobo doctor                # what works here
wobo selftest              # prove the verify/repair loop
wobo stop                  # engage STOP — kills running work, blocks new work
wobo resume                # release it
wobo look                  # screenshot
wobo log 60                # tail the journal
wobo set hands allow       # change a setting (no args lists them all)
wobo key                   # reprint the dashboard URL
```

The CLI, the widget and the panel drive the same modules. They are faces on one body, never separate implementations.

---

## Memory

Without memory every mission starts from zero: the diagnosis `brain.repair()` worked out yesterday dies with the process, and tomorrow Woboo makes the same mistake at full price. That's the difference between a contractor and a colleague — a colleague's value compounds.

[src/memory.mjs](src/memory.mjs) is per-workspace, on disk, and deliberately small. It's written at the three moments the foreman already reaches:

| When | What's kept |
| --- | --- |
| a verify failed and the brain diagnosed why | the lesson — repeats strengthen it rather than duplicating |
| a mission ended | the outcome, and a score for every check that ran |
| you corrected it (`/note`, or `wobo` at the prompt) | a correction, ranked above anything Woboo concluded alone |

The check scoring is the part that earns its keep. A command that has run five times and never once failed hasn't proved anything — so Woboo tracks which checks have actually *caught* something and tells the planner the difference:

```
Checks that have genuinely caught problems here:
- `npm test` (failed 1 of 1 runs)
Checks that have never once failed here, so they prove little: `npm run lint`
Learned the hard way on earlier missions:
- the test imported the app before the server was created (hit 2x)
```

That digest rides into every plan. It's capped and pruned on purpose — memory that grows without bound stops being context and starts being noise.

```bash
wobo memory              # what it remembers about this directory
wobo memory --all        # every workspace it knows
wobo memory --forget     # wipe this workspace's memory
```

---

## From your phone

```bash
wobo secret telegram <token>   # from @BotFather
wobo telegram
```

Long polling, not a webhook — a machine under your desk shouldn't need a public URL, a tunnel, or an inbound port to be reachable. Woboo dials out.

**Pairing is required before it will obey anything.** Whoever holds the bot token can message the bot; that must not be enough to drive your machine. On first run Woboo prints a one-time code in *your* terminal, and the only message it accepts until you send it is `/pair <code>`. Everything from any other chat is ignored and journalled.

Send any message to start a mission. Commands: `/status`, `/stop`, `/resume`, `/look` (screenshot), `/log`, `/memory`, `/note <text>`.

The point isn't sending tasks from the sofa — it's that **the approval gate travels with you**. An approval that auto-denies is useless if you're the only one who can answer it and you're not at the keyboard. On Telegram the ALLOW / DENY buttons are in your pocket, and answering one resolves the same `guard` request the desktop widget would have shown.

---

## Operating the machine

Most of Woboo delegates the typing to a coding tool. [src/pilot.mjs](src/pilot.mjs) is the part that doesn't — it drives the mouse and keyboard itself, the way a person sitting at the machine would. Browsing the web, clicking through a GUI, reading a desktop app's interface: work that has no command-line equivalent.

```
capture → the model sees pixels → it returns an action → hands perform it → capture again
```

Plans can contain a `computer` step whose instruction is a **goal**, not a script of clicks — Woboo decides where to click by looking:

```
wobo run "open Chrome, search for elephants, and tell me the top result"
```

Available actions: screenshot, click (left/right/middle, double, triple), mouse move, click-drag, mouse down/up, type, key combos, scroll, wait, and zoom — cropping a region of the real screen at full resolution to read text too small to resolve in a full-screen shot.

**Coordinates are handled here, not by the API.** Claude returns coordinates in the space of the image it was shown, and the API silently downscales anything oversized — which would leave Woboo clicking the wrong pixels with no way to know by how much. So Woboo does the resizing itself and keeps the scale factor. A 1920×1080 desktop is under the 2576px limit, so it goes across untouched and coordinates map 1:1.

**Consent is per goal, not per click.** Approving each of fifty clicks is unusable; approving none is untrustworthy. So Woboo asks once — *"let me drive the screen until this goal is done"* — and then moves freely inside it. STOP still kills it mid-stride, the session ends when the step does, and every single act is journalled.

> This is the one capability that genuinely needs credentials: the model has to **see** the screenshots. Without a key, `computer` steps report that plainly rather than pretending.

---

## The app

`wobo widget` starts the whole thing, not just the floating head:

```
launcher  →  ┌── console  (1120×760 app window)
             ├── companion (the floating head)
             └── tray icon (the face, in the state colour)
```

The **launcher** is a frameless, transparent card that shows the real boot — waking up, finding the crew, waking the brain, opening its eyes, starting the console, reaching your phone. Each line lands when that check actually finishes; nothing on it is a decorative progress bar. If the crew is missing, the line says so, in amber, before the app even opens.

The **console** is the full window: the same dashboard the browser panel serves, so there is exactly one implementation of it — the app just gives it a dark native title bar and a frame. Links open in your real browser rather than trapping you inside the app window.

If the default port is taken (a stale `wobo up`, another Woboo), the app walks up to the next free one instead of refusing to open its own window. `wobo up --port N` stays strict, because a named port that silently becomes a different port is worse than an error.

---

## The companion

`wobo widget` puts Woboo on your desktop: a frameless, transparent, always-on-top head that sits above your other windows and reacts to what it is actually doing.

```
        ╭───────────────╮
        │      ┃        │   ← antenna LED breathes in the state colour
        │  ▄▄▄     ▄▄▄  │
        │ (  o     o  ) │   ← the face is the live foreman state
        │      \ ‾ /    │
        ╰───────────────╯
             WORKING
          step 2 of 4
```

- **Drag the head** to move it anywhere; it remembers where you left it.
- **Hover** and the window grows a panel — task box, step list, STOP, and buttons for LOOK / PANEL / HIDE. Move away and it shrinks back to just a head. It refuses to shrink while a mission is running, while an approval is waiting, or while you're typing.
- **Approvals appear on the widget.** They have to: an unanswered request auto-denies, so the companion expands and surfaces the card with a live countdown.
- **The tray icon is the face too**, redrawn in the state colour, so you can hide the widget entirely and still see what Woboo is doing. Right-click for STOP, screenshot, the full panel, and quit.
- **The full browser panel is still there** — the tray's *Open full panel…* starts it on demand, so Woboo doesn't hold a listening port open just to sit on your desktop.

The Electron main process imports `foreman`, `guard` and `face` directly. The widget is a face on the real body, not a remote control talking to a server.

> Chromium blocks ES-module imports over `file://`, so rather than ship module plumbing into the window, the main process renders the face to SVG and hands the markup across. The renderer only draws.

---

## The face

The face isn't decoration — it's the state machine, rendered. Each expression maps to something the foreman is genuinely doing, so a glance tells you where the mission is without reading a log.

| Face | Means |
| --- | --- |
| `asleep` | no mission, idle a long while |
| `idle` | ready, blinking |
| `listening` | took a task, hasn't planned yet |
| `thinking` | asking the brain for a plan |
| `working` | executing a step |
| `testing` | a verify command is running right now — the skeptical squint |
| `happy` | mission verified |
| `confused` | verify failed, handing it back to the crew |
| `error` | mission failed or refused |
| `stopped` | STOP engaged |

If Woboo is squinting, a check is actually executing. It never smiles at unverified work.

---

## Safety

Woboo can type into your machine, so the safety model is the design rather than a wrapper around it.

**STOP** — a latch on disk that outlives the process. While engaged, nothing acts: queued approvals are denied, running child processes are killed, and new missions are refused. Woboo cannot clear it — only you can, with `wobo resume` or the dashboard button. It's the software mirror of the physical STOP button on the hardware version.

**Allowlist before execution** — commands are classified *before* they run, never after. Build, test, and version-control verbs are allowed; recursive deletes, disk formatting, power control, force pushes, hard resets, pipe-to-shell, registry writes and permission changes are refused outright. Every segment of a chained command is classified on its own, so `npm test && <anything>` can't ride in on the first verb.

**Approvals** — anything ambiguous stops and asks you, and times out into a *denial* rather than hanging. On a TTY the CLI prompts inline; in the dashboard it's a modal. Hands default to asking every single time (`hands: "ask"`).

**Owner key** — the dashboard binds to `127.0.0.1` only, and every route including the page itself requires a key minted to `~/.wobo/owner.key` with mode `0600`. Localhost is not a trust boundary: any process on your box can reach that port, so the key is what separates you from something merely running as you.

**Journal** — every action is appended to `~/.wobo/journal.jsonl`. It's both the audit trail that makes a machine-driving agent trustworthy and the live feed the dashboard renders.

**Instructions are never interpolated into command strings.** Model-authored text reaches the coding tools as a single `argv` entry, so a spec full of quotes and shell metacharacters is inert.

---

## Settings

`~/.wobo/settings.json`, editable with `wobo set <key> <value>`.

| Key | Default | What it does |
| --- | --- | --- |
| `port` | `4477` | dashboard port |
| `model` | `claude-opus-5` | the planning brain |
| `effort` | `high` | intelligence/cost dial |
| `crew` | `auto` | which coding tool to delegate to; `auto` picks the first found |
| `workspace` | `null` | where missions run; `null` means wherever Woboo started |
| `hands` | `ask` | `ask`, `allow`, or `off` |
| `maxRepairs` | `2` | how many times a failed verify may be handed back |
| `approvalTimeout` | `120` | seconds before an unanswered request auto-denies |
| `allowCommands` | `[]` | extra executables you trust, on top of the built-in allowlist |

---

## How it's put together

No build step, no framework, no bundler. One optional dependency.

| File | Role |
| --- | --- |
| [wobo.mjs](wobo.mjs) | the CLI — every command lives here |
| [desktop/main.mjs](desktop/main.mjs) | the companion's main process — window, tray, IPC |
| [desktop/widget.html](desktop/widget.html) | the widget itself, one self-contained file |
| [desktop/preload.cjs](desktop/preload.cjs) | the only bridge into the renderer |
| [desktop/icon.mjs](desktop/icon.mjs) | the tray face, encoded to PNG with zlib and no assets |
| [src/faceart.mjs](src/faceart.mjs) | the face as geometry — one source of truth for widget and panel |
| [src/foreman.mjs](src/foreman.mjs) | the loop: plan, delegate, verify, repair, report |
| [src/brain.mjs](src/brain.mjs) | planning and diagnosis via structured output; deterministic fallback when offline |
| [src/crew.mjs](src/crew.mjs) | finds and briefs the installed coding tools |
| [src/guard.mjs](src/guard.mjs) | STOP, the allowlist, and owner approvals |
| [src/shell.mjs](src/shell.mjs) | the only place a command ever runs |
| [src/ps.mjs](src/ps.mjs) | raw argv execution for Woboo's own vetted scripts |
| [src/memory.mjs](src/memory.mjs) | what Woboo carries between missions |
| [src/telegram.mjs](src/telegram.mjs) | the bot — tasks and approvals from your phone |
| [src/pilot.mjs](src/pilot.mjs) | the see→think→act loop that operates the GUI |
| [src/eyes.mjs](src/eyes.mjs) | screenshots, no native modules |
| [src/hands.mjs](src/hands.mjs) | real keystrokes, clicks, drags and scrolls (Windows) |
| [src/face.mjs](src/face.mjs) | the ten states |
| [src/bus.mjs](src/bus.mjs) | the nervous system every subscriber listens to |
| [src/journal.mjs](src/journal.mjs) | the append-only record |
| [src/config.mjs](src/config.mjs) | settings, paths, owner key |
| [src/server.mjs](src/server.mjs) | loopback HTTP + SSE over the same modules |
| [src/ui.mjs](src/ui.mjs) | the dashboard, one self-contained page |

---

## Honest limitations

- **Launch the widget with `wobo widget`, not `npx electron` directly.** VS Code and other Electron hosts export `ELECTRON_RUN_AS_NODE=1`, and a child process inherits it — which makes `electron.exe` boot as a plain Node runtime with no app and no window. The CLI strips that variable before spawning; a raw `electron desktop/main.mjs` from a VS Code terminal will not.
- **Hands are Windows-only.** Typing, clicking and window focus go through PowerShell and `user32`. Eyes work everywhere (`.NET` on Windows, `screencapture` on macOS, ImageMagick on Linux); everything else is cross-platform.
- **`delegate` steps need a coding tool installed.** Woboo doesn't write the code — that's the whole idea. Without Claude Code or Codex on PATH it says so instead of improvising.
- **Without credentials the plans are dumb on purpose.** The offline plan hands the whole task to the crew and runs whatever check the project already defines. Less clever, completely predictable — the body works without the cloud.
- **A step with no possible check is reported as unproven**, not as success.

---

## License

MIT © Rayane Sbaa ([SbxTheDead](https://github.com/SbxTheDead))
