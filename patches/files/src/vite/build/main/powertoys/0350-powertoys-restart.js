// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): rebuild, restart and continue a conversation.
//
// 1. Rebuild into a staging copy (scripts/assemble.mjs --out <repo>/app/.vite.next) and check that
//    its bundles compile. The running app keeps reading the untouched app/.vite: rebuilding in place
//    under a running app mixes old code in memory with new files on disk. A failed rebuild never
//    restarts the app: the requesting conversation gets the error instead.
// 2. Remember the conversation and the message to send it (<userData>/powertoys/continue.json).
// 3. Start scripts/swap-and-launch.mjs (detached), then quit. It waits for this process to exit,
//    swaps the staging copy into app/.vite and starts the app with the same arguments. Another
//    session still working gets the app's usual "Quit while working?" question; the session that
//    asked does not. If the quit is cancelled the helper gives up after 10 minutes.
// 4. After the restart, send the message once the session manager knows the conversation.
// 5. Every other conversation still working when the app quits is noted too (continue.json "others").
//    After the restart, each one that the app's own quit auto-resume has not set going again is sent
//    "continue". That auto-resume covers only some (at most 4, none waiting on the person, none it
//    resumed before that nobody looked at), so the rest would otherwise stay stopped.
//
// Triggers: the tab / page menus and the tray, or a request file that any process can write
// (scripts/restart-and-continue.mjs does, defaulting to the calling session's CLAUDE_CODE_HOST_SESSION_ID).
// ---------------------------------------------------------------------------------------------
const POWERTOYS_CONTINUE_FILE = "continue.json";
const POWERTOYS_RESTART_REQUEST_FILE = "restart-request.json";
const POWERTOYS_CONTINUE_MAX_AGE_MS = 15 * 60 * 1000;
const POWERTOYS_CONTINUE_OTHERS_MESSAGE = "continue";
/** How long the app's own quit auto-resume gets first (it runs a few seconds after the start). */
const POWERTOYS_CONTINUE_OTHERS_GRACE_MS = 30 * 1000;
/** Written once a restarted app is up, so the swap helper keeps the new build (else it rolls back). */
const POWERTOYS_RESTART_OK_FILE = "restart-ok";
var powertoysRestarting = false;

/** The project folder this build runs from, or null (packaged / copied builds cannot rebuild). */
function powertoysSourceRoot() {
  try {
    let appDir = powertoysFs.realpathSync(electron.app.getAppPath());
    let root = powertoysPath.dirname(appDir);
    return powertoysFs.existsSync(powertoysPath.join(root, "scripts", "assemble.mjs")) ? root : null;
  } catch {
    return null;
  }
}
/**
 * The system's Node.js. Not this app's own runtime: this Electron build ignores ELECTRON_RUN_AS_NODE,
 * so claude.exe started as "node" is a second Claude, which hands its arguments to the running one as
 * dropped files and exits 0 (2026-10-19: the build scripts landed in a prompt, the build "succeeded").
 */
