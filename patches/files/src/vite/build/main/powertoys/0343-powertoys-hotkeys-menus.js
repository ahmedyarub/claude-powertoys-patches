// ---------------------------------------------------------------------------------------------
// Powertoys: global hotkeys, the recent-folders menu, and the Powertoys items in the tray menu
// and the application menu.
//   Win+Alt+C – the app's own "Sessions waiting for you" (claude://code/needs-input)
//   Win+Alt+N – a menu at the mouse of recent session folders (1-9, 0 = no folder) that starts a
//               new Code session there (claude://code/new?folder=, as the jump list does)
// ---------------------------------------------------------------------------------------------
const powertoysHotkeyState = new Map(); // setting key -> { accelerator, registered }
const POWERTOYS_HOTKEYS = [
  ["needsInputHotkey", "needsInputHotkeyKeys", () => powertoysOpenDeepLink("claude://code/needs-input?source=desktop_action")],
  ["newSessionHotkey", "newSessionHotkeyKeys", () => powertoysShowRecentFoldersMenu()],
  ["quickSendHotkey", "quickSendHotkeyKeys", () => powertoysOpenQuickSend().catch((caught) => powertoysWarn(`quick send failed: ${caught.message}`))],
];
function powertoysDisplayKeys(accelerator) {
  return accelerator.replace(/\bSuper\b/g, "Win").replace(/\bCommandOrControl\b|\bCmdOrCtrl\b/g, "Ctrl");
}
/** (Re)registers the global hotkeys from the settings; a combination owned by another program is reported in the menu. */
function powertoysRegisterHotkeys() {
  for (let [switchKey, keysKey, action] of POWERTOYS_HOTKEYS) {
    let previous = powertoysHotkeyState.get(switchKey);
    if (previous?.registered) {
      electron.globalShortcut.unregister(previous.accelerator);
    }
    let accelerator = powertoysSetting(keysKey);
    let registered = false;
    if (powertoysSetting(switchKey)) {
      try {
        registered = electron.globalShortcut.register(accelerator, () => {
          try {
            action();
          } catch (caught) {
            powertoysWarn(`${accelerator} failed: ${caught.message}`);
          }
        });
      } catch (caught) {
        powertoysWarn(`${accelerator} is not a valid accelerator: ${caught.message}`);
      }
      if (!registered) {
        powertoysWarn(`${powertoysDisplayKeys(accelerator)} is taken by another program`);
      }
    }
    powertoysHotkeyState.set(switchKey, { accelerator, registered });
  }
}

