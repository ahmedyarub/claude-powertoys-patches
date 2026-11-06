// ---------------------------------------------------------------------------------------------
// Powertoys: status bar data, terminal (CLI) sessions, archived sessions, profiles, extra windows,
// and the Cowork switches.
// ---------------------------------------------------------------------------------------------

// --- Status bar --------------------------------------------------------------------------------
var powertoysPlanUsageCache = { at: 0, value: null, pending: null };
/** Plan usage (5-hour and weekly limits) from the same reader Claude Code sessions use, cached 2 min. */
async function powertoysPlanUsage() {
  if (Date.now() - powertoysPlanUsageCache.at < 120000) {
    return powertoysPlanUsageCache.value;
  }
  powertoysPlanUsageCache.pending ??= (async () => {
    try {
      let read = await require("./ccd-plan-usage.js").readPlanUsage();
      let limits = read?.kind === "ok" ? read.usage?.rate_limits : null;
      let window = (entry) => (entry && typeof entry.utilization === "number" ? { percent: entry.utilization, resetsAt: entry.resets_at ?? null } : null);
      // Weekly limits of one model ("Fable") come as model_scoped: { name, percent, resetsAt } each.
      let scoped = (limits?.model_scoped ?? []).flatMap((entry) => {
        let each = window(entry);
        return each && entry.display_name ? [{ name: entry.display_name, ...each }] : [];
      });
      powertoysPlanUsageCache.value = limits ? { fiveHour: window(limits.five_hour), sevenDay: window(limits.seven_day), scoped } : null;
      // What the plan's limits answer was, logged when it changes (which windows the plan reports).
      let seen = JSON.stringify(read?.kind === "ok" ? read.usage?.rate_limits ?? null : read);
      if (seen !== powertoysPlanUsageCache.seen) {
        powertoysPlanUsageCache.seen = seen;
        powertoysLog(`plan usage: ${seen.slice(0, 600)}`);
      }
    } catch (caught) {
      powertoysWarn(`plan usage: ${caught.message}`);
    }
    powertoysPlanUsageCache.at = Date.now();
    powertoysPlanUsageCache.pending = null;
    return powertoysPlanUsageCache.value;
  })();
  return powertoysPlanUsageCache.pending;
}
/**
 * The output so far of a session's running commands. Claude Code writes a command's output to
 * <temp>\claude\<project>\<session>\tasks\<id>.output while it runs (deleted when it ends). Each tool call is paired
 * with the newest unclaimed file created after the call was written to the transcript, newest call first, so a
 * background command started earlier keeps its own file. Only the last 64 KB is read (from its first whole line),
 * with terminal colour codes dropped and a carriage-return-redrawn line kept as its last state.
 * { toolId: { text, size, truncated } } for the calls found.
 */
