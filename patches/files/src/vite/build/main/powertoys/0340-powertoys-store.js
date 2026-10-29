// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): settings and data files.
//
// The features ported from the ClaudePowertoys tray app live in main/powertoys/ (main process)
// and mainView/0003-powertoys-page.js (in the claude.ai page). Their settings, bookmarks, snippets
// and recent-session list are JSON files in <userData>/powertoys/. Every change goes through
// powertoysWriteJson (atomic rename) and then powertoysEvents, which the IPC layer forwards to the
// page so it never shows state that is not on disk.
// ---------------------------------------------------------------------------------------------
const powertoysFs = require("node:fs");
const powertoysPath = require("node:path");
const powertoysOs = require("node:os");
const powertoysCrypto = require("node:crypto");
const powertoysEvents = new (require("node:events").EventEmitter)();
powertoysEvents.setMaxListeners(50);

const POWERTOYS_DEFAULT_SETTINGS = {
  autoHideSidebar: false,
  removeResizeHandle: true,
  sessionSwitcher: true,
  ctrlEnterSendsNow: true,
  outlineButton: true,
  promptJump: true,
  conversationEnds: true,
  snippets: true,
  promptHistory: true,
  search: true,
  bookmarks: true,
  history: true,
  waitingBadge: true,
  openRecentOnLaunch: true,
  topTabs: true,
  /** The title bar's buttons on the right go into its View options (⋯) menu, leaving the room to the tabs. */
  foldTitleBarButtons: true,
  needsInputHotkey: true,
  needsInputHotkeyKeys: "Super+Alt+C",
  newSessionHotkey: true,
  newSessionHotkeyKeys: "Super+Alt+N",
  /** How far back a session's last activity may be for the Ctrl+Tab list. */
  recentSessionHours: 8,
  rtlAuto: true,
  mods: true,
  spellcheck: true,
  /** Comma-separated spellchecker language codes. */
  spellLanguages: "en-US",
  hideSurvey: false,
  hidePromptSuggestions: false,
  hideNextStepBox: false,
  hideCreatePr: false,
  hideThinking: false,
  collapseFinishedTurns: false,
  expandDiffs: false,
  /** Conversation text size in px; 0 keeps the app's. */
  conversationFontSize: 0,
  /** A font family for the conversation; "" keeps the app's. */
  conversationFont: "",
  fullWidth: false,
  trayOnly: false,
  statusBar: true,
  coworkService: true,
  /** Let Cowork run although this build is not the Store (MSIX) install; restart to apply. */
  coworkWithoutMsix: false,
  /** Archive scratch-folder sessions idle for this many days (0 = never). */
  scratchArchiveDays: 7,
  // Any other project's sessions idle this many days are archived (0 = never); see powertoysArchiveIdleSessions.
  archiveIdleDays: 0,
  // Notifications stay on screen until dismissed (Windows "reminder"); off = Windows' own rules apply.
  notificationsStayOnScreen: false,
  // Text pasted into the prompt box longer than this goes in as an attached file (0 = never).
  pasteAsFileChars: 3000,
  /** Restart Claude (once no session is working) when its Network Service process dies. */
  networkWatchdog: true,
  /** IntelliJ IDEA's launcher (idea.cmd / idea64.exe); empty = find it. */
  ideaCommand: "",
  quickSendHotkey: true,
  quickSendHotkeyKeys: "Super+Alt+Q",
  /** On returning after this many minutes away, summarize what the sessions did (0 = off). */
  awaySummaryMinutes: 15,
  commandPalette: true,
  /** Color each project's sidebar header and its tabs. */
  colorProjects: true,
  /** Chosen colors by project key (owner/repo or folder, lowercased); others are automatic. */
  projectColors: {},
  /** Automatic colors, given once per project (least-used color first) so they differ and stay put. */
  autoProjectColors: {},
  /** Collapse every environment / folder group in the sidebar when the app starts. */
  collapseSidebarGroupsAtStart: true,
  // Ctrl+1…8 go to that tab, Ctrl+9 to the last; Ctrl+Shift+T reopens the last closed one.
  tabNumberKeys: true,
  // Open tabs ordered by project (first-seen order), with a gap between projects.
  groupTabsByProject: true,
  // Hovering a conversation's tab shows its last answer (model, effort, context on top), this opaque (%).
  tabPreview: true,
  taskProgress: true,
  forceTaskList: true,
  promptQueueKey: true,
  agentEstimates: true,
  // Folder trust off: every folder counts as trusted, so "Trust this workspace?" never comes up.
  disableFolderTrust: true,
  tabPreviewOpacity: 80,
  // A restart requested here reopens the conversations side by side as they were.
  restoreSplitsAfterRestart: true,
  // { "<project key>": { name, folder, model?, effort? } }: new sessions started in that folder use them.
  projectDefaults: {},
  /** Session ids whose notifications are muted (tab menu → Mute notifications). */
  mutedSessions: [],
  /** Where the Cowork VM image lives; "" = <userData>\vm_bundles. */
  coworkBundleDir: "",
};

