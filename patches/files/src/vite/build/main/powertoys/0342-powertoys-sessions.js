// ---------------------------------------------------------------------------------------------
// Powertoys: session status, recently used sessions, and the waiting-sessions badge.
//
// States come from the Code session manager rather than from transcripts, so a permission prompt
// counts as "needs you" (the tray app could not see those):
//   needs you  – a pending permission / question / plan approval or another blocking prompt;
//   new reply  – a turn finished after the person last had the session on screen;
//   working    – a turn is running;  idle – anything else.
// A session whose PR's checks failed after the person last had it on screen waits too ("CI failed").
// Each waiting session says why (powertoysWaitReason): a question, a permission, an error, finished.
// The session on screen while the window is focused never counts as waiting. Turns that ended
// before the app started are not "new". Cloud and remote-control sessions are not in the local
// manager; they appear in the Ctrl+Tab list from the recently-used record, without a state.
// ---------------------------------------------------------------------------------------------
const POWERTOYS_STARTED_AT = Date.now();
const powertoysSessionViews = new Map(); // local sessionId -> formatted session (formatSessionForEvent)
const powertoysTurnEndedAt = new Map(); // sessionId -> ms
const powertoysTurnStartedAt = new Map(); // sessionId -> ms, from running transitions
const powertoysSeenAt = new Map(); // sessionId -> ms the person last had it on screen
const powertoysCiChecks = new Map(); // sessionId -> its PRs' checks when last looked at ("failed", "passed", ...)
const powertoysCiFailedAt = new Map(); // sessionId -> ms its checks turned "failed" (0: failed when first seen)
var powertoysRecent = null; // { [sessionId]: { at, title } } persisted in recent.json
var powertoysStatusSnapshot = { waiting: [], working: [] };
var powertoysStatusTimer = null;
var powertoysRecentSaveTimer = null;

function powertoysSessionManager() {
  return peekClaudeCodeSessionManager();
}
function powertoysRecentRecord() {
  if (!powertoysRecent) {
    let stored = powertoysReadJson("recent.json", {});
    powertoysRecent = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  }
  return powertoysRecent;
}
/** Notes that a session was on screen; titles of cloud sessions come from the page title. */
function powertoysNoteRecent(sessionId, title) {
  let record = powertoysRecentRecord();
  let previous = record[sessionId];
  record[sessionId] = { at: Date.now(), title: title || previous?.title || "" };
  let cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (let [id, entry] of Object.entries(record)) {
    if ((entry?.at ?? 0) < cutoff) {
      delete record[id];
    }
  }
  clearTimeout(powertoysRecentSaveTimer);
  powertoysRecentSaveTimer = setTimeout(() => {
    try {
      powertoysWriteJson("recent.json", powertoysRecentRecord());
    } catch (caught) {
      powertoysWarn(`saving recent.json failed: ${caught.message}`);
    }
  }, 2000);
}