const POWERTOYS_OUTPUT_TAIL = 64 * 1024;
const powertoysTasksDirs = new Map(); // cliSessionId -> tasks folder
const powertoysOutputPaired = new Set(); // tool ids whose pairing was logged
function powertoysTasksDir(cliSessionId) {
  if (!/^[\w-]+$/.test(cliSessionId)) {
    return null;
  }
  let known = powertoysTasksDirs.get(cliSessionId);
  if (known && powertoysFs.existsSync(known)) {
    return known;
  }
  let root = powertoysPath.join(process.env.CLAUDE_CODE_TMPDIR || powertoysOs.tmpdir(), "claude");
  let projects = [];
  try {
    projects = powertoysFs.readdirSync(root);
  } catch {}
  for (let project of projects) {
    let dir = powertoysPath.join(root, project, cliSessionId, "tasks");
    if (powertoysFs.existsSync(dir)) {
      powertoysTasksDirs.set(cliSessionId, dir);
      return dir;
    }
  }
  return null;
}
async function powertoysCommandOutput(cliSessionId, toolIds) {
  let dir = powertoysTasksDir(cliSessionId);
  if (!dir || !toolIds.length) {
    return {};
  }
  let times = await powertoysTranscripts("itemTimes", { cliSessionId, ids: toolIds });
  let files = [];
  for (let name of await powertoysFs.promises.readdir(dir).catch(() => [])) {
    if (name.endsWith(".output")) {
      try {
        let stat = await powertoysFs.promises.stat(powertoysPath.join(dir, name));
        files.push({ name, born: stat.birthtimeMs, size: stat.size });
      } catch {}
    }
  }
  files.sort((left, right) => right.born - left.born);
  let result = {};
  for (let id of toolIds.filter((each) => times[each] > 0).sort((left, right) => times[right] - times[left])) {
    let index = files.findIndex((file) => file.born >= times[id] - 2000);
    if (index < 0) {
      continue;
    }
    let [file] = files.splice(index, 1);
    let start = Math.max(0, file.size - POWERTOYS_OUTPUT_TAIL);
    let handle;
    try {
      handle = await powertoysFs.promises.open(powertoysPath.join(dir, file.name), "r");
      let buffer = Buffer.alloc(file.size - start);
      let { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) {
        text = text.slice(text.indexOf("\n") + 1);
      }
      text = text
        .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.slice(line.lastIndexOf("\r") + 1))
        .join("\n");
      result[id] = { text, size: file.size, truncated: start > 0 };
    } catch (caught) {
      powertoysWarn(`command output ${file.name}: ${caught.message}`);
    } finally {
      await handle?.close();
    }
    if (!powertoysOutputPaired.has(id)) {
      powertoysOutputPaired.add(id);
      powertoysLog(`command output: ${id} (written ${new Date(times[id]).toISOString()}) -> ${file.name} (created ${new Date(file.born).toISOString()}, ${file.size} bytes)`);
    }
  }
  return result;
}
/** What the status bar shows for a session: where it works, model, mode, context, and plan usage. */
async function powertoysStatusInfo(sessionId) {
  let manager = powertoysSessionManager();
  let record = sessionId ? manager?.sessions.get(sessionId) : null;
  let view = sessionId ? powertoysSessionViews.get(sessionId) : null;
  let info = { profile: process.env.POWERTOYS_PROFILE ?? "", plan: await powertoysPlanUsage() };
  if (!record) {
    return info;
  }
  let cliSessionId = record.cliSessionId ?? record.unarchivedCliSessionId;
  let tail = cliSessionId ? (await powertoysTranscripts("tails", { cliSessionIds: [cliSessionId] }).catch(() => ({})))[cliSessionId] : null;
  let folder = record.worktreePath || record.cwd || "";
  return {
    ...info,
    local: true,
    folder,
    folderName: view?.isScratchWorkspace ? "No folder" : powertoysPath.basename(folder.replace(/[\\/]+$/, "")),
    branch: record.branch ?? "",
    worktree: record.worktreeName ?? "",
    model: record.model ?? "",
    effort: record.effort ?? "",
    permissionMode: record.permissionMode ?? "",
    // Compacted since the last reply: the app's own figure is the old size until the next reply; the tail's estimate.
    contextTokens: (tail?.compactedAt > (tail?.lastResponseAt || 0) ? tail.contextTokens : record.lastResponseContextTokens || tail?.contextTokens) || 0,
    contextEstimated: Boolean(tail?.contextEstimated && tail.compactedAt > (tail.lastResponseAt || 0)),
    state: view ? powertoysStateOf(view) : "",
    turnAge: view?.turnRunning ? powertoysTurnAge(powertoysTurnStartedAt.get(sessionId) || tail?.turnStartedAt || 0) : "",
    turnRunning: Boolean(view?.turnRunning),
    turnStartedAt: tail?.turnStartedAt || 0,
    lastResponseAt: tail?.lastResponseAt || 0,
    cacheTtlMs: tail?.cacheTtlMs || 0,
    workDoneAt: tail?.workDoneAt || 0,
  };
}

// --- Terminal (CLI) sessions -------------------------------------------------------------------
/** Opens a terminal Claude Code session in the app, through the app's own resume (it imports the transcript). */
async function powertoysOpenCliSession(cliSessionId) {
  let manager = powertoysSessionManager();
  if (!manager) {
    return { ok: false, reason: "not_ready" };
  }
  let owned = [...manager.sessions.values()].find((record) => record.cliSessionId === cliSessionId || record.unarchivedCliSessionId === cliSessionId);
  if (owned) {
    return { ok: powertoysOpenSession(owned.sessionId), sessionId: owned.sessionId };
  }
  // The resume API takes the discovery's opaque handle for a transcript, not its id.
  let discovery = await manager.getCliSessionDiscovery();
  let handle = discovery.handleFor(cliSessionId);
  let result = await manager.resumeCliSession(handle);
  powertoysLog(`terminal session ${cliSessionId}: ${result.ok ? `opened as ${result.sessionId}` : `not opened (${result.reason})`}`);
  if (result.ok && result.sessionId) {
    powertoysOpenSession(result.sessionId);
  }
  return result;
}