/**
 * The Settings window's layout: sections of { key, label, type, hint?, min?, max? }; type is
 * switch | number | text | languages | action.
 */
const POWERTOYS_SETTINGS_SECTIONS = [
  {
    title: "Tabs and layout",
    items: [
      { key: "topTabs", label: "Tabs for open and pinned conversations in the top bar (Ctrl+W closes the current one)", type: "switch" },
      { key: "foldTitleBarButtons", label: "Move the title bar's buttons into its ⋯ menu, to make room for the tabs", type: "switch" },
      { key: "colorProjects", label: "Color each project and its tabs (right-click a tab to choose the color)", type: "switch" },
      { key: "collapseSidebarGroupsAtStart", label: "Start with the sidebar's environments and folders collapsed", type: "switch" },
      { key: "groupTabsByProject", label: "Group the open tabs by project", type: "switch" },
      { key: "tabPreview", label: "Hovering a tab previews its last answer (with model, effort and context)", type: "switch" },
      { key: "taskProgress", label: "Task lists show a progress bar, the estimated time left, when they will be done and the total", type: "switch" },
      { key: "forceTaskList", label: "Every new Code session gets the app's task list (its plan tool, with the wrap-up box), also when the app would leave it out; a tab's menu adds it to an existing session", type: "switch" },
      { key: "agentEstimates", label: "Claude estimates each step of its task list (minutes per step, re-estimated as it learns); the time left and finish time come from those (applies after a restart)", type: "switch" },
      { key: "tabPreviewOpacity", label: "…the preview's opacity (%)", type: "number", min: 20, max: 100 },
      { key: "restoreSplitsAfterRestart", label: "After a restart from here, reopen the conversations side by side as they were", type: "switch" },
      { key: "openRecentOnLaunch", label: "Open the most recent code conversation at launch", type: "switch" },
      { key: "statusBar", label: "Status in the row under the prompt box (folder, branch, context, plan usage)", type: "switch" },
      { key: "outlineButton", label: "Conversation outline button", type: "switch" },
      { key: "autoHideSidebar", label: "Auto-hide sidebar (touch the left edge; only while the window is maximized)", type: "switch" },
      { key: "removeResizeHandle", label: "Remove the sidebar resize handle", type: "switch" },
    ],
  },
  {
    title: "Conversation",
    items: [
      { key: "rtlAuto", label: "Right-to-left text (Arabic, Hebrew) laid out per paragraph", type: "switch" },
      { key: "conversationFontSize", label: "Conversation text size (px, 0 = app default)", type: "number", min: 0, max: 32 },
      { key: "conversationFont", label: "Conversation font (any installed font; empty = app default)", type: "text" },
      { key: "fullWidth", label: "Full-width conversation", type: "switch" },
      { key: "collapseFinishedTurns", label: "Collapse a finished turn's tool calls", type: "switch" },
      { key: "expandDiffs", label: "Expand Edit / Write diffs", type: "switch" },
      { key: "hideThinking", label: "Hide extended thinking", type: "switch" },
    ],
  },
  {
    title: "Declutter",
    items: [
      { key: "hideSurvey", label: "Hide the \"How is Claude doing?\" survey", type: "switch" },
      { key: "hidePromptSuggestions", label: "Hide prompt suggestions", type: "switch" },
      { key: "hideNextStepBox", label: "Hide the end-of-turn next-step box", type: "switch" },
      { key: "hideCreatePr", label: "Hide the Create PR button", type: "switch" },
    ],
  },
  {
    title: "Keys and navigation",
    items: [
      { key: "sessionSwitcher", label: "Ctrl+Tab switches between open tabs", type: "switch" },
      { key: "tabNumberKeys", label: "Ctrl+1…9 go to a tab (9: the last); Ctrl+Shift+T reopens the last closed one; Ctrl+Shift+PageUp/PageDown move the current tab", type: "switch" },
      { key: "promptJump", label: "Ctrl+Up / Ctrl+Down jump between prompts", type: "switch" },
      { key: "conversationEnds", label: "Ctrl+Home / Ctrl+End: start or end of the conversation", type: "switch" },
      { key: "ctrlEnterSendsNow", label: "Ctrl+Enter sends now (interrupting Claude)", type: "switch" },
      { key: "promptQueueKey", label: "Alt+Enter queues the prompt: queued prompts go one by one as the session's turns end (the tab's ⏭ lists them)", type: "switch" },
      { key: "promptHistory", label: "Alt+Up: earlier prompts", type: "switch" },
      { key: "snippets", label: "Snippets (Ctrl+Shift+Space)", type: "switch" },
      { key: "pasteAsFileChars", label: "Paste text longer than this many characters as an attached file (0 = never; Ctrl+Shift+V pastes the text)", type: "number", min: 0, max: 1000000 },
      { key: "search", label: "Ctrl+Shift+S: search all sessions", type: "switch" },
      { key: "history", label: "Ctrl+H: history of every message", type: "switch" },
      { key: "bookmarks", label: "Bookmarks (right-click a message)", type: "switch" },
      { key: "needsInputHotkey", label: "Global hotkey: sessions waiting for you", type: "switch" },
      { key: "needsInputHotkeyKeys", label: "…its keys", type: "text" },
      { key: "newSessionHotkey", label: "Global hotkey: new session in a recent folder", type: "switch" },
      { key: "newSessionHotkeyKeys", label: "…its keys", type: "text" },
      { key: "recentSessionHours", label: "Recently used sessions: hours", type: "number", min: 1, max: 168 },
      { key: "commandPalette", label: "Ctrl+Shift+P: command palette", type: "switch" },
      { key: "quickSendHotkey", label: "Global hotkey: quick send to a session", type: "switch" },
      { key: "quickSendHotkeyKeys", label: "…its keys", type: "text" },
    ],
  },
  {
    title: "System",
    items: [
      { key: "waitingBadge", label: "Waiting-sessions badge on the tray and taskbar", type: "switch" },
      { key: "disableFolderTrust", label: "Turn folder trust off: every folder counts as trusted and \"Trust this workspace?\" never comes up, also for folders a claude:// link opens (applies after a restart)", type: "switch" },
      { key: "notificationsStayOnScreen", label: "Notifications stay on screen until dismissed (they then show through Do Not Disturb and Focus)", type: "switch" },
      { key: "awaySummaryMinutes", label: "\"While you were away\" summary after this many minutes away (0 = off)", type: "number", min: 0, max: 1440 },
      { key: "scratchArchiveDays", label: "Archive scratch-folder sessions idle for this many days (0 = never)", type: "number", min: 0, max: 365 },
      { key: "archiveIdleDays", label: "Archive any other finished session idle for this many days (0 = never; not starred, open in a tab, scheduled or waiting for you)", type: "number", min: 0, max: 365 },
      { key: "networkWatchdog", label: "Restart Claude when its network process dies (waits until no session is working)", type: "switch" },
      { key: "ideaCommand", label: "IntelliJ IDEA launcher (empty = find it)", type: "text" },
      { key: "openInbox", label: "Notification inbox…", type: "action" },
      { key: "rebuildRestart", label: "Rebuild and restart Claude", type: "action" },
      { key: "trayOnly", label: "Tray only (no taskbar button)", type: "switch" },
      { key: "spellcheck", label: "Spellchecker", type: "switch" },
      { key: "spellLanguages", label: "Spellchecker languages", type: "languages" },
      { key: "coworkService", label: "Cowork background service (off: never started; restart to apply)", type: "switch" },
      { key: "coworkWithoutMsix", label: "Cowork without the Store install (uses the Store app's VM service; restart to apply)", type: "switch" },
      { key: "coworkBundleDir", label: "Cowork VM image folder (empty = default; move vm_bundles there yourself, then restart)", type: "text" },
      { key: "mods", label: "Mods: your CSS / JS from the mods folder", type: "switch" },
      { key: "openModsFolder", label: "Open the mods folder", type: "action" },
      { key: "openFolder", label: "Open the Powertoys folder", type: "action" },
      { key: "resetHiddenFolders", label: "Show folders removed from the recent lists again", type: "action" },
      { key: "editOpenInApps", label: "Edit the \"Open in\" apps (openin.json)", type: "action" },
    ],
  },
];

