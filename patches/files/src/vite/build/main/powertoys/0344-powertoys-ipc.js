// ---------------------------------------------------------------------------------------------
// Powertoys: IPC for the page (mainView/0003-powertoys-page.js) and start-up.
// Invokes: powertoys:<name>. Pushes to the page: powertoys:settings, powertoys:snippets,
// powertoys:bookmarks, powertoys:status, powertoys:command. Only top frames on Claude's own
// origins may call in.
// ---------------------------------------------------------------------------------------------
const POWERTOYS_TRUSTED_ORIGINS = new Set(["https://claude.ai", "https://preview.claude.ai", "https://claude.com", "https://preview.claude.com", "app://localhost"]);
const powertoysPages = new Set(); // webContents that loaded the page module
function powertoysIsTrustedSender(event) {
  let frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    return false;
  }
  try {
    let url = new URL(frame.url);
    return POWERTOYS_TRUSTED_ORIGINS.has(url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin);
  } catch {
    return false;
  }
}
function powertoysBroadcast(channel, payload) {
  for (let webContents of powertoysPages) {
    if (webContents.isDestroyed()) {
      powertoysPages.delete(webContents);
    } else {
      webContents.send(channel, payload);
    }
  }
}
// Read synchronously by the page module at preload time (before the page's own scripts).
electron.ipcMain.on("powertoys:folderTrustDisabled", (event) => {
  event.returnValue = powertoysIsTrustedSender(event) && powertoysFolderTrustDisabled();
});
function powertoysHandle(name, handler) {
  electron.ipcMain.handle(`powertoys:${name}`, async (event, ...args) => {
    if (!powertoysIsTrustedSender(event)) {
      throw Error("powertoys: untrusted sender");
    }
    try {
      return await handler(event, ...args);
    } catch (caught) {
      powertoysWarn(`${name} failed: ${caught?.message ?? caught}`);
      throw caught;
    }
  });
}

/** The app's record for a local session (title, Claude Code session id), or null for cloud sessions. */
function powertoysLocalRecord(sessionId) {
  let record = powertoysSessionManager()?.sessions.get(sessionId);
  if (!record) {
    return null;
  }
  return {
    sessionId,
    title: record.title || powertoysFolderName(record),
    cliSessionId: record.cliSessionId ?? record.unarchivedCliSessionId ?? null,
  };
}
function powertoysSafeFileName(title) {
  return (title || "conversation").replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "conversation";
}