function powertoysNodeExecutable() {
  for (let folder of String(process.env.PATH ?? "").split(powertoysPath.delimiter)) {
    let candidate = powertoysPath.join(folder.replace(/^"|"$/g, ""), process.platform === "win32" ? "node.exe" : "node");
    if (folder && powertoysFs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
/** Runs a Node script with the system's Node.js; resolves { code, output }. */
function powertoysRunNode(args, cwd) {
  return new Promise((resolve) => {
    let node = powertoysNodeExecutable();
    if (!node) {
      resolve({ code: -1, output: "Node.js was not found on PATH; it is needed to rebuild." });
      return;
    }
    let env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let child = require("node:child_process").spawn(node, args, { cwd, env, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (caught) => resolve({ code: -1, output: `${output}\n${caught.message}` }));
    child.on("close", (code) => resolve({ code, output }));
  });
}
async function powertoysRebuild() {
  let root = powertoysSourceRoot();
  if (!root) {
    return { ok: false, summary: "This build does not run from its project folder, so it cannot rebuild itself." };
  }
  let started = Date.now();
  let staged = powertoysPath.join(root, "app", ".vite.next");
  powertoysFs.rmSync(staged, { recursive: true, force: true });
  let assemble = await powertoysRunNode([powertoysPath.join(root, "scripts", "assemble.mjs"), "--out", staged], root);
  // Judged by what the scripts print, not only their exit code.
  if (assemble.code !== 0 || !/^assembled \d+ files/m.test(assemble.output) || !powertoysFs.existsSync(powertoysPath.join(staged, "build", "main.js"))) {
    powertoysFs.rmSync(staged, { recursive: true, force: true });
    return { ok: false, summary: `assemble.mjs failed (exit ${assemble.code}):\n${assemble.output.trim().slice(-1500)}` };
  }
  let check = await powertoysRunNode([powertoysPath.join(root, "scripts", "check-syntax.mjs"), staged], root);
  if (check.code !== 0 || !/all bundles compile/.test(check.output)) {
    powertoysFs.rmSync(staged, { recursive: true, force: true });
    return { ok: false, summary: `The new build does not compile:\n${check.output.trim().slice(-1500)}` };
  }
  return { ok: true, staged, root, summary: `rebuilt in ${Math.round((Date.now() - started) / 1000)} s` };
}
/**
 * Quits and starts again; with a staged build, the swap helper starts the app after moving it in.
 * Only sessions other than `requesterId` that are still working make the app ask first, unless `ask`
 * is false (a restart a session requested: those sessions are continued afterwards anyway).
 */
function powertoysRelaunch(requesterId, build, ask = true) {
  let relaunch = () => {
    powertoysNoteWorkingSessions(requesterId);
    if (build?.staged) {
      let helperEnv = { ...process.env };
      delete helperEnv.ELECTRON_RUN_AS_NODE;
      let helper = require("node:child_process").spawn(
        powertoysNodeExecutable(),
        [
          powertoysPath.join(build.root, "scripts", "swap-and-launch.mjs"),
          "--wait-pid",
          String(process.pid),
          "--staged",
          build.staged,
          "--target",
          powertoysPath.join(build.root, "app", ".vite"),
          "--exe",
          process.execPath,
          "--args",
          JSON.stringify(powertoysRelaunchArgs()),
          "--log",
          powertoysFile("restart.log"),
          "--continue-file",
          powertoysFile(POWERTOYS_CONTINUE_FILE),
          "--ok-file",
          powertoysFile(POWERTOYS_RESTART_OK_FILE),
        ],
        { cwd: build.root, env: helperEnv, detached: true, stdio: "ignore", windowsHide: true },
      );
      helper.unref();
      powertoysLog(`restart: swap helper started (pid ${helper.pid})`);
    } else {
      electron.app.relaunch({ args: [...powertoysRelaunchArgs(), "--powertoys-restarted"] });
    }
    quitAppBypassingSessionGuard();
  };
  let others = listRunningLocalSessions(localSessionActivitySources).filter((session) => session.sessionId !== requesterId);
  if (others.length === 0) {
    relaunch();
  } else if (!ask) {
    powertoysLog(`restart: ${others.length} other session(s) still working; not asking (requested without asking), they continue afterwards`);
    relaunch();
  } else {
    powertoysLog(`restart: ${others.length} other session(s) still working, asking first`);
    relaunchWithSessionGuard(relaunch);
  }
}
/**
 * sessionId: the conversation to continue after the restart (optional); message: what to send it.
 * Resolves { ok, summary } when the rebuild fails (the app keeps running); otherwise the app restarts.
 */
async function powertoysRestartAndContinue({ sessionId = null, message = "", rebuild = true, ask = true, source = "menu" } = {}) {
  if (powertoysRestarting) {
    throw Error("A restart is already in progress");
  }
  if (sessionId !== null && (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId))) {
    throw Error("bad session id");
  }
  powertoysRestarting = true;
  try {
    powertoysLog(`restart requested (${source})${sessionId ? ` to continue ${sessionId}` : ""}${rebuild ? ", rebuilding first" : ""}`);
    let build = rebuild ? await powertoysRebuild() : { ok: true, summary: "not rebuilt" };
    if (!build.ok) {
      powertoysWarn(`restart cancelled: ${build.summary}`);
      if (sessionId) {
        await powertoysSendToSession(sessionId, `The Claude Desktop rebuild failed, so it was not restarted.\n\n${build.summary}`);
      }
      return build;
    }
    if (sessionId) {
      powertoysWriteJson(POWERTOYS_CONTINUE_FILE, {
        sessionId,
        message: String(message || "").trim() || `Claude Desktop was ${rebuild ? "rebuilt and " : ""}restarted. Continue where you left off.`,
        build: build.summary,
        at: Date.now(),
      });
    }
    powertoysLog(`restarting (${build.summary})`);
    await powertoysSaveRestartLayout().catch((caught) => powertoysWarn(`restart: keeping the splits failed: ${caught.message}`));
    powertoysRelaunch(sessionId, build, ask);
    return { ok: true, summary: build.summary };
  } finally {
    // The app is quitting on success; on a cancelled quit (the user kept a working session) allow another try.
    setTimeout(() => (powertoysRestarting = false), 5000).unref();
  }
}
async function powertoysSendToSession(sessionId, text) {
  let manager = powertoysSessionManager();
  if (!manager?.sessions.has(sessionId)) {
    powertoysWarn(`continue: session ${sessionId} not found`);
    return false;
  }
  // This message is what continues it: without its quit marker, the wake this send causes does not also
  // send the app's own "The app was quit while you were working" prompt (seen arriving next to it).
  let record = manager.sessions.get(sessionId);
  record.interruptedByQuitAt = undefined;
  record.interruptedUnseenResume = undefined;
  record.interruptedAwaitingPerson = undefined;
  let result = await manager.sendMessage(sessionId, text).catch((caught) => ({ delivered: false, reason: caught.message }));
  if (result?.delivered === false) {
    powertoysWarn(`continue: message to ${sessionId} not delivered: ${result.reason}`);
    return false;
  }
  powertoysLog(`continue: sent the message to ${sessionId}`);
  return true;
}
/** Adds the conversations other than `requesterId` that are still working to continue.json. */
function powertoysNoteWorkingSessions(requesterId) {
  let others = [];
  try {
    others = [...new Set((powertoysSessionManager()?.listRunningSessions() ?? []).map((session) => session.sessionId))].filter(
      (sessionId) => typeof sessionId === "string" && sessionId !== requesterId,
    );
  } catch (caught) {
    powertoysWarn(`restart: listing the working conversations failed: ${caught.message}`);
  }
  if (others.length === 0) {
    return;
  }
  let pending = powertoysReadJson(POWERTOYS_CONTINUE_FILE, null);
  powertoysWriteJson(POWERTOYS_CONTINUE_FILE, {
    ...(pending && typeof pending === "object" ? pending : { sessionId: null, message: "" }),
    others,
    at: Date.now(),
  });
  powertoysLog(`restart: ${others.length} other working conversation(s) to continue afterwards: ${others.join(", ")}`);
}
/** After a restart: "continue" to each noted conversation the app did not resume by itself. */
async function powertoysContinueOthers(others) {
  let manager;
  for (let waited = 0; waited < 120000 && !(manager = powertoysSessionManager()); waited += 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!manager) {
    powertoysWarn("continue: the session manager never came up; the other conversations were not continued");
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, POWERTOYS_CONTINUE_OTHERS_GRACE_MS));
  let working = new Set(manager.listRunningSessions().map((session) => session.sessionId));
  for (let sessionId of others) {
    let record = manager.sessions.get(sessionId);
    if (!record || record.isArchived) {
      powertoysLog(`continue: ${sessionId} is ${record ? "archived" : "gone"}, not continued`);
    } else if (working.has(sessionId) || record.isRunning || record.pendingCycle !== undefined) {
      powertoysLog(`continue: ${sessionId} is already working again`);
    } else {
      await powertoysSendToSession(sessionId, POWERTOYS_CONTINUE_OTHERS_MESSAGE);
    }
  }
}
/** After a restart: send the remembered message once the conversation is known (up to two minutes). */
/** This run's arguments without the restart marker, for starting the next one. */
function powertoysRelaunchArgs() {
  return process.argv.slice(1).filter((argument) => argument !== "--powertoys-restarted");
}
async function powertoysContinueAfterRestart() {
  // Only a start made by the restart itself continues a conversation (the swap helper sets the
  // variable, a plain relaunch passes the flag); a continue.json left by a cancelled quit is dropped.
  // A start Windows made while the helper was starting the app (a notification pressed meanwhile) wins
  // the single-instance lock instead; the helper's marker file says that start is the restart too.
  let pendingFile = powertoysFile(`${POWERTOYS_RESTART_OK_FILE}.pending`);
  let pendingAt = Number(powertoysReadJson(`${POWERTOYS_RESTART_OK_FILE}.pending`, 0));
  let restarted =
    process.env.POWERTOYS_RESTARTED === "1" ||
    process.argv.includes("--powertoys-restarted") ||
    (pendingAt > 0 && Date.now() - pendingAt < 2 * 60 * 1000);
  delete process.env.POWERTOYS_RESTARTED;
  try {
    powertoysFs.rmSync(pendingFile, { force: true });
  } catch {}
  if (restarted) {
    try {
      powertoysFs.writeFileSync(powertoysFile(POWERTOYS_RESTART_OK_FILE), String(process.pid));
    } catch (caught) {
      powertoysWarn(`could not report a good start to the swap helper: ${caught.message}`);
    }
  }
  if (!restarted) {
    try {
      powertoysFs.rmSync(powertoysFile(POWERTOYS_CONTINUE_FILE), { force: true });
    } catch {}
    return;
  }
  powertoysRestoreRestartLayout().catch((caught) => powertoysWarn(`restart: reopening the splits failed: ${caught.message}`));
  let pending = powertoysReadJson(POWERTOYS_CONTINUE_FILE, null);
  if (!pending) {
    return;
  }
  // Removed first, so a failure can never resend it on every start.
  try {
    powertoysFs.rmSync(powertoysFile(POWERTOYS_CONTINUE_FILE), { force: true });
  } catch {}
  let others = Array.isArray(pending.others) ? pending.others.filter((sessionId) => typeof sessionId === "string") : [];
  if ((typeof pending.sessionId !== "string" && others.length === 0) || !(Date.now() - pending.at < POWERTOYS_CONTINUE_MAX_AGE_MS)) {
    powertoysWarn("continue: ignoring a stale or malformed continue.json");
    return;
  }
  if (others.length > 0) {
    powertoysContinueOthers(others).catch((caught) => powertoysWarn(`continue: the other conversations failed: ${caught.message}`));
  }
  if (typeof pending.sessionId !== "string") {
    return;
  }
  for (let waited = 0; waited < 120000; waited += 1000) {
    if (powertoysSessionManager()?.sessions.has(pending.sessionId)) {
      // Give the page a moment to come up, so the reply is seen arriving.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await powertoysSendToSession(pending.sessionId, String(pending.message));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  powertoysWarn(`continue: session ${pending.sessionId} never appeared`);
}
/** Request file: { sessionId?, message?, rebuild?, ask? }, written by scripts/restart-and-continue.mjs. */
function powertoysTakeRestartRequest() {
  let file = powertoysFile(POWERTOYS_RESTART_REQUEST_FILE);
  if (!powertoysFs.existsSync(file)) {
    return;
  }
  let request = powertoysReadJson(POWERTOYS_RESTART_REQUEST_FILE, null);
  try {
    powertoysFs.rmSync(file, { force: true });
  } catch {}
  if (!request || typeof request !== "object") {
    powertoysWarn("restart request: unreadable, ignored");
    return;
  }
  powertoysRestartAndContinue({
    sessionId: typeof request.sessionId === "string" && request.sessionId ? request.sessionId : null,
    message: typeof request.message === "string" ? request.message : "",
    rebuild: request.rebuild !== false,
    ask: request.ask !== false,
    source: "request file",
  }).catch((caught) => powertoysWarn(`restart request failed: ${caught.message}`));
}
// Command requests (scripts/powertoys-command.mjs, Slack Powertoys): { id, command, sessionId | cliSessionId, … },
// answered in command-result.json as { id, ok, result | error }. For what another program or a session asks the app
// to do (a page action, by name).
const POWERTOYS_COMMAND_REQUEST_FILE = "command-request.json";
const POWERTOYS_COMMANDS = {
  addTaskList: (request) => powertoysAddTaskList(String(request.sessionId ?? "")),
  queuePrompt: (request) => powertoysQueuePromptFromRequest(request),
};
function powertoysTakeCommandRequest() {
  let file = powertoysFile(POWERTOYS_COMMAND_REQUEST_FILE);
  if (!powertoysFs.existsSync(file)) {
    return;
  }
  let request = powertoysReadJson(POWERTOYS_COMMAND_REQUEST_FILE, null);
  try {
    powertoysFs.rmSync(file, { force: true });
  } catch {}
  let answer = (outcome) => powertoysWriteJson("command-result.json", { id: request?.id ?? null, ...outcome });
  let run = request && POWERTOYS_COMMANDS[request.command];
  if (!run) {
    powertoysWarn(`command request: unknown command ${request?.command}`);
    answer({ ok: false, error: `Unknown command ${request?.command}` });
    return;
  }
  powertoysLog(`command request: ${request.command} ${request.sessionId ?? ""}`);
  Promise.resolve()
    .then(() => run(request))
    .then(
      (result) => answer({ ok: true, result: result ?? null }),
      (caught) => answer({ ok: false, error: caught.message }),
    );
}
function powertoysWatchRestartRequests() {
  try {
    powertoysFs.mkdirSync(powertoysDir(), { recursive: true });
    let timer = null;
    powertoysFs.watch(powertoysDir(), (eventType, fileName) => {
      if (fileName === POWERTOYS_RESTART_REQUEST_FILE) {
        clearTimeout(timer);
        timer = setTimeout(powertoysTakeRestartRequest, 300);
      } else if (fileName === POWERTOYS_COMMAND_REQUEST_FILE) {
        setTimeout(powertoysTakeCommandRequest, 300);
      }
    });
    // A request written while the app was closed is not acted on: it would restart a fresh start.
    powertoysFs.rmSync(powertoysFile(POWERTOYS_RESTART_REQUEST_FILE), { force: true });
  } catch (caught) {
    powertoysWarn(`watching for restart requests failed: ${caught.message}`);
  }
}

try {
  powertoysHandle("restartAndContinue", (event, sessionId, message) =>
    powertoysRestartAndContinue({ sessionId: sessionId ?? null, message: message ?? "", rebuild: true, source: "page" }),
  );
} catch (caught) {
  logger.error("[powertoys] registering the restart IPC failed: %o", caught);
}