/** The on/off switches, in menu order, with their menu labels. */
const POWERTOYS_SWITCHES = [
  ["autoHideSidebar", "Auto-hide sidebar"],
  ["removeResizeHandle", "Remove sidebar resize handle"],
  ["sessionSwitcher", "Ctrl+Tab session switcher"],
  ["ctrlEnterSendsNow", "Ctrl+Enter sends now"],
  ["outlineButton", "Conversation outline button"],
  ["promptJump", "Ctrl+Up/Down jumps between prompts"],
  ["conversationEnds", "Ctrl+Home/End: start or end of the conversation"],
  ["snippets", "Snippets (Ctrl+Shift+Space)"],
  ["promptHistory", "Alt+Up: earlier prompts"],
  ["search", "Ctrl+Shift+S: search all sessions"],
  ["bookmarks", "Bookmarks (right-click a message)"],
  ["history", "Ctrl+H: history of every message"],
  ["waitingBadge", "Waiting-sessions badge on the tray and taskbar"],
  ["openRecentOnLaunch", "Open the most recent code conversation at launch"],
  ["topTabs", "Tabs for pinned and active conversations in the top bar"],
  ["foldTitleBarButtons", "Title bar buttons in the ⋯ menu"],
  ["needsInputHotkey", "Sessions waiting for you (global hotkey)"],
  ["newSessionHotkey", "New session in a recent folder (global hotkey)"],
];