/** The session ids on screen (the primary route and the focused pane), when the window is in front. */
function powertoysSessionsOnScreen() {
  let window2 = mainWindow;
  if (!window2 || window2.isDestroyed() || !window2.isVisible() || !window2.isFocused()) {
    return [];
  }
  let ids = [];
  let routeId = powertoysRouteSessionId();
  if (routeId) {
    ids.push(routeId);
  }
  let focused = getFileIndexActiveSessionId();
  if (focused && !ids.includes(focused)) {
    ids.push(focused);
  }
  return ids;
}
/** The session in the main view's route (/epitaxy/<id>), whether or not the window is in front. */
function powertoysRouteSessionId() {
  let webContents = mainView?.webContents;
  if (!webContents || webContents.isDestroyed()) {
    return null;
  }
  try {
    let match = /^\/epitaxy\/([^/?#]+)/.exec(new URL(webContents.getURL()).pathname);
    return match && !["scheduled", "apps", "sessions", "artifact", "mobile", "dev", "search", "project", "projects"].includes(match[1])
      ? decodeURIComponent(match[1])
      : null;
  } catch {
    return null;
  }
}

function powertoysNeedsYou(view) {
  return (
    (view.pendingToolPermissions?.length ?? 0) > 0 ||
    !!view.pendingCwdTrustPrompt ||
    !!view.pendingRefusalFallbackPrompt ||
    !!view.pendingAutoModeServerFallbackPrompt
  );
}
function powertoysStateOf(view) {
  if (powertoysNeedsYou(view)) {
    return "needsYou";
  }
  if (view.turnRunning) {
    return "working";
  }
  let endedAt = powertoysTurnEndedAt.get(view.sessionId) ?? 0;
  return endedAt > powertoysSeenAtOf(view) ? "newReply" : "idle";
}
function powertoysSeenAtOf(view) {
  return Math.max(POWERTOYS_STARTED_AT, powertoysSeenAt.get(view.sessionId) ?? 0, powertoysSessionManager()?.getLastFocusedAt(view.sessionId) ?? 0);
}
function powertoysFolderName(view) {
  if (view.isScratchWorkspace) {
    return "No folder";
  }
  let folder = view.originCwd || view.cwd || "";
  return powertoysPath.basename(folder.replace(/[\\/]+$/, "")) || folder;
}
function powertoysSessionTitle(view) {
  return view.title || powertoysFolderName(view) || "Untitled session";
}

/** Recomputes the waiting / working lists; cheap, so it runs on every relevant event (debounced). */
function powertoysScheduleStatus() {
  clearTimeout(powertoysStatusTimer);
  powertoysStatusTimer = setTimeout(powertoysRecomputeStatus, 250);
}
var powertoysLastWaitingKey = "";
function powertoysRecomputeStatus() {
  let now = Date.now();
  let onScreen = powertoysSessionsOnScreen();
  for (let id of onScreen) {
    powertoysSeenAt.set(id, now);
  }
  let waiting = [];
  let working = [];
  for (let view of powertoysSessionViews.values()) {
    if (view.isArchived) {
      continue;
    }
    let state = powertoysStateOf(view);
    // Checks that turn "failed" are noted when they do; ones already failed when first seen count as known.
    let checks = powertoysSessionPrs(view).some((pr) => pr.checks === "failed") ? "failed" : "other";
    let before = powertoysCiChecks.get(view.sessionId);
    if (checks === "failed" && before !== "failed") {
      powertoysCiFailedAt.set(view.sessionId, before === undefined ? 0 : now);
    } else if (checks !== "failed") {
      powertoysCiFailedAt.delete(view.sessionId);
    }
    powertoysCiChecks.set(view.sessionId, checks);
    if ((state === "idle" || state === "working") && (powertoysCiFailedAt.get(view.sessionId) ?? 0) > powertoysSeenAtOf(view)) {
      state = "ciFailed";
    }
    let item = {
      sessionId: view.sessionId,
      title: powertoysSessionTitle(view),
      state: state === "ciFailed" ? (view.turnRunning ? "working" : "idle") : state,
      reason: powertoysWaitReason(view, state),
      turnStartedAt: powertoysTurnStartedAt.get(view.sessionId) ?? 0,
      lastActivityAt: view.lastActivityAt ?? 0,
    };
    if ((state === "needsYou" || state === "newReply" || state === "ciFailed") && !onScreen.includes(view.sessionId)) {
      waiting.push({ ...item, state });
    }
    if (item.state === "working") {
      working.push(item);
    }
  }
  // Most urgent first (an answer, failed checks, an error, a finished turn); oldest first within each.
  waiting.sort((left, right) => powertoysUrgency(left) - powertoysUrgency(right) || left.lastActivityAt - right.lastActivityAt);
  powertoysStatusSnapshot = { waiting, working };
  // The tray lists each waiting permission request too, so a new one in the same session counts.
  let key = `${waiting.map((item) => `${item.sessionId}:${item.state}:${item.reason}`).join("|")}#${powertoysPendingPermissions().map((request) => request.requestId).join(",")}`;
  if (key !== powertoysLastWaitingKey) {
    powertoysLastWaitingKey = key;
    powertoysLog(`waiting sessions: ${waiting.length === 0 ? "none" : waiting.map((item) => `'${item.title}' (${item.reason || item.state})`).join(", ")}`);
    if (typeof refreshTrayContextMenu === "function") {
      refreshTrayContextMenu();
    }
  }
  powertoysRenderBadge();
  powertoysEvents.emit("status", powertoysStatusSnapshot);
}

function powertoysTurnAge(startedAt) {
  if (!startedAt) {
    return "";
  }
  let minutes = Math.floor((Date.now() - startedAt) / 60000);
  return minutes < 1 ? "<1 min" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
const POWERTOYS_STATE_LABELS = { needsYou: "needs you", newReply: "new reply", ciFailed: "CI failed", working: "working", idle: "idle" };
const POWERTOYS_URGENCY = { needsYou: 0, ciFailed: 1, error: 2, newReply: 3 };
function powertoysUrgency(item) {
  return item.reason === "error" ? POWERTOYS_URGENCY.error : (POWERTOYS_URGENCY[item.state] ?? 9);
}

/** Starts tracking once the Code session manager exists. */
function powertoysStartSessionTracking() {
  onClaudeCodeSessionManagerLoaded((manager) => {
    manager
      .getAllSessions()
      .then((sessions) => {
        for (let view of sessions) {
          powertoysSessionViews.set(view.sessionId, view);
          if (view.turnRunning) {
            powertoysTurnStartedAt.set(view.sessionId, 0);
          }
        }
        powertoysScheduleStatus();
      })
      .catch((caught) => powertoysWarn(`listing sessions failed: ${caught?.message ?? caught}`));
    manager.on("event", (event) => {
      if (event?.type === "session_updated" && event.session?.sessionId) {
        let previous = powertoysSessionViews.get(event.session.sessionId);
        if (event.session.turnRunning && !previous?.turnRunning) {
          powertoysTurnStartedAt.set(event.session.sessionId, Date.now());
        }
        powertoysSessionViews.set(event.session.sessionId, event.session);
        powertoysScheduleStatus();
      } else if (event?.type === "deleted" && event.sessionId) {
        powertoysSessionViews.delete(event.sessionId);
        powertoysScheduleStatus();
      } else if (event?.type === "tool_permission_request" || event?.type === "tool_permission_resolved") {
        powertoysScheduleStatus();
      }
    });
    manager.on("queryCompleted", (sessionId) => {
      powertoysTurnEndedAt.set(sessionId, Date.now());
      powertoysScheduleStatus();
      // The next queued prompt, once the session has settled (a permission prompt or an error holds it).
      setTimeout(() => powertoysSendQueued(sessionId, "turn ended"), 2000);
    });
    // PR checks change without a session event.
    getForgeStateTracker().subscribe(() => powertoysScheduleStatus());
  });
  // What is on screen changes with focus and navigation, not only with session events.
  let watchWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    for (let eventName of ["focus", "blur", "show", "hide"]) {
      mainWindow.on(eventName, powertoysScheduleStatus);
    }
    // The page's sidebar auto-hide works only while the window is maximized (or full screen).
    for (let eventName of ["maximize", "unmaximize", "restore", "enter-full-screen", "leave-full-screen"]) {
      mainWindow.on(eventName, () => powertoysBroadcast("powertoys:window", powertoysWindowState()));
    }
    let webContents = mainView?.webContents;
    if (webContents && !webContents.isDestroyed()) {
      let noteRoute = () => {
        let id = powertoysRouteSessionId();
        if (id) {
          powertoysNoteRecent(id, powertoysTitleFromPage(webContents.getTitle()));
        }
        powertoysScheduleStatus();
      };
      webContents.on("did-navigate-in-page", noteRoute);
      webContents.on("did-navigate", noteRoute);
      webContents.on("page-title-updated", noteRoute);
    }
  };
  watchWindow();
  // Focused-pane changes (split view) arrive through setFocusedSession, which has no event here.
  let lastFocused = null;
  setInterval(() => {
    let focused = getFileIndexActiveSessionId();
    if (focused && focused !== lastFocused && mainWindow?.isFocused()) {
      lastFocused = focused;
      powertoysNoteRecent(focused, powertoysSessionViews.get(focused)?.title);
      powertoysScheduleStatus();
    }
  }, 1500).unref();
  // Keeps "working 12 min" in the tooltip current.
  setInterval(() => powertoysStatusSnapshot.working.length > 0 && powertoysRenderBadge(), 30000).unref();
}
function powertoysWindowState() {
  let usable = mainWindow && !mainWindow.isDestroyed();
  return { maximized: !!(usable && (mainWindow.isMaximized() || mainWindow.isFullScreen())) };
}
function powertoysTitleFromPage(pageTitle) {
  return String(pageTitle ?? "")
    .replace(/\s+[-–]\s+Claude(?: Code)?$/, "")
    .trim();
}

/**
 * The Ctrl+Tab list: local sessions active within the window and sessions recently on screen,
 * most recently used first; the one on screen always first.
 */
async function powertoysSwitcherSessions(pageTitles = {}) {
  let manager = powertoysSessionManager();
  let windowMs = Math.max(0.25, powertoysSetting("recentSessionHours")) * 3600 * 1000;
  let since = Date.now() - windowMs;
  let recent = powertoysRecentRecord();
  let current = getFileIndexActiveSessionId() ?? powertoysRouteSessionId();
  let items = new Map();
  for (let view of powertoysSessionViews.values()) {
    if (view.isArchived) {
      continue;
    }
    let usedAt = Math.max(manager?.getLastFocusedAt(view.sessionId) ?? 0, recent[view.sessionId]?.at ?? 0);
    if ((view.lastActivityAt ?? 0) < since && usedAt < since && view.sessionId !== current) {
      continue;
    }
    items.set(view.sessionId, {
      sessionId: view.sessionId,
      title: powertoysSessionTitle(view),
      folder: powertoysFolderName(view),
      state: powertoysStateOf(view),
      usedAt,
      local: true,
      cliSessionId: manager?.sessions.get(view.sessionId)?.cliSessionId ?? null,
    });
  }
  for (let [id, entry] of Object.entries(recent)) {
    if (items.has(id) || powertoysSessionViews.has(id) || ((entry?.at ?? 0) < since && id !== current)) {
      continue;
    }
    let title = entry.title || (typeof pageTitles[id] === "string" ? pageTitles[id] : "") || "Session";
    items.set(id, { sessionId: id, title, folder: "", state: "", usedAt: entry.at, local: false, cliSessionId: null });
  }
  let list = [...items.values()].sort((left, right) => right.usedAt - left.usedAt);
  let currentIndex = list.findIndex((item) => item.sessionId === current);
  if (currentIndex > 0) {
    list.unshift(...list.splice(currentIndex, 1));
  }
  // After the current one and the one used before it (a quick Ctrl+Tab goes back), those waiting for you,
  // most urgent first; then the rest, most recently used first.
  let waitingNow = new Map(powertoysStatusSnapshot.waiting.map((item) => [item.sessionId, item]));
  let rest = list.slice(2);
  let urgent = rest.filter((item) => waitingNow.has(item.sessionId)).sort((left, right) => powertoysUrgency(waitingNow.get(left.sessionId)) - powertoysUrgency(waitingNow.get(right.sessionId)));
  list = [...list.slice(0, 2), ...urgent, ...rest.filter((item) => !waitingNow.has(item.sessionId))];
  let tails = {};
  try {
    tails = await powertoysTranscripts("tails", { cliSessionIds: list.map((item) => item.cliSessionId).filter(Boolean) });
  } catch (caught) {
    powertoysWarn(`reading transcript tails failed: ${caught.message}`);
  }
  return list.map((item) => {
    let tail = item.cliSessionId ? tails[item.cliSessionId] : undefined;
    let startedAt = powertoysTurnStartedAt.get(item.sessionId) || tail?.turnStartedAt || 0;
    return {
      sessionId: item.sessionId,
      title: item.title,
      folder: item.folder,
      state: item.state,
      stateLabel: (waitingNow.get(item.sessionId)?.reason || POWERTOYS_STATE_LABELS[waitingNow.get(item.sessionId)?.state ?? item.state]) ?? "",
      turnAge: item.state === "working" || item.state === "needsYou" ? powertoysTurnAge(startedAt) : "",
      contextTokens: tail?.contextTokens ?? 0,
      local: item.local,
    };
  });
}

/** Whether a local session's file says it is archived (the session manager is not loaded yet at launch). */
function powertoysLocalSessionArchived(sessionId) {
  let root = powertoysPath.join(electron.app.getPath("userData"), "claude-code-sessions");
  let stack = [root];
  for (let depth = 0; stack.length && depth < 4000; depth++) {
    let dir = stack.pop();
    let entries;
    try {
      entries = powertoysFs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let entry of entries) {
      if (entry.isDirectory()) {
        stack.push(powertoysPath.join(dir, entry.name));
      } else if (entry.name === `${sessionId}.json`) {
        try {
          let head = powertoysFs.readFileSync(powertoysPath.join(dir, entry.name), "utf8").slice(0, 64 * 1024);
          return /"isArchived"\s*:\s*true/.test(head);
        } catch {
          return false;
        }
      }
    }
  }
  return null; // no such local session
}
/**
 * The cold-launch URL with the most recently used code conversation instead of the Code home, when
 * there is one; the page restores its split layout around it.
 */
function powertoysColdLaunchUrl(startUrl) {
  try {
    if (!powertoysSetting("openRecentOnLaunch")) {
      return startUrl;
    }
    let recent = Object.entries(powertoysRecentRecord()).sort((left, right) => (right[1]?.at ?? 0) - (left[1]?.at ?? 0));
    for (let [sessionId] of recent.slice(0, 5)) {
      if (!/^[\w-]+$/.test(sessionId)) {
        continue;
      }
      if (sessionId.startsWith("local_") && powertoysLocalSessionArchived(sessionId) !== false) {
        continue; // archived or gone
      }
      let url = new URL(startUrl);
      url.pathname = `/epitaxy/${encodeURIComponent(sessionId)}`;
      powertoysLog(`launch: opening the most recent code conversation (${recent.find(([id]) => id === sessionId)?.[1]?.title || sessionId})`);
      return url;
    }
  } catch (caught) {
    powertoysWarn(`launch: choosing the recent conversation failed: ${caught.message}`);
  }
  return startUrl;
}

/** Brings the window forward and opens a session in the main view. */
function powertoysOpenSession(sessionId) {
  if (!mainView || mainView.webContents.isDestroyed()) {
    return false;
  }
  showAndFocusWindow2();
  navigateTo(`/epitaxy/${encodeURIComponent(sessionId)}`, mainView, false);
  return true;
}
function powertoysOpenDeepLink(url) {
  showAndFocusWindow2();
  handleClaudeDeepLinkWhenMainViewReady(url);
}

// --- Badge --------------------------------------------------------------------------------------
// Drawn into BGRA bitmaps (no canvas in the main process): a red disc with the count in a pixel font.
const POWERTOYS_DIGITS = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};
/** Draws the badge over `base` (BGRA, size×size) or onto a transparent square; returns the buffer. */
function powertoysDrawBadge(size, count, base) {
  let pixels = base ? Buffer.from(base) : Buffer.alloc(size * size * 4);
  let text = count > 9 ? "9+" : String(count);
  let radius = base ? size * 0.34 : size * 0.5;
  let centerX = size - radius;
  let centerY = size - radius;
  let blend = (x, y, b, g, r, alpha) => {
    if (x < 0 || y < 0 || x >= size || y >= size || alpha <= 0) {
      return;
    }
    let i = (y * size + x) * 4;
    let a = Math.min(1, alpha);
    let baseAlpha = pixels[i + 3] / 255;
    let outAlpha = a + baseAlpha * (1 - a);
    for (let [offset, value] of [
      [0, b],
      [1, g],
      [2, r],
    ]) {
      pixels[i + offset] = Math.round((value * a + pixels[i + offset] * baseAlpha * (1 - a)) / (outAlpha || 1));
    }
    pixels[i + 3] = Math.round(outAlpha * 255);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      // A 1px dark ring keeps the disc readable over the icon.
      if (base) {
        blend(x, y, 30, 30, 30, radius + 1 - distance);
      }
      blend(x, y, 59, 59, 220, radius - distance + 0.5);
    }
  }
  let scale = Math.max(1, Math.floor((radius * 2) / 8));
  let glyphWidth = 3 * scale;
  let gap = scale;
  let textWidth = text.length * glyphWidth + (text.length - 1) * gap;
  let left = Math.round(centerX - textWidth / 2);
  let top = Math.round(centerY - (5 * scale) / 2);
  [...text].forEach((character, index) => {
    let rows = POWERTOYS_DIGITS[character];
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 3; column++) {
        if (rows[row][column] === "1") {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              blend(left + index * (glyphWidth + gap) + column * scale + dx, top + row * scale + dy, 255, 255, 255, 1);
            }
          }
        }
      }
    }
  });
  return pixels;
}
/** The tray icon with the count drawn in, at 1x (16 px) and 2x (32 px). */
function powertoysBadgedTrayImage(trayIconPath, count) {
  let source = electron.nativeImage.createFromPath(trayIconPath);
  let image = electron.nativeImage.createEmpty();
  for (let [size, scaleFactor] of [
    [16, 1],
    [24, 1.5],
    [32, 2],
  ]) {
    let base = source.resize({ width: size, height: size, quality: "best" }).toBitmap();
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: powertoysDrawBadge(size, count, base) });
  }
  return image;
}
function powertoysOverlayImage(count) {
  let image = electron.nativeImage.createEmpty();
  for (let [size, scaleFactor] of [
    [16, 1],
    [24, 1.5],
    [32, 2],
  ]) {
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: powertoysDrawBadge(size, count, null) });
  }
  return image;
}

