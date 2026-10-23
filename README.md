# Claude Powertoys patches

Patches that add **Powertoys** to Claude Desktop for Windows: browser-like tabs, a session switcher,
side-by-side work, prompt history and search, bookmarks, snippets, a prompt queue, task-list progress with time
estimates, PR check status on tabs, actionable notifications, and more. This repository holds **only the
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

`patches/patches.json` lists 39 files:

- **14 new files** (`"kind": "add"`), all written for Powertoys:
  - `src/vite/build/main/powertoys/0340` … `0351`: the main-process half (settings and stores, the transcript
    reader worker, session status, hotkeys and menus, IPC, system integration, extra windows, notifications
    inbox, restart, and the newer features).
  - `src/vite/build/mainView/0003-powertoys-page.js`: the in-page half (tabs, switcher, panels, keys, the
    windows Powertoys draws inside the app).
  - `scripts/restart-and-continue.mjs`, `scripts/swap-and-launch.mjs`, `scripts/check-syntax.mjs`:
    restarting the app from inside it, then continuing the session.
- **25 edits** (`"kind": "edit"`) to the app's own files: the small hooks that call into
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

The patches are for **Claude Desktop 3.6556.2 for Windows**, laid out as the paths in `patches.json` show.
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
- **Session notes:** one line per session, shown on its tab, in its preview and in Ctrl+Tab.
- **Archiving:** idle finished sessions can be archived after N days (off by default).
- **Profiles:** `--powertoys-profile=<name>` runs the app with its own data folder `%APPDATA%\Claude-<name>`.

**Prompting**

- **Prompt queue:** Alt+Enter queues the prompt in the box. Queued prompts are sent one by one as the session's
  turns end. Sending stops while a question or permission waits for you, or after an error. The queue list (from
  the tab menu or the command palette) takes a prompt back into the box to edit, or removes it.
- **Large pastes:** pasted text over 3,000 characters goes in as an attachment. It is saved to a file, so the
  message stays short; Ctrl+Shift+V pastes the text itself.
- **Files outside the session's folders:** "Open anyway" allows one such file, read only.
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

- **Task lists:** under a session's task list (its plan or TodoWrite list), a progress bar and an estimate, for
  example "3 of 7 done · ~25 min left · done ≈ 21:10 · ~1 h in all":
  - **How it's estimated:** from the time per finished step, read from the transcript.
  - **When it's recalculated:** every 30 minutes while the session works (configurable), when a step finishes,
    and with a ↻ button.
  - The tab preview and Ctrl+Tab show the short form, "☑ 3/7 · done ≈ 21:10".

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
  Sessions that were working are continued after the restart, and the waiting-for-you question doesn't block it.
- **Look:**
  - Declutter switches.
  - Conversation text size, font and full width.
  - Right-to-left text per paragraph.
  - Sidebar auto-hide, with projects collapsed at start.
  - Your own CSS and JS mods (`powertoys\mods\`).
- **Cowork:** its background service can be switched off, its VM image moved, and it can run without the Store
  install.
- **Network watchdog:** the app restarts when its network service dies, once no session is working.
- **Background git fetches** use your own SSH program (`core.sshCommand`).

## Every change to the app's own files

Each hook is marked `Local change` in the patched code.

| File (under `src/vite/build/`) | Lines | What it does |
|---|---|---|
| `main/app/0202-session-notifications.js` | +552 −71 | Builds Windows notifications here instead of through Electron, so they can carry the in-app card's buttons (Allow once, Always allow …, Deny; a button per question option, a reply box, Skip, Submit). Can keep them on screen, respects Windows' settings, and records them in the Powertoys inbox. |
| `ccd-local-session-manager/0026-ccd.js` | +14 −1 | A slash command the app handles itself (`/remote-control`) no longer stays "queued" in the page. |
| `ccd-local-session-manager/0048-ccd.js` | +5 −1 | That command's echo uses the id the page sent it under, once. |
| `ccd-local-session-manager/session-core/0035-session-clearing-events.js` | +10 | Files outside the session's folders: Powertoys' pastes folder, and files you allowed with "Open anyway". |
| `ccd-local-sessions-api/0002-local-sessions-api-core.js` | +4 | Per-project model and effort defaults for a session you start. |
| `git-worktree-manager/0003-worktree-trash-tombstones.js` | +19 | Background fetches keep your global `core.sshCommand` (with batch mode) instead of replacing it. |
| `git-worktree-manager/0004-create-worktree-guards.js` | +1 −1 | Uses the above. |
| `index.pre/telemetry-scrub/0034-error-withholding-breadcrumbs.js` | +10 | `--powertoys-profile=<name>`: a separate data folder (sign-in, sessions, settings, single-instance lock). |
| `main/0242-support-bundle.js` | +3 | Leaves Ctrl+Tab to the Powertoys switcher while it is on. |
| `main/app/0296-device-storage-api.js` | +4 −1 | Restoring the window keeps a maximized window maximized. |
| `main/app/0311-app-ipc-preferences.js` | +3 −1 | "Open at login" starts this build (it has no Squirrel stub). |
| `main/app/0312-main-window-squirrel.js` | +11 −6 | Extra windows reuse the code window's setup; the most recent conversation opens at launch. |
| `main/app/0313-app-main-tray.js` | +4 −3 | The tray menu refreshes when its submenus (snippets, bookmarks) change. |
| `main/chrome/0244-browser-launch-extension-install.js` | +3 | The Powertoys menu, and the tray's waiting sessions, snippets, bookmarks and switches. |
| `main/platform/0028-electron-store-sync-timing.js` | +9 | Compatibility with the npm `electron-store` package. |
| `main/platform/0205-gpu-state-telemetry.js` | +6 | Calls the network watchdog when the network service dies. |
| `main/settings/0200-supported-features.js` | +7 −1 | "Cowork without the Store install": skips only the install-type check. |
| `main/vm/0148-vm-rpc-client.js` | +8 | Doesn't start the Cowork service when Powertoys has it switched off. |
| `main/vm/0220-vm-bundle-download.js` | +5 | The Cowork VM image can live in another folder. |
| `main/windows/0170-session-handoff-activity.js` | +2 −1 | Folders removed from the recent lists stay out of the jump list. |
| `main/windows/0307-main-view-input-errors.js` | +13 | Extra windows get local session events too. |
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