function powertoysDir() {
  return powertoysPath.join(electron.app.getPath("userData"), "powertoys");
}
function powertoysFile(name) {
  return powertoysPath.join(powertoysDir(), name);
}
function powertoysLog(message, ...rest) {
  logger.info(`[powertoys] ${message}`, ...rest);
}
function powertoysWarn(message, ...rest) {
  logger.warn(`[powertoys] ${message}`, ...rest);
}

/** The file's JSON, or `fallback` when it is missing; a file that is not valid JSON is logged and treated as missing. */
function powertoysReadJson(name, fallback) {
  let file = powertoysFile(name);
  let text;
  try {
    text = powertoysFs.readFileSync(file, "utf8");
  } catch (caught) {
    if (caught.code !== "ENOENT") {
      powertoysWarn(`reading ${name} failed: ${caught.message}`);
    }
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (caught) {
    powertoysWarn(`${name} is not valid JSON (${caught.message}); using defaults`);
    return fallback;
  }
}

/** Writes through a temporary file and a rename, so a crash never leaves half a file. */
function powertoysWriteJson(name, value) {
  powertoysFs.mkdirSync(powertoysDir(), { recursive: true });
  let file = powertoysFile(name);
  let temporary = `${file}.${process.pid}.tmp`;
  powertoysFs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  powertoysFs.renameSync(temporary, file);
}

var powertoysSettingsCache = null;
function powertoysSettings() {
  if (!powertoysSettingsCache) {
    let stored = powertoysReadJson("settings.json", {});
    powertoysSettingsCache = { ...POWERTOYS_DEFAULT_SETTINGS };
    for (let [key, value] of Object.entries(stored ?? {})) {
      if (key in POWERTOYS_DEFAULT_SETTINGS && typeof value === typeof POWERTOYS_DEFAULT_SETTINGS[key]) {
        powertoysSettingsCache[key] = value;
      }
    }
  }
  return powertoysSettingsCache;
}
/** Folder trust off (disableFolderTrust): read by claude-json-workspace-trust-config.js and the page's IPC. */
const powertoysTrustOffLogged = new Set();
function powertoysFolderTrustDisabled(folderPath) {
  try {
    if (powertoysSetting("disableFolderTrust") !== true) {
      return false;
    }
  } catch {
    return false;
  }
  if (typeof folderPath === "string" && !powertoysTrustOffLogged.has(folderPath)) {
    powertoysTrustOffLogged.add(folderPath);
    powertoysLog(`folder trust off: ${folderPath} counts as trusted`);
  }
  return true;
}
Object.defineProperty(exports, "powertoysFolderTrustDisabled", { enumerable: true, get: () => powertoysFolderTrustDisabled });
function powertoysSetting(key) {
  return powertoysSettings()[key];
}
/** Persists one setting, then announces it ("settings" event with the whole settings object). */
function powertoysSetSetting(key, value) {
  if (!(key in POWERTOYS_DEFAULT_SETTINGS) || typeof value !== typeof POWERTOYS_DEFAULT_SETTINGS[key]) {
    throw Error(`Unknown setting or wrong type: ${key}`);
  }
  let next = { ...powertoysSettings(), [key]: value };
  powertoysWriteJson("settings.json", next);
  powertoysSettingsCache = next;
  powertoysLog(`setting ${key} = ${JSON.stringify(value)}`);
  powertoysEvents.emit("settings", next);
}

function powertoysNewId() {
  return powertoysCrypto.randomBytes(12).toString("hex");
}

// --- Snippets ---------------------------------------------------------------------------------
const POWERTOYS_EXAMPLE_SNIPPETS = [
  {
    name: "Explain this code",
    text: "Explain what this code does, step by step, and point out anything surprising.",
  },
  {
    name: "Review before commit",
    text: "Review the changes in this session before I commit:\n- correctness\n- missing tests\n- anything I should split out",
  },
];
/** The snippets file, created with two examples the first time it is needed. */
function powertoysSnippetsFile() {
  let file = powertoysFile("snippets.json");
  if (!powertoysFs.existsSync(file)) {
    powertoysWriteJson("snippets.json", POWERTOYS_EXAMPLE_SNIPPETS);
  }
  return file;
}
function powertoysSnippets() {
  powertoysSnippetsFile();
  let list = powertoysReadJson("snippets.json", []);
  return (Array.isArray(list) ? list : [])
    .filter((snippet) => snippet && typeof snippet.text === "string" && snippet.text !== "")
    .map((snippet) => ({
      name: typeof snippet.name === "string" && snippet.name.trim() !== "" ? snippet.name.trim() : snippet.text.split("\n")[0].slice(0, 60),
      text: snippet.text,
      // Optional "project": a folder, "owner/repo" or project name (or a list of them): the snippet is
      // offered only in conversations of that project. Without it, everywhere.
      projects: (Array.isArray(snippet.project) ? snippet.project : typeof snippet.project === "string" ? [snippet.project] : [])
        .filter((project) => typeof project === "string" && project.trim() !== "")
        .map((project) => project.trim().replace(/[\\/]+$/, "").toLowerCase()),
    }));
}
var powertoysSnippetsWatcher = null;
/** Re-announces the snippets whenever the file is saved (it is edited by hand). */
function powertoysWatchSnippets() {
  if (powertoysSnippetsWatcher) {
    return;
  }
  let timer = null;
  try {
    powertoysSnippetsWatcher = powertoysFs.watch(powertoysSnippetsFile(), () => {
      clearTimeout(timer);
      timer = setTimeout(() => powertoysEvents.emit("snippets", powertoysSnippets()), 300);
    });
  } catch (caught) {
    powertoysWarn(`watching snippets.json failed: ${caught.message}`);
  }
}

// --- Session notes ---------------------------------------------------------------------------------
// { "<sessionId>": "<one line>" }: shown on the tab, in its preview and in Ctrl+Tab.
function powertoysNotes() {
  let notes = powertoysReadJson("notes.json", {});
  return notes && typeof notes === "object" && !Array.isArray(notes) ? Object.fromEntries(Object.entries(notes).filter(([, text]) => typeof text === "string" && text !== "")) : {};
}
function powertoysSetNote(sessionId, text) {
  if (typeof sessionId !== "string" || !sessionId) {
    throw Error("A note needs a session");
  }
  let notes = powertoysNotes();
  let line = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  line ? (notes[sessionId] = line) : delete notes[sessionId];
  powertoysWriteJson("notes.json", notes);
  powertoysEvents.emit("notes", notes);
  return notes;
}

// --- Prompt queue: prompts sent to a session one after another, as its turns end (queue.json) -----------
// { [sessionId]: [{ id, text, at }] }; the main process sends the first one (powertoysSendQueued).
function powertoysPromptQueue() {
  let queue = powertoysReadJson("queue.json", {});
  if (!queue || typeof queue !== "object" || Array.isArray(queue)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(queue)
      .map(([sessionId, list]) => [sessionId, (Array.isArray(list) ? list : []).filter((item) => typeof item?.id === "string" && typeof item.text === "string" && item.text)])
      .filter(([, list]) => list.length),
  );
}
/** change: "add" (argument: the text), "remove" / "first" (argument: an item's id), "clear". */
function powertoysQueueChange(sessionId, change, argument) {
  if (typeof sessionId !== "string" || !sessionId) {
    throw Error("A queued prompt needs a session");
  }
  let queue = powertoysPromptQueue();
  let list = queue[sessionId] ?? [];
  if (change === "add") {
    let text = String(argument ?? "").trim();
    if (!text) {
      throw Error("Nothing to queue");
    }
    list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, at: Date.now() });
  } else if (change === "remove") {
    list = list.filter((item) => item.id !== argument);
  } else if (change === "first") {
    let item = list.find((each) => each.id === argument);
    list = item ? [item, ...list.filter((each) => each !== item)] : list;
  } else if (change === "clear") {
    list = [];
  } else {
    throw Error(`Unknown queue change ${change}`);
  }
  list.length ? (queue[sessionId] = list) : delete queue[sessionId];
  powertoysWriteJson("queue.json", queue);
  powertoysEvents.emit("queue", queue);
  return queue;
}