function powertoysRegisterIpc() {
  powertoysHandle("getState", (event) => {
    let webContents = event.sender;
    if (!powertoysPages.has(webContents)) {
      powertoysPages.add(webContents);
      webContents.once("destroyed", () => powertoysPages.delete(webContents));
    }
    powertoysApplyModsToPage(webContents);
    return {
      settings: powertoysSettings(),
      settingsSections: POWERTOYS_SETTINGS_SECTIONS,
      snippets: powertoysSnippets(),
      bookmarks: powertoysBookmarks.read(),
      tabs: powertoysTabs.read(),
      notes: powertoysNotes(),
      queue: powertoysPromptQueue(),
      window: powertoysWindowState(),
      status: powertoysStatusSnapshot,
    };
  });
  powertoysHandle("setSetting", (event, key, value) => {
    powertoysSetSetting(key, value);
    return powertoysSettings();
  });
  powertoysHandle("switcherSessions", (event, titles) => {
    for (let [id, title] of Object.entries(titles && typeof titles === "object" ? titles : {})) {
      if (typeof title === "string" && powertoysRecentRecord()[id] && !powertoysRecentRecord()[id].title) {
        powertoysRecentRecord()[id].title = title.slice(0, 200);
      }
    }
    return powertoysSwitcherSessions(titles && typeof titles === "object" ? titles : {});
  });
  powertoysHandle("openSession", (event, sessionId) => {
    if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) {
      throw Error("bad session id");
    }
    let webContents = event.sender;
    if (webContents === mainView?.webContents) {
      return powertoysOpenSession(sessionId);
    }
    // Other windows (code windows) navigate through their own dispatcher when they have one.
    let dispatcher = Navigation.getDispatcher(webContents);
    dispatcher?.dispatchNavigate(`/epitaxy/${encodeURIComponent(sessionId)}`);
    return !!dispatcher;
  });
  powertoysHandle("openPath", (event, routePath) => {
    if (typeof routePath !== "string" || !/^\/(epitaxy|chat|project)\/[\w%.-]+(\/[\w%.-]+)?$/.test(routePath)) {
      throw Error("bad path");
    }
    let dispatcher = Navigation.getDispatcher(event.sender);
    if (event.sender === mainView?.webContents) {
      showAndFocusWindow2();
    }
    dispatcher?.dispatchNavigate(routePath);
    return !!dispatcher;
  });
  powertoysHandle("sessionInfo", (event, sessionId) => {
    let local = powertoysLocalRecord(sessionId);
    return local ? { local: true, title: local.title } : { local: false, title: powertoysRecentRecord()[sessionId]?.title ?? "" };
  });
  powertoysHandle("conversation", async (event, sessionId) => {
    let local = powertoysLocalRecord(sessionId);
    if (!local?.cliSessionId) {
      return null;
    }
    let conversation = await powertoysTranscripts("conversation", { cliSessionId: local.cliSessionId });
    return conversation ? { title: local.title, parts: conversation.parts } : null;
  });
  powertoysHandle("copyLastAnswer", async (event, sessionId, fallbackText) => {
    let local = powertoysLocalRecord(sessionId);
    let text = local?.cliSessionId ? await powertoysTranscripts("lastAnswer", { cliSessionId: local.cliSessionId }) : null;
    text ??= typeof fallbackText === "string" && fallbackText.trim() !== "" ? fallbackText : null;
    if (!text) {
      return false;
    }
    electron.clipboard.writeText(text);
    powertoysLog(`copied the last answer (${text.length} characters)`);
    return true;
  });
  powertoysHandle("exportConversation", async (event, sessionId, fallbackMarkdown, fallbackTitle) => {
    let local = powertoysLocalRecord(sessionId);
    let title = local?.title || fallbackTitle || "Conversation";
    let markdown = local?.cliSessionId ? await powertoysTranscripts("markdown", { cliSessionId: local.cliSessionId, title }) : null;
    markdown ??= typeof fallbackMarkdown === "string" && fallbackMarkdown !== "" ? fallbackMarkdown : null;
    if (!markdown) {
      return null;
    }
    let { canceled, filePath } = await electron.dialog.showSaveDialog(electron.BrowserWindow.fromWebContents(event.sender) ?? mainWindow, {
      title: "Export conversation",
      defaultPath: powertoysPath.join(electron.app.getPath("documents"), `${powertoysSafeFileName(title)}.md`),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (canceled || !filePath) {
      return null;
    }
    await powertoysFs.promises.writeFile(filePath, markdown, "utf8");
    powertoysLog(`exported '${title}' to ${filePath}`);
    return filePath;
  });
  powertoysHandle("timeline", (event, before, query) => {
    let sessions = {};
    for (let record of powertoysSessionManager()?.sessions.values() ?? []) {
      for (let cliSessionId of [record.cliSessionId, record.unarchivedCliSessionId]) {
        if (cliSessionId) {
          sessions[cliSessionId] = { sessionId: record.sessionId, title: record.title || powertoysFolderName(record) };
        }
      }
    }
    return powertoysTranscripts("timeline", {
      before: Number.isFinite(before) ? before : Date.now() + 60000,
      windowDays: String(query ?? "").trim() ? 365 : 7,
      limit: 400,
      query: String(query ?? ""),
      sessions,
    });
  });
  powertoysHandle("promptHistory", () => powertoysTranscripts("history", { days: 30, max: 300 }));
  powertoysHandle("search", async (event, query) => {
    let manager = powertoysSessionManager();
    if (!manager) {
      return [];
    }
    await manager.ensureArchivedSessionsLoaded?.("search").catch(() => undefined);
    let sessions = [...manager.sessions.values()]
      .filter((record) => !record.prewarmHidden)
      .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
      .map((record) => ({
        sessionId: record.sessionId,
        title: record.title || powertoysFolderName(record) || "Untitled session",
        cliSessionId: record.cliSessionId ?? record.unarchivedCliSessionId ?? null,
        isArchived: record.isArchived === true,
      }));
    return powertoysTranscripts("search", { query: String(query ?? ""), sessions, max: 200 });
  });
  powertoysHandle("bookmark", (event, operation, ...args) => {
    if (!["toggle", "remove", "rename", "move", "addFolder", "renameFolder", "deleteFolder"].includes(operation)) {
      throw Error(`unknown bookmark operation ${operation}`);
    }
    return powertoysBookmarks[operation](...args);
  });
  powertoysHandle("tabs", (event, operation, ...args) => {
    if (!["open", "close", "closeMany", "reopen", "retitle", "pin", "unpin", "move"].includes(operation)) {
      throw Error(`unknown tabs operation ${operation}`);
    }
    return powertoysTabs[operation](...args);
  });
  powertoysHandle("settingsAction", (event, name) => powertoysSettingsAction(name));
  powertoysHandle("openInApps", () => powertoysOpenInApps().map((app) => app.name));
  powertoysHandle("openIn", (event, name, filePath) => powertoysOpenIn(String(name), filePath));
  powertoysHandle("statusInfo", (event, sessionId) => powertoysStatusInfo(typeof sessionId === "string" ? sessionId : null));
  powertoysHandle("openCliSession", (event, cliSessionId) => {
    if (typeof cliSessionId !== "string" || !/^[\w-]+$/.test(cliSessionId)) {
      throw Error("bad session id");
    }
    return powertoysOpenCliSession(cliSessionId);
  });
  powertoysHandle("archivedSessions", () => powertoysArchivedSessions());
  powertoysHandle("unarchive", (event, sessionId) => powertoysUnarchive(String(sessionId)));
  powertoysHandle("profiles", () => powertoysProfiles());
  powertoysHandle("launchProfile", (event, name) => powertoysLaunchProfile(String(name ?? "")));
  powertoysHandle("openWindow", (event, routePath) => powertoysOpenWindow(routePath));
  powertoysHandle("spellLanguages", () => powertoysSpellLanguagesAvailable());
  powertoysHandle("openSnippetsFile", () => electron.shell.openPath(powertoysSnippetsFile()));
  powertoysHandle("log", (event, message) => {
    powertoysLog(`page: ${String(message).slice(0, 500)}`);
  });
}

/** Called once the main window and view exist (app/0338). */
function initPowertoys() {
  try {
    powertoysWatchSnippets();
    powertoysStartSessionTracking();
    powertoysStartSystem();
    powertoysRegisterHotkeys();
    powertoysWatchRestartRequests();
    powertoysStartWork();
    powertoysContinueAfterRestart().catch((caught) => powertoysWarn(`continue after restart failed: ${caught.message}`));
    powertoysEvents.on("settings", (settings) => {
      powertoysBroadcast("powertoys:settings", settings);
      powertoysRegisterHotkeys();
      powertoysRenderBadge();
      refreshTrayContextMenu();
      notifyNavigationChanged();
    });
    powertoysEvents.on("snippets", (snippets) => {
      powertoysBroadcast("powertoys:snippets", snippets);
      refreshTrayContextMenu();
    });
    powertoysEvents.on("bookmarks", (bookmarks) => {
      powertoysBroadcast("powertoys:bookmarks", bookmarks);
      refreshTrayContextMenu();
      notifyNavigationChanged();
    });
    powertoysEvents.on("status", (status) => powertoysBroadcast("powertoys:status", status));
    powertoysEvents.on("hiddenFolders", () => requestOsEntryPointsRebuildSafe());
    powertoysEvents.on("tabs", (tabs) => powertoysBroadcast("powertoys:tabs", tabs));
    powertoysEvents.on("notes", (notes) => powertoysBroadcast("powertoys:notes", notes));
    powertoysEvents.on("queue", (queue) => powertoysBroadcast("powertoys:queue", queue));
    electron.nativeTheme.on("updated", () => {
      powertoysLastBadgeCount = -1;
      powertoysRenderBadge();
    });
    electron.app.on("will-quit", () => electron.globalShortcut.unregisterAll());
    powertoysRenderBadge();
    refreshTrayContextMenu();
    // Reading every recent transcript takes seconds the first time; do it before the first Alt+Up.
    setTimeout(() => {
      if (powertoysSetting("promptHistory")) {
        powertoysTranscripts("history", { days: 30, max: 300 }).catch((caught) => powertoysWarn(`warming history failed: ${caught.message}`));
      }
    }, 30000).unref();
    let settings = powertoysSettings();
    powertoysLog(`started: ${POWERTOYS_SWITCHES.map(([key, label]) => `${label} ${settings[key] ? "on" : "off"}`).join(", ")}`);
  } catch (caught) {
    logger.error("[powertoys] start failed: %o", caught);
  }
}

// The page asks for its state as soon as it loads, before the main window is ready; the handlers
// only read state when called, so they are registered when this file loads.
try {
  powertoysRegisterIpc();
} catch (caught) {
  logger.error("[powertoys] registering IPC failed: %o", caught);
}