/** Folders of unarchived local sessions, most recently active first (scratch "No folder" ones left out). */
function powertoysRecentFolders(max) {
  let views = [...powertoysSessionViews.values()]
    .filter((view) => !view.isArchived && !view.isScratchWorkspace && !view.remoteTarget && !view.sshConfig && view.folderExists !== false)
    .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
  let seen = new Set();
  let folders = [];
  for (let view of views) {
    let folder = (view.originCwd || view.cwd || "").replace(/[\\/]+$/, "");
    if (!folder || seen.has(folder.toLowerCase()) || powertoysIsFolderHidden(folder) || !powertoysFs.existsSync(folder)) {
      continue;
    }
    seen.add(folder.toLowerCase());
    folders.push(folder);
    if (folders.length >= max) {
      break;
    }
  }
  return folders;
}
function powertoysNewSessionLink(folder) {
  return `claude://code/new?source=desktop_action${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
}
function powertoysShowRecentFoldersMenu() {
  let folders = powertoysRecentFolders(9);
  let template = [
    { label: "New session in…", enabled: false },
    ...folders.map((folder, index) => ({
      label: `&${index + 1}  ${powertoysPath.basename(folder).replace(/&/g, "&&")}`,
      sublabel: folder,
      toolTip: folder,
      click: () => powertoysOpenDeepLink(powertoysNewSessionLink(folder)),
    })),
    { type: "separator" },
    { label: "&0  No folder", click: () => powertoysOpenDeepLink(powertoysNewSessionLink(null)) },
    ...(folders.length
      ? [
          { type: "separator" },
          {
            label: "Remove from this list",
            submenu: folders.map((folder) => ({ label: folder.replace(/&/g, "&&"), click: () => powertoysHideFolder(folder, true) })),
          },
        ]
      : []),
  ];
  let menu = electron.Menu.buildFromTemplate(template);
  let point = electron.screen.getCursorScreenPoint();
  // The tray's own window can take the foreground for a menu, so its keys work from any app.
  if (trayIcon && !trayIcon.isDestroyed()) {
    trayIcon.popUpContextMenu(menu, point);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    showAndFocusWindow2();
    menu.popup({ window: mainWindow });
  }
}

/** Sends a command to the page in the main view (snippets, bookmarks, search, …). */
function powertoysCommandMainView(command) {
  let webContents = mainView?.webContents;
  if (!webContents || webContents.isDestroyed()) {
    return;
  }
  showAndFocusWindow2();
  webContents.focus();
  webContents.send("powertoys:command", command);
}

function powertoysSnippetMenuItems() {
  let snippets = [];
  try {
    snippets = powertoysSnippets();
  } catch (caught) {
    powertoysWarn(`reading snippets failed: ${caught.message}`);
  }
  return [
    ...snippets.map((snippet) => ({
      label: snippet.name.replace(/&/g, "&&"),
      toolTip: snippet.text,
      click: () => powertoysCommandMainView({ type: "insert", text: snippet.text }),
    })),
    ...(snippets.length ? [{ type: "separator" }] : []),
    { label: "Edit snippets…", click: () => electron.shell.openPath(powertoysSnippetsFile()) },
  ];
}
function powertoysBookmarkMenuItems() {
  let { folders, bookmarks } = powertoysBookmarks.read();
  let item = (bookmark) => ({
    label: `★  ${bookmark.name}  ·  ${bookmark.sessionTitle}`.replace(/&/g, "&&").slice(0, 120),
    toolTip: bookmark.text,
    click: () => powertoysRevealBookmark(bookmark),
  });
  return [
    ...folders.map((folder) => {
      let inFolder = bookmarks.filter((bookmark) => bookmark.folder === folder);
      return {
        label: `📁  ${folder}`.replace(/&/g, "&&"),
        submenu: inFolder.length ? inFolder.slice(0, 40).map(item) : [{ label: "(empty)", enabled: false }],
      };
    }),
    ...bookmarks
      .filter((bookmark) => bookmark.folder === "")
      .slice(0, 30)
      .map(item),
    ...(bookmarks.length === 0 ? [{ label: "No bookmarks: right-click a message and choose Bookmark message", enabled: false }] : []),
    { type: "separator" },
    { label: "Manage bookmarks…", click: () => powertoysCommandMainView({ type: "openBookmarks" }) },
  ];
}
/** Opens the bookmark's session; the page scrolls to the message once it is on screen. */
function powertoysRevealBookmark(bookmark) {
  powertoysLog(`opening bookmark in '${bookmark.sessionTitle}'`);
  powertoysOpenSession(bookmark.sessionId);
  mainView?.webContents.send("powertoys:command", {
    type: "reveal",
    sessionId: bookmark.sessionId,
    keys: [bookmark.entryId],
    text: bookmark.text,
  });
}
function powertoysSwitchMenuItems() {
  return [
    ...POWERTOYS_SWITCHES.map(([key, label]) => {
      let hotkey = POWERTOYS_HOTKEYS.find(([switchKey]) => switchKey === key);
      let state = hotkey && powertoysHotkeyState.get(key);
      let keys = hotkey ? ` (${powertoysDisplayKeys(powertoysSetting(hotkey[1]))})` : "";
      let taken = state && powertoysSetting(key) && !state.registered ? " – taken by another program" : "";
      return {
        label: `${label}${keys}${taken}`.replace(/&/g, "&&"),
        type: "checkbox",
        checked: powertoysSetting(key),
        click: (menuItem) => powertoysSetSetting(key, menuItem.checked),
      };
    }),
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: powertoysStartupEnabled(),
      click: (menuItem) => {
        appStartupSettings.setStartupOnLoginEnabled(menuItem.checked);
        powertoysLog(`start with Windows: ${menuItem.checked}`);
        refreshTrayContextMenu();
      },
    },
    { label: "Open Powertoys folder", click: () => electron.shell.openPath(powertoysDir()) },
  ];
}
function powertoysStartupEnabled() {
  try {
    return !!appStartupSettings.isStartupOnLoginEnabled();
  } catch {
    return false;
  }
}

/** Profiles: the default one, each %APPDATA%\Claude-<name>, and a new one (named in the page). */
function powertoysProfileMenuItems() {
  let { current, profiles } = powertoysProfiles();
  let item = (name, label) => ({
    label: label.replace(/&/g, "&&"),
    type: "radio",
    checked: name === current,
    click: () => powertoysLaunchProfile(name),
  });
  return [
    item("", "Default"),
    ...profiles.map((name) => item(name, name)),
    { type: "separator" },
    { label: "New profile…", click: () => powertoysCommandMainView({ type: "newProfile" }) },
  ];
}

/** The Powertoys block of the tray menu: waiting sessions, snippets, bookmarks, search, switches. */
function buildPowertoysTrayMenuItems() {
  let { waiting } = powertoysStatusSnapshot;
  return [
    ...powertoysPendingPermissionMenuItems(),
    ...(waiting.length
      ? [
          { label: "Waiting for you", enabled: false },
          ...waiting.slice(0, 8).map((item) => ({
            label: `${item.state === "needsYou" ? "●" : "○"}  ${item.title}  ·  ${item.reason || POWERTOYS_STATE_LABELS[item.state]}`.replace(/&/g, "&&").slice(0, 120),
            click: () => powertoysOpenSession(item.sessionId),
          })),
          { type: "separator" },
        ]
      : []),
    ...(powertoysSetting("snippets") ? [{ label: "Snippets", submenu: powertoysSnippetMenuItems() }] : []),
    ...(powertoysSetting("bookmarks") ? [{ label: "Bookmarks", submenu: powertoysBookmarkMenuItems() }] : []),
    ...(powertoysSetting("search") ? [{ label: "Search all sessions…", click: () => powertoysCommandMainView({ type: "openSearch" }) }] : []),
    ...(powertoysSetting("history") ? [{ label: "History…", click: () => powertoysCommandMainView({ type: "openHistory" }) }] : []),
    { label: "Archived sessions…", click: () => powertoysCommandMainView({ type: "openArchived" }) },
    { label: "Notification inbox…", click: () => powertoysCommandMainView({ type: "openInbox" }) },
    { label: "Workspaces", submenu: powertoysWorkspaceMenuItems() },
    { label: "Quick send…", click: () => powertoysOpenQuickSend().catch((caught) => powertoysWarn(caught.message)) },
    { label: "Profiles", submenu: powertoysProfileMenuItems() },
    { label: "Rebuild and restart Claude", click: () => powertoysRestartAndContinue({ rebuild: true, source: "tray" }).catch((caught) => powertoysWarn(caught.message)) },
    { label: "Powertoys settings…", click: () => powertoysCommandMainView({ type: "openSettings" }) },
    { label: "Powertoys", submenu: powertoysSwitchMenuItems() },
    { type: "separator" },
  ];
}
/** The application menu's Powertoys menu (the menu bar shows on Alt). */
function buildPowertoysApplicationMenu() {
  return {
    label: "&Powertoys",
    submenu: [
      ...(powertoysSetting("search") ? [{ label: "Search all sessions…", accelerator: "Ctrl+Shift+S", registerAccelerator: false, click: () => powertoysCommandMainView({ type: "openSearch" }) }] : []),
      ...(powertoysSetting("history") ? [{ label: "History…", accelerator: "Ctrl+H", registerAccelerator: false, click: () => powertoysCommandMainView({ type: "openHistory" }) }] : []),
      ...(powertoysSetting("bookmarks") ? [{ label: "Bookmarks", submenu: powertoysBookmarkMenuItems() }] : []),
      ...(powertoysSetting("snippets") ? [{ label: "Snippets", submenu: powertoysSnippetMenuItems() }] : []),
      { label: "Archived sessions…", click: () => powertoysCommandMainView({ type: "openArchived" }) },
      { label: "Profiles", submenu: powertoysProfileMenuItems() },
      { type: "separator" },
      { label: "Settings…", click: () => powertoysCommandMainView({ type: "openSettings" }) },
      { type: "separator" },
      ...powertoysSwitchMenuItems(),
    ],
  };
}
