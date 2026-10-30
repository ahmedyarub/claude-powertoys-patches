# Claude Powertoys patches

Patches that add **Powertoys** to Claude Desktop for Windows: browser-like tabs, a session switcher,
side-by-side work, prompt history and search, bookmarks, snippets, a prompt queue, task-list progress with Claude's
own time estimates, a context map, the conversation's topic (ticket, progress, PR), PR check status on tabs, actionable notifications, and more. This repository holds **only the
patches and the patcher**. It contains no code from Claude Desktop.

> Not affiliated with or endorsed by Anthropic. "Claude" and "Claude Desktop" are Anthropic's. The patches are
> modifications for your own copy of the app; using a modified app is at your own risk and subject to Anthropic's
> terms.

- [What is in this repository](#what-is-in-this-repository)
- [How the patches avoid containing Claude Desktop's code](#how-the-patches-avoid-containing-claude-desktops-code)
- [What the patches apply to](#what-the-patches-apply-to)
- [Applying them](#applying-them)
- [What Powertoys adds](#what-powertoys-adds)
- [Every change to the app's own files](#every-change-to-the-apps-own-files)
- [How the package was checked](#how-the-package-was-checked)

## What is in this repository

```
patcher/apply-patches.mjs   the patcher: Node 18+, no dependencies
patches/patches.json        the patch manifest: every file, its hashes and its edits
patches/files/...           files that are entirely new (written for Powertoys), copied in as they are
```

`patches/patches.json` lists 40 files:

- **15 new files** (`"kind": "add"`), all written for Powertoys:
  - `src/vite/build/main/powertoys/0340` … `0351`: the main-process half (settings and stores, the transcript
    reader worker, session status, hotkeys and menus, IPC, system integration, extra windows, notifications
    inbox, restart, and the newer features).
  - `src/vite/build/mainView/0003-powertoys-page.js`: the in-page half (tabs, switcher, panels, keys, the
    windows Powertoys draws inside the app).
  - `scripts/restart-and-continue.mjs`, `scripts/swap-and-launch.mjs`, `scripts/check-syntax.mjs`:
    restarting the app from inside it, then continuing the session.
  - `scripts/powertoys-command.mjs`: asks the running app, from a session, to do what a page action does
    (add the task list to a session) or queue a prompt in one.
- **30 edits** (`"kind": "edit"`) to the app's own files: the small hooks that call into
  Powertoys, a rewrite of the Windows notification code, and two build manifests that list the new files.
  They are described one by one [below](#every-change-to-the-apps-own-files).

## How the patches avoid containing Claude Desktop's code

New files are Powertoys code and are stored as they are. An edit to one of the app's own files is stored so that
nothing of that file is in the patch. The patcher reconstructs the edited file from **your** copy:

```json
{
  "path": "src/vite/build/mainView/0007-window-manager-vm-bridges.js",
  "kind": "edit",
  "baseSha256": "9b12cb23…",  // your copy must hash to this, or nothing is written
  "resultSha256": "69c1209f…", // the patched file must hash to this
  "hunks": [
    {
      "at": 585,                // 0-based line where the hunk goes
      "remove": 1,              // how many of your lines it replaces…
      "removeSha256": "7870e9ec…", // …and their hash (never their text)
      "add": [                  // the new lines, as parts:
        [[585, 0, 70], " || powertoysPastedFilePath", [585, 64, 72]]
      ]                         // [line, start, end] copies a range of YOUR line 585 (here its start, then its
                                // "(file)," and line ending); strings are Powertoys text
    }
  ]
}
```

- A changed line keeps its original part **by reference**: a `[line, start, end]` range of your own copy.
- Code that moved inside a file (the notification rewrite reorders some of the app's lines) is also copied by
  reference from your copy, never stored.
- Only text written for Powertoys appears literally.

## What the patches apply to

The patches are for **Claude Desktop 4.4212.0 for Windows**, laid out as the paths in `patches.json` show.
Every edited file is checked by SHA-256, so the patches apply only to byte-identical files and refuse anything
else.

## Applying them

```
node patcher/apply-patches.mjs patches <your-copy> --check   # report only
node patcher/apply-patches.mjs patches <your-copy>           # apply
```

- **Checked before anything is written.** Each edited file must match `baseSha256`, and each hunk's lines must
  match `removeSha256`. A new file must not collide with a different file already there. If anything fails,
  **nothing** is written and the problems are listed.
- **Checked after.** Each patched file must match `resultSha256`.
- **Applying twice is refused.** A second run reports the already-patched files as "not the expected base".
- **New files are listed.** The patched `_manifest.json` files already include the new files.

## What Powertoys adds

Data lives in `%APPDATA%\Claude\powertoys\` (settings, bookmarks, snippets, tabs, notes, the prompt queue,
pastes). Every feature has a switch in the Powertoys settings window (tray menu or the Powertoys menu).

**Tabs and sessions**

- **Tabs in the title bar** for open and pinned conversations, restored at start:
  - **Opening and closing:** × or middle-click closes; right-click pins.
  - **Organizing:** tabs are grouped and colored by project (16 distinct colors), and the strip scrolls
    sideways when they don't fit.
  - **Moving around:** Ctrl+1…9, Ctrl+Shift+T to reopen in the same position, Ctrl+Shift+PageUp/PageDown to
    move a tab, and close others / to the right / finished.
  - **Drafts:** the New session page keeps its tab when you switch away, until you close it or send the draft
    (then the new session's tab takes over).
- **On each tab:**
  - **A preview on hover:** the last answer as Markdown, with model, effort, context, cost, the reason it
    waits, PR checks, task progress and queued prompts.
  - **The PR's checks** (✓ passed, ● running, ✗ failed). Clicking the mark opens the PR.
  - **A ⏭N badge** for queued prompts.
- **Side by side:** drag a tab onto the conversation to open it side by side. The panes then share one tab
  (⧉N), and a side pane can collapse back into a tab. The split survives a restart, and the status row shows
  shared information once.
- **Ctrl+Tab session switcher** over the open tabs:
  - **Order:** the current session and the previous one first, then those waiting for you (most urgent first),
    then the rest by most recent use.
  - **Per row:** project color, note, why it waits, task progress and PR checks.
- **Why a session waits**, everywhere a waiting session is listed (tray menu, tooltip, tabs, Ctrl+Tab): a
  question, a plan to approve, a permission for a named tool, folder trust, an error, finished, or CI failed.
  Waiting sessions are ordered by urgency, and the tray icon and taskbar show a waiting-count badge.
- **Per-project defaults:** the model and effort new sessions in a project start with.
- **One folder, whatever its slashes:** `E:/x` and `E:\x` are the same project. Local sessions get backslash
  folders when they start and when they are restored (a `claude://` link can give forward slashes), and
  project colors and defaults match either form.
- **Session notes:** one line per session, shown on its tab, in its preview and in Ctrl+Tab.
- **Archiving:** idle finished sessions can be archived after N days (off by default).
- **Profiles:** `--powertoys-profile=<name>` runs the app with its own data folder `%APPDATA%\Claude-<name>`.

**Prompting**

- **Prompt queue:** Alt+Enter queues the prompt in the box. Queued prompts are sent one by one as the session's
  turns end. Sending stops while a question or permission waits for you, or after an error. The queue list (from
  the tab menu or the command palette) takes a prompt back into the box to edit, or removes it.
- **Large pastes:** pasted text over 3,000 characters goes in as an attachment. It is saved to a file, so the
  message stays short; Ctrl+Shift+V pastes the text itself.
- **Message times:** hovering a message shows when it was sent, just above it.
- **Copy path with backslashes:** "Copy path" and "Copy absolute path" copy Windows paths as `E:\a\b`.
- **No feedback survey** (on by default): new sessions start with Claude Code's "How is Claude doing?" survey
  off (`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`), and the page's rating card is hidden.
- **Files outside the session's folders:** the file pane opens any file, read only. Claude's own tools (open in
  your editor, show in Explorer, send a file) still stay inside the session's folders.
- **Folder trust off** (a setting, on by default): every folder counts as trusted, so "Trust this workspace?"
  never comes up. That includes a folder a `claude://code/new?folder=` link opens (for example from Slack): the
  page asks for those every time unless its own flag for skipping trusted folders is on, so Powertoys turns
  that flag on in the page's bootstrap response before the page's scripts run.
- **Keys and pickers:**
  - Snippets with Ctrl+Shift+Space, per project.
  - Alt+Up shows earlier prompts.
  - Ctrl+Up/Down jumps between prompts, and Ctrl+Home/End goes to the start or end of the conversation.
  - Ctrl+Enter sends now, interrupting Claude.
  - "Edit message" rewinds to a message and puts it back in the box.

**Finding things**

- **Search and history:** Ctrl+Shift+S searches all sessions, and Ctrl+H shows every message, by day. Both are
  read from Claude Code's transcripts by a worker thread.
- **Bookmarks:** add one from the message right-click menu, and organize them in a bookmark manager.
- **Exporting:** a conversation can be saved as Markdown or HTML, and its edited files opened in your IDE.
- **Token use and estimated cost** per project and session.
- **Away summary:** what the sessions did in the last hour or today.

**Progress**

- **The task list for every session:** the app gives a session its task list (its plan tool, with the wrap-up
  box at the end of a turn) only when its server flags allow it at the session's start, so some sessions have
  none and Claude cannot make one. Powertoys asks for it for every new session (a setting, on by default), and
  a tab's menu adds it to a session that started without it, from its next message.
- **Task lists:** under a session's task list (its plan or TodoWrite list), a progress bar and an estimate, for
  example "3 of 7 done · ~25 min left · done ≈ 21:10 · ~1 h in all":
  - **How it's estimated:** by Claude itself. The plan tool takes an estimate in minutes for each step (a
    setting, on by default), and a step without one counts as the average of those with one. A step running
    past its estimate pushes the finish time back.
  - **Re-estimating:** the ↻ button asks Claude to send the plan again with new estimates.
  - The tab preview and Ctrl+Tab show the short form, "☑ 3/7 · done ≈ 21:10".
- **Conversation topic:** a chip in the status row with what the session is about, read from its transcript: the
  Notion ticket it works on (title, status, link), implementation and testing progress, and its PR.

**Context map**

- **Where the context went:** click "k context" in the status bar, or use a tab's menu or the command palette.
  - **How full it is:** for example "466k of 1M (47%), compacted 3×".
  - **What fills it now:** a bar split into the system prompt, tool definitions (per MCP server), instructions
    (CLAUDE.md, memory), your messages, Claude's text, thinking, tool calls, tool results, attached files,
    reminders, compaction summaries and images.
- **How it got there:** a stacked chart over every request, with compactions and your messages marked. Hovering
  shows the size, the message it came after and what dominated; clicking goes to that message.
- **Three lists**, each row going to its message:
  - the biggest things in the context now, added up by kind (for example "Call: Write ×12" or "Result of Bash";
    click a kind to see its biggest items) or one by one;
  - the biggest jumps between requests, with their cause (a file read, a command's output, tool definitions
    loaded);
  - what each of your messages added.
- **Exact and estimated:** the totals come from each response's usage and are exact. Each kind's share is
  estimated from its text and scaled to match.

**App and system**

- **Actionable Windows notifications:** permission notifications have the in-app card's buttons, and question
  notifications have a button per option plus a reply box. They follow Windows' notification settings, and
  can stay on screen.
- **Notification inbox:** replays the buttons of notifications you missed.
- **Hotkeys:** Win+Alt+C opens the sessions waiting for you, and Win+Alt+N starts a new session in a recent
  folder.
- **Startup and windows:**
  - The most recent conversation opens at launch.
  - Restoring the window keeps it maximized.
  - Tray-only mode.
  - Extra windows behave like the main one.
- **Restarts:** "Restart and continue here" restarts the app and continues the session.
  `restart-and-continue.mjs --update <git ref>` brings in a new release that needs a full build: once the app
  has quit it fast-forwards the project folder, installs the packages, rebuilds and starts again, going
  back to the previous commit if a step or the start fails.
  Sessions that were working are continued after the restart, and the waiting-for-you question doesn't block it.
- **Look:**
  - Declutter switches.
  - Conversation text size, font and full width.
  - Right-to-left text per paragraph.
  - Sidebar auto-hide while the window is maximized, with projects collapsed at start.
  - Your own CSS and JS mods (`powertoys\mods\`).
- **Cowork:** its background service can be switched off, its VM image moved, and it can run without the Store
  install.
- **Network watchdog:** the app restarts when its network service dies, once no session is working.
- **Background git fetches** use your own SSH program (`core.sshCommand`).

## Every change to the app's own files

Each hook is marked `Local change` in the patched code.

| File (under `src/vite/build/`) | Lines | What it does |
|---|---|---|
| `main/app/0239-session-notifications.js` | +543 −62 | Builds Windows notifications here instead of through Electron, so they can carry the in-app card's buttons (Allow once, Always allow …, Deny; a button per question option, a reply box, Skip, Submit). Can keep them on screen, respects Windows' settings, and records them in the Powertoys inbox. |
| `ccd-local-session-manager/0027-ccd.js` | +14 −1 | A slash command the app handles itself (`/remote-control`) no longer stays "queued" in the page. |
| `ccd-local-session-manager/0052-ccd.js` | +7 −1 | That command's echo uses the id the page sent it under, once; a restored local session's folders get backslashes. |
| `ccd-local-session-manager/0016-ccd.js` | +2 | Powertoys' additions to a session's environment (no feedback survey). |
| `claude-json-workspace-trust-config.js` | +8 | Folder trust off: the trust lookups count every folder as trusted while the Powertoys setting is on. |
| `ccd-host-core/mcp-tools/0001-mcp-tool-prefix-sanitizers.js` | +5 | The plan tool takes an estimate in minutes per step. |
| `ccd-host-core/0002-drive-host-fill.js` | +1 −1 | Its description asks for the estimates when the setting is on. |
| `ccd-local-session-manager/0038-session-file-access.js` | +17 −1 | Files outside the session's folders, read only: Powertoys' pastes folder, and any file you view in the file pane. |
| `ccd-local-sessions-api/0002-local-sessions-api-core.js` | +6 | Per-project model and effort defaults for a session you start, and the task list when the Powertoys setting is on. |
| `git-worktree-manager/0003-worktree-trash-tombstones.js` | +19 | Background fetches keep your global `core.sshCommand` (with batch mode) instead of replacing it. |
| `git-worktree-manager/0004-create-worktree-guards.js` | +1 −1 | Uses the above. |
| `index.pre/telemetry-scrub/0036-error-withholding-breadcrumbs.js` | +10 | `--powertoys-profile=<name>`: a separate data folder (sign-in, sessions, settings, single-instance lock). |
| `main/0282-support-bundle.js` | +2 | Leaves Ctrl+Tab to the Powertoys switcher while it is on. |
| `main/app/0333-device-storage-api.js` | +4 −1 | Restoring the window keeps a maximized window maximized. |
| `main/app/0349-app-ipc-preferences.js` | +3 −1 | "Open at login" starts this build (it has no Squirrel stub). |
| `main/app/0350-main-window-squirrel.js` | +11 −6 | Extra windows reuse the code window's setup; the most recent conversation opens at launch. |
| `main/app/0351-app-main-tray.js` | +4 −3 | The tray menu refreshes when its submenus (snippets, bookmarks) change. |
| `main/0284-plan-usage.js` | +3 | The Powertoys menu, and the tray's waiting sessions, snippets, bookmarks and switches. |
| `main/platform/0028-electron-store-sync-timing.js` | +9 | Compatibility with the npm `electron-store` package. |
| `main/platform/0242-gpu-state-telemetry.js` | +6 | Calls the network watchdog when the network service dies. |
| `main/settings/0237-supported-features.js` | +7 −1 | "Cowork without the Store install": skips only the install-type check. |
| `main/vm/0183-vm-proxy-credentials.js`, `main/vm/0184-vm-rpc-client.js` | +4, +4 | Doesn't start the Cowork service when Powertoys has it switched off. |
| `main/vm/0258-vm-bundle-download.js` | +5 | The Cowork VM image can live in another folder. |
| `main/windows/0208-session-handoff-activity.js` | +2 −1 | Folders removed from the recent lists stay out of the jump list. |
| `main/windows/0344-main-view-input-errors.js` | +13 | Extra windows get local session events too. |
| `mainView/0007-window-manager-vm-bridges.js` | +1 −1 | A large paste saved by Powertoys reports its file path, so the composer attaches it. |
| `main/_manifest.json`, `mainView/_manifest.json` | | List the new files, so they are part of the app. |
| `../../scripts/assemble.mjs` | | `--out <dir>`: builds into a staging folder while the app runs, for the in-app restart. |

## How the package was checked

Before publishing:

1. **Applied to unmodified files, the package reproduces the Powertoys build byte for byte.** Every edited
   file's result hash matches.
2. **No line of the package repeats a line of the app (40 characters or more).** The remaining matches are
   everyday calls into the app's own API, which Powertoys has to name to work with it. For example:
   - `if (!mainWindow || mainWindow.isDestroyed()) {`
   - `backgroundColor: getWindowBackgroundColor(),`
   - `await new Promise((resolve) => setTimeout(resolve, 1000));`
3. **Applying it twice is refused**, as is applying it to any other files.