function powertoysTooltip() {
  let { waiting, working } = powertoysStatusSnapshot;
  let lines = [`${electron.app.getName()}${process.env.POWERTOYS_PROFILE ? ` (${process.env.POWERTOYS_PROFILE})` : ""}`];
  if (waiting.length > 0) {
    lines.push(`${waiting.length} waiting: ${waiting.map((item) => `${item.title} (${item.reason || POWERTOYS_STATE_LABELS[item.state]})`).join(", ")}`);
  }
  if (working.length > 0) {
    lines.push(`${working.length} working: ${working.map((item) => `${item.title}${item.turnStartedAt ? ` ${powertoysTurnAge(item.turnStartedAt)}` : ""}`).join(", ")}`);
  }
  let text = lines.join("\n");
  // Windows cuts tray tooltips at 127 characters.
  return text.length <= 127 ? text : `${text.slice(0, 126)}…`;
}

var powertoysLastBadgeCount = -1;
function powertoysRenderBadge() {
  let count = powertoysSetting("waitingBadge") ? powertoysStatusSnapshot.waiting.length : 0;
  let trayIconPath = powertoysPath.join(getResourcesPath(), getTrayIconFileName(false));
  // The tray reads its image and tooltip from this controller (also after a theme change).
  trayIconController = {
    image: count > 0 ? powertoysBadgedTrayImage(trayIconPath, count) : electron.nativeImage.createFromPath(trayIconPath),
    tooltip: powertoysTooltip(),
    onClick: powertoysTrayClicked,
  };
  if (trayIcon && !trayIcon.isDestroyed()) {
    if (count !== powertoysLastBadgeCount || currentTrayIconPath !== trayIconPath) {
      trayIcon.setImage(trayIconController.image);
      currentTrayIconPath = trayIconPath;
    }
    trayIcon.setToolTip(trayIconController.tooltip);
  }
  if (count !== powertoysLastBadgeCount && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOverlayIcon(count > 0 ? powertoysOverlayImage(count) : null, count > 0 ? `${count} sessions waiting for you` : "");
  }
  powertoysLastBadgeCount = count;
}
/** Left click on the tray: the first waiting session, else what the app normally does. */
function powertoysTrayClicked() {
  let first = powertoysStatusSnapshot.waiting[0];
  if (first) {
    powertoysLog(`tray: opening waiting session '${first.title}'`);
    powertoysOpenSession(first.sessionId);
    return;
  }
  activateQuickEntryOrShowMainWindow();
}