// --- Hidden recent folders ----------------------------------------------------------------------
// Folders removed from the recent-folders lists (Win+Alt+N, the jump list). Lower-cased paths.
function powertoysHiddenFolders() {
  let list = powertoysReadJson("hidden-folders.json", []);
  return new Set((Array.isArray(list) ? list : []).filter((folder) => typeof folder === "string").map((folder) => folder.toLowerCase()));
}
function powertoysIsFolderHidden(folder) {
  return !!folder && powertoysHiddenFolders().has(String(folder).replace(/[\\/]+$/, "").toLowerCase());
}
function powertoysHideFolder(folder, hidden) {
  let set = powertoysHiddenFolders();
  let key = String(folder).replace(/[\\/]+$/, "").toLowerCase();
  hidden ? set.add(key) : set.delete(key);
  powertoysWriteJson("hidden-folders.json", [...set]);
  powertoysLog(`recent folders: ${hidden ? "hid" : "showed"} ${folder}`);
  powertoysEvents.emit("hiddenFolders", [...set]);
}

// --- Tabs ----------------------------------------------------------------------------------------
// { pinned: [tab], open: [tab] | null, closed: [tab] } in tab order, tab = { kind, id, title }; kind is the
// page's conversation kind (code, chat, …). open is null until the page has seeded it the first time;
// closed holds the last closed tabs, most recent last (Ctrl+Shift+T reopens them).
const POWERTOYS_CLOSED_TABS_KEPT = 25;
function powertoysReadTabs() {
  let data = powertoysReadJson("tabs.json", null);
  let clean = (list) =>
    list.filter((tab) => tab && typeof tab.kind === "string" && typeof tab.id === "string").map((tab) => ({ kind: tab.kind, id: tab.id, title: String(tab.title ?? "") }));
  return {
    pinned: Array.isArray(data?.pinned) ? clean(data.pinned) : [],
    open: Array.isArray(data?.open) ? clean(data.open) : null,
    closed: Array.isArray(data?.closed)
      ? data.closed
          .filter((tab) => tab && typeof tab.kind === "string" && typeof tab.id === "string")
          .map((tab) => ({ kind: tab.kind, id: tab.id, title: String(tab.title ?? ""), ...(tab.pinned === true ? { pinned: true } : {}), ...(Number.isInteger(tab.at) ? { at: tab.at } : {}) }))
          .slice(-POWERTOYS_CLOSED_TABS_KEPT)
      : [],
  };
}
function powertoysChangeTabs(change) {
  let data = powertoysReadTabs();
  change(data);
  powertoysWriteJson("tabs.json", data);
  powertoysEvents.emit("tabs", data);
  return data;
}
const powertoysSameTab = (left, right) => left.kind === right.kind && left.id === right.id;
const powertoysTabs = {
  read: powertoysReadTabs,
  /** Opens tabs (after the existing ones); the first call seeds the list. */
  open(tabs) {
    return powertoysChangeTabs((data) => {
      data.open ??= [];
      for (let tab of Array.isArray(tabs) ? tabs : [tabs]) {
        if (tab && typeof tab.kind === "string" && typeof tab.id === "string" && !data.pinned.some((other) => powertoysSameTab(other, tab)) && !data.open.some((other) => powertoysSameTab(other, tab))) {
          data.open.push({ kind: tab.kind, id: tab.id, title: String(tab.title ?? "").slice(0, 200) });
        }
      }
    });
  },
  /** Replaces every tab (restoring a saved workspace). */
  replace(next) {
    let valid = (list) =>
      (Array.isArray(list) ? list : [])
        .filter((tab) => tab && typeof tab.kind === "string" && typeof tab.id === "string")
        .map((tab) => ({ kind: tab.kind, id: tab.id, title: String(tab.title ?? "").slice(0, 200) }));
    return powertoysChangeTabs((data) => {
      data.pinned = valid(next?.pinned);
      data.open = valid(next?.open).filter((tab) => !data.pinned.some((other) => powertoysSameTab(other, tab)));
    });
  },
  /** Closes a tab, pinned or not, and remembers it for reopen. */
  close(kind, id) {
    return powertoysChangeTabs((data) => {
      let tab = { kind, id };
      // Where it was (its list and place in it), so reopening puts it back there.
      let pinnedAt = data.pinned.findIndex((other) => powertoysSameTab(other, tab));
      let openAt = (data.open ?? []).findIndex((other) => powertoysSameTab(other, tab));
      let closing = pinnedAt >= 0 ? { ...data.pinned[pinnedAt], pinned: true, at: pinnedAt } : openAt >= 0 ? { ...data.open[openAt], at: openAt } : null;
      data.pinned = data.pinned.filter((other) => !powertoysSameTab(other, tab));
      data.open = (data.open ?? []).filter((other) => !powertoysSameTab(other, tab));
      if (closing) {
        data.closed = [...data.closed.filter((other) => !powertoysSameTab(other, tab)), closing].slice(-POWERTOYS_CLOSED_TABS_KEPT);
      }
    });
  },
  /** Closes several tabs ([{ kind, id }]), each remembered for reopen like a single close. */
  closeMany(tabs) {
    let data = powertoysReadTabs();
    for (let tab of Array.isArray(tabs) ? tabs : []) {
      if (tab && typeof tab.kind === "string" && typeof tab.id === "string") {
        data = powertoysTabs.close(tab.kind, tab.id);
      }
    }
    powertoysLog(`tabs: closed ${Array.isArray(tabs) ? tabs.length : 0} at once`);
    return data;
  },
  /** Reopens the most recently closed tab that is not open again already; returns it, or null. */
  reopen() {
    let reopened = null;
    powertoysChangeTabs((data) => {
      while (data.closed.length && !reopened) {
        let { pinned, at, ...tab } = data.closed.pop();
        if (![...data.pinned, ...(data.open ?? [])].some((other) => powertoysSameTab(other, tab))) {
          reopened = tab;
          // Back in its list at its place (the end, if that list has fewer tabs now).
          let list = pinned ? [...data.pinned] : [...(data.open ?? [])];
          list.splice(Number.isInteger(at) ? Math.min(at, list.length) : list.length, 0, tab);
          pinned ? (data.pinned = list) : (data.open = list);
        }
      }
    });
    if (reopened) {
      powertoysLog(`tab reopened: '${reopened.title}'`);
    }
    return reopened;
  },
  /** Updates the stored titles (the page knows the current ones). */
  retitle(kind, id, title) {
    let data = powertoysReadTabs();
    let tab = [...data.pinned, ...(data.open ?? [])].find((other) => powertoysSameTab(other, { kind, id }));
    if (!tab || tab.title === title) {
      return data;
    }
    return powertoysChangeTabs((next) => {
      for (let other of [...next.pinned, ...(next.open ?? [])]) {
        if (powertoysSameTab(other, { kind, id })) {
          other.title = String(title).slice(0, 200);
        }
      }
    });
  },
  pin(tab) {
    if (!tab || typeof tab.kind !== "string" || typeof tab.id !== "string") {
      throw Error("A pinned tab needs a kind and an id");
    }
    return powertoysChangeTabs((data) => {
      if (!data.pinned.some((other) => other.kind === tab.kind && other.id === tab.id)) {
        data.pinned.push({ kind: tab.kind, id: tab.id, title: String(tab.title ?? "").slice(0, 200) });
        data.open = (data.open ?? []).filter((other) => !powertoysSameTab(other, tab));
        powertoysLog(`tab pinned: '${tab.title}'`);
      }
    });
  },
  unpin(kind, id) {
    return powertoysChangeTabs((data) => {
      let tab = data.pinned.find((other) => other.kind === kind && other.id === id);
      data.pinned = data.pinned.filter((other) => !(other.kind === kind && other.id === id));
      if (tab) {
        data.open = [tab, ...(data.open ?? []).filter((other) => !powertoysSameTab(other, tab))];
      }
    });
  },
  /** Moves a pinned tab to another position among the pinned ones. */
  /** Moves a tab to another position within its own group (pinned or open). */
  move(kind, id, toIndex) {
    return powertoysChangeTabs((data) => {
      for (let list of [data.pinned, data.open ?? []]) {
        let index = list.findIndex((other) => other.kind === kind && other.id === id);
        if (index >= 0) {
          let [tab] = list.splice(index, 1);
          list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, tab);
          return;
        }
      }
    });
  },
};