// --- Archived sessions ---------------------------------------------------------------------------
async function powertoysArchivedSessions() {
  let manager = powertoysSessionManager();
  if (!manager) {
    return [];
  }
  await manager.ensureArchivedSessionsLoaded("renderer_request").catch(() => undefined);
  return [...manager.sessions.values()]
    .filter((record) => record.isArchived)
    .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
    .map((record) => ({
      sessionId: record.sessionId,
      title: record.title || powertoysFolderName(record) || "Untitled session",
      folder: powertoysFolderName(record),
      lastActivityAt: record.lastActivityAt ?? 0,
    }));
}
function powertoysUnarchive(sessionId) {
  let manager = powertoysSessionManager();
  if (!manager?.sessions.get(sessionId)?.isArchived) {
    return false;
  }
  manager.unarchiveSession(sessionId);
  powertoysLog(`unarchived ${sessionId}`);
  return true;
}

// --- Profiles ------------------------------------------------------------------------------------
// A profile is the app run with its own data folder (%APPDATA%\Claude-<name>), so it has its own
// sign-in, sessions and settings; --powertoys-profile=<name> selects it (index.pre). Each profile is
// its own instance, so several can run side by side.
const POWERTOYS_PROFILE_NAME = /^[\w -]{1,40}$/;
function powertoysProfiles() {
  let appData = electron.app.getPath("appData");
  let names = [];
  try {
    for (let entry of powertoysFs.readdirSync(appData, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("Claude-") && POWERTOYS_PROFILE_NAME.test(entry.name.slice(7))) {
        names.push(entry.name.slice(7));
      }
    }
  } catch {}
  return { current: process.env.POWERTOYS_PROFILE ?? "", profiles: names.sort((left, right) => left.localeCompare(right)) };
}
/** Starts the app in a profile ("" = the default one); an instance already running just comes forward. */
function powertoysLaunchProfile(name) {
  if (name !== "" && !POWERTOYS_PROFILE_NAME.test(name)) {
    throw Error("A profile name is 1-40 letters, digits, spaces, - or _");
  }
  if (name === (process.env.POWERTOYS_PROFILE ?? "")) {
    showAndFocusWindow2();
    return true;
  }
  if (name) {
    powertoysFs.mkdirSync(powertoysPath.join(electron.app.getPath("appData"), `Claude-${name}`), { recursive: true });
  }
  let child = require("node:child_process").spawn(process.execPath, name ? [`--powertoys-profile=${name}`] : [], { detached: true, stdio: "ignore" });
  child.unref();
  powertoysLog(`profile: started ${name || "default"}`);
  return true;
}

// --- Extra windows -------------------------------------------------------------------------------
// Each is wired like the main view (setupContentsHooks) so local sessions load in it, and gets the
// session manager's events (app/0324 forwards them to these too).
var powertoysCodeWindowConfigure = null; // the app's code-window setup, set in app/0350
const powertoysExtraWindows = new Set();
function powertoysExtraWebContents() {
  return [...powertoysExtraWindows].filter((window2) => !window2.isDestroyed()).map((window2) => window2.webContents);
}
function powertoysOpenWindow(routePath) {
  if (typeof routePath !== "string" || !/^\/(epitaxy|chat|project)(\/[\w%.-]+){0,2}$/.test(routePath)) {
    throw Error("bad path");
  }
  let bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : { x: 100, y: 100, width: 1200, height: 800 };
  let window2 = new electron.BrowserWindow({
    width: Math.max(800, Math.round(bounds.width * 0.75)),
    height: Math.max(600, Math.round(bounds.height * 0.85)),
    x: bounds.x + 40,
    y: bounds.y + 40,
    title: "Claude",
    backgroundColor: getWindowBackgroundColor(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: powertoysPath.join(electron.app.getAppPath(), ".vite/build/mainView.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--desktop-features=${JSON.stringify(getSupportedFeaturesSync())}`, buildDesktopManagedConfigArg()],
    },
  });
  powertoysExtraWindows.add(window2);
  window2.once("closed", () => powertoysExtraWindows.delete(window2));
  try {
    powertoysCodeWindowConfigure?.(window2);
    setupContentsHooks(window2.webContents, window2);
  } catch (caught) {
    powertoysWarn(`window: setup failed: ${caught.message}`);
  }
  window2.loadURL(new URL(routePath, claudeAiUrl()).toString()).catch(() => undefined);
  powertoysLog(`window: opened ${routePath}`);
  return true;
}

// --- Cowork --------------------------------------------------------------------------------------
function powertoysCoworkServiceDisabled() {
  try {
    return !powertoysSetting("coworkService");
  } catch {
    return false;
  }
}