// --- Bookmarks --------------------------------------------------------------------------------
// { folders: string[], bookmarks: Bookmark[] }, bookmarks newest first. A bookmark:
// { id, sessionId, sessionTitle, entryId, fromUser, text, name, folder ("" = Unsorted), addedAt }.
// entryId is the transcript row the page shows the message in (data-epitaxy-entry).
const POWERTOYS_BOOKMARK_TEXT_MAX = 600;
function powertoysBookmarkDefaultName(text) {
  let line = (text.split("\n").find((part) => part.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
  return line.length <= 90 ? line : `${line.slice(0, 89)}…`;
}
function powertoysReadBookmarks() {
  let data = powertoysReadJson("bookmarks.json", null);
  return {
    folders: Array.isArray(data?.folders) ? data.folders.filter((folder) => typeof folder === "string") : [],
    bookmarks: Array.isArray(data?.bookmarks) ? data.bookmarks.filter((bookmark) => bookmark && bookmark.id) : [],
  };
}
/** Applies `change` to the stored bookmarks, saves, then announces the result. Returns what `change` returned. */
function powertoysChangeBookmarks(change) {
  let data = powertoysReadBookmarks();
  let result = change(data);
  powertoysWriteJson("bookmarks.json", data);
  powertoysEvents.emit("bookmarks", data);
  return result;
}
const powertoysBookmarks = {
  read: powertoysReadBookmarks,
  /** Adds the message, or removes it when it is already bookmarked. Returns whether it was added. */
  toggle(input) {
    let text = String(input.text ?? "").trim();
    let bookmark = {
      id: powertoysNewId(),
      sessionId: String(input.sessionId ?? ""),
      sessionTitle: String(input.sessionTitle ?? ""),
      entryId: String(input.entryId ?? ""),
      fromUser: input.fromUser === true,
      text: text.length <= POWERTOYS_BOOKMARK_TEXT_MAX ? text : `${text.slice(0, POWERTOYS_BOOKMARK_TEXT_MAX)}…`,
      name: "",
      folder: "",
      addedAt: Date.now(),
    };
    if (!bookmark.sessionId || !bookmark.entryId || !bookmark.text) {
      throw Error("A bookmark needs a session, a message and its text");
    }
    bookmark.name = powertoysBookmarkDefaultName(bookmark.text);
    return powertoysChangeBookmarks((data) => {
      let existing = data.bookmarks.findIndex(
        (other) => other.sessionId === bookmark.sessionId && other.entryId === bookmark.entryId && other.text === bookmark.text,
      );
      if (existing >= 0) {
        data.bookmarks.splice(existing, 1);
        powertoysLog(`bookmark removed: '${bookmark.sessionTitle}'`);
        return false;
      }
      data.bookmarks.unshift(bookmark);
      powertoysLog(`bookmark added: '${bookmark.sessionTitle}', ${bookmark.fromUser ? "you" : "Claude"}`);
      return true;
    });
  },
  remove(ids) {
    let set = new Set(ids);
    powertoysChangeBookmarks((data) => {
      data.bookmarks = data.bookmarks.filter((bookmark) => !set.has(bookmark.id));
    });
  },
  rename(id, name) {
    powertoysChangeBookmarks((data) => {
      let bookmark = data.bookmarks.find((other) => other.id === id);
      if (bookmark) {
        bookmark.name = String(name).trim() || powertoysBookmarkDefaultName(bookmark.text);
      }
    });
  },
  move(ids, folder) {
    let set = new Set(ids);
    powertoysChangeBookmarks((data) => {
      if (folder !== "" && !data.folders.includes(folder)) {
        throw Error(`No folder named ${folder}`);
      }
      for (let bookmark of data.bookmarks) {
        if (set.has(bookmark.id)) {
          bookmark.folder = folder;
        }
      }
    });
  },
  /** Adds a folder, numbered when the name is taken; returns the name used. */
  addFolder(name) {
    let base = String(name).trim() || "New folder";
    return powertoysChangeBookmarks((data) => {
      let used = base;
      for (let n = 2; data.folders.some((folder) => folder.toLowerCase() === used.toLowerCase()); n++) {
        used = `${base} ${n}`;
      }
      data.folders.push(used);
      return used;
    });
  },
  /** False when the name is empty or another folder has it. */
  renameFolder(from, to) {
    to = String(to).trim();
    return powertoysChangeBookmarks((data) => {
      let index = data.folders.indexOf(from);
      if (index < 0 || to === "" || data.folders.some((folder) => folder !== from && folder.toLowerCase() === to.toLowerCase())) {
        return false;
      }
      data.folders[index] = to;
      for (let bookmark of data.bookmarks) {
        if (bookmark.folder === from) {
          bookmark.folder = to;
        }
      }
      return true;
    });
  },
  /** Deletes a folder; its bookmarks move to Unsorted. */
  deleteFolder(folder) {
    powertoysChangeBookmarks((data) => {
      data.folders = data.folders.filter((other) => other !== folder);
      for (let bookmark of data.bookmarks) {
        if (bookmark.folder === folder) {
          bookmark.folder = "";
        }
      }
    });
  },
};
