// ---------------------------------------------------------------------------------------------
// Powertoys: spellchecker languages, tray-only mode, and mods (your own CSS / JS for the page).
//
// Mods are the files in <userData>/powertoys/mods: every *.css is inserted into each Claude page
// and kept in step with the file; every *.js runs in the page's main world when it loads (a change
// to one reloads the pages, since a script can't be taken back). Files starting with "_" are off.
// ---------------------------------------------------------------------------------------------
function powertoysApplySpellchecker() {
  let enabled = powertoysSetting("spellcheck");
  let wanted = powertoysSetting("spellLanguages")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
  let sessions = new Set([electron.session.defaultSession, mainView?.webContents?.session].filter(Boolean));
  for (let session of sessions) {
    try {
      session.setSpellCheckerEnabled(enabled);
      if (enabled) {
        let available = new Set(session.availableSpellCheckerLanguages);
        let languages = wanted.filter((code) => available.size === 0 || available.has(code));
        if (languages.length) {
          session.setSpellCheckerLanguages(languages);
        }
      }
    } catch (caught) {
      powertoysWarn(`spellchecker: ${caught.message}`);
    }
  }
}
function powertoysSpellLanguagesAvailable() {
  try {
    return electron.session.defaultSession.availableSpellCheckerLanguages;
  } catch {
    return [];
  }
}

/** Tray only: no taskbar button while the tray icon is there to bring the window back. */
function powertoysApplyTrayOnly() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  let hasTray = !!trayIcon && !trayIcon.isDestroyed();
  mainWindow.setSkipTaskbar(powertoysSetting("trayOnly") && hasTray);
}

// --- Mods -------------------------------------------------------------------------------------
const POWERTOYS_MODS_README = `Powertoys mods
==============

Files here change the Claude page:
- *.css is added to every Claude page and updated as soon as you save it.
- *.js runs in the page (its main world) when it loads; saving one reloads the page.
- A file whose name starts with "_" is ignored (an easy way to switch one off).

Example: a file named wide-code.css containing
  pre { white-space: pre-wrap !important; }
`;
function powertoysModsDir() {
  let dir = powertoysFile("mods");
  if (!powertoysFs.existsSync(dir)) {
    powertoysFs.mkdirSync(dir, { recursive: true });
    powertoysFs.writeFileSync(powertoysPath.join(dir, "README.txt"), POWERTOYS_MODS_README, "utf8");
  }
  return dir;
}
function powertoysReadMods() {
  let mods = { css: [], js: [] };
  if (!powertoysSetting("mods")) {
    return mods;
  }
  let dir = powertoysModsDir();
  let names;
  try {
    names = powertoysFs.readdirSync(dir).sort();
  } catch {
    return mods;
  }
  for (let name of names) {
    if (name.startsWith("_") || !/\.(css|js)$/i.test(name)) {
      continue;
    }
    try {
      let text = powertoysFs.readFileSync(powertoysPath.join(dir, name), "utf8");
      mods[name.toLowerCase().endsWith(".css") ? "css" : "js"].push({ name, text });
    } catch (caught) {
      powertoysWarn(`mods: reading ${name} failed: ${caught.message}`);
    }
  }
  return mods;
}
const powertoysModCssKeys = new WeakMap(); // webContents -> [insertCSS keys]
async function powertoysApplyModCss(webContents, mods) {
  if (webContents.isDestroyed()) {
    return;
  }
  for (let key of powertoysModCssKeys.get(webContents) ?? []) {
    await webContents.removeInsertedCSS(key).catch(() => undefined);
  }
  let keys = [];
  for (let { name, text } of mods.css) {
    try {
      keys.push(await webContents.insertCSS(`/* powertoys mod: ${name} */\n${text}`, { cssOrigin: "author" }));
    } catch (caught) {
      powertoysWarn(`mods: ${name} could not be applied: ${caught.message}`);
    }
  }
  powertoysModCssKeys.set(webContents, keys);
}
async function powertoysRunModScripts(webContents, mods) {
  for (let { name, text } of mods.js) {
    try {
      await webContents.executeJavaScript(`(() => {\n${text}\n})();\n//# sourceURL=powertoys-mod/${encodeURIComponent(name)}`, true);
    } catch (caught) {
      powertoysWarn(`mods: ${name} failed: ${caught?.message ?? caught}`);
    }
  }
}
/** A page has (re)loaded: its CSS and scripts. Called when the page module asks for its state. */
function powertoysApplyModsToPage(webContents) {
  let mods = powertoysReadMods();
  if (mods.css.length || mods.js.length) {
    powertoysLog(`mods: ${[...mods.css, ...mods.js].map((mod) => mod.name).join(", ")}`);
  }
  powertoysApplyModCss(webContents, mods);
  powertoysRunModScripts(webContents, mods);
}
var powertoysModsWatcher = null;
var powertoysLastModScripts = "";
function powertoysWatchMods() {
  if (powertoysModsWatcher) {
    return;
  }
  let timer = null;
  try {
    powertoysLastModScripts = JSON.stringify(powertoysReadMods().js);
    powertoysModsWatcher = powertoysFs.watch(powertoysModsDir(), () => {
      clearTimeout(timer);
      timer = setTimeout(powertoysModsChanged, 300);
    });
  } catch (caught) {
    powertoysWarn(`mods: watching the folder failed: ${caught.message}`);
  }
}
function powertoysModsChanged() {
  let mods = powertoysReadMods();
  let scripts = JSON.stringify(mods.js);
  let scriptsChanged = scripts !== powertoysLastModScripts;
  powertoysLastModScripts = scripts;
  for (let webContents of powertoysPages) {
    if (webContents.isDestroyed()) {
      continue;
    }
    if (scriptsChanged) {
      webContents.reload();
    } else {
      powertoysApplyModCss(webContents, mods);
    }
  }
  powertoysLog(`mods changed${scriptsChanged ? " (scripts: pages reloaded)" : ""}`);
}

// --- "Open in" your own apps -------------------------------------------------------------------
// openin.json: [{ "name": "Typora", "command": "C:\\Program Files\\Typora\\Typora.exe", "args": ["{file}"] }].
// {file} is the file's path, {folder} its folder. The page adds "Open in <name>" to its Open-in menu.
const POWERTOYS_OPEN_IN_EXAMPLE = [{ name: "Notepad", command: "notepad.exe", args: ["{file}"] }];
function powertoysOpenInFile() {
  let file = powertoysFile("openin.json");
  if (!powertoysFs.existsSync(file)) {
    powertoysWriteJson("openin.json", POWERTOYS_OPEN_IN_EXAMPLE);
  }
  return file;
}
function powertoysOpenInApps() {
  powertoysOpenInFile();
  let list = powertoysReadJson("openin.json", []);
  return (Array.isArray(list) ? list : []).filter((app) => app && typeof app.name === "string" && typeof app.command === "string" && app.name.trim() && app.command.trim());
}
function powertoysOpenIn(name, filePath) {
  let app = powertoysOpenInApps().find((candidate) => candidate.name === name);
  if (!app) {
    throw Error(`No "Open in" app named ${name}`);
  }
  if (typeof filePath !== "string" || !powertoysPath.isAbsolute(filePath)) {
    throw Error("Not a file path");
  }
  let fill = (argument) => String(argument).replaceAll("{file}", filePath).replaceAll("{folder}", powertoysPath.dirname(filePath));
  let args = (Array.isArray(app.args) ? app.args : ["{file}"]).map(fill);
  let child = require("node:child_process").spawn(app.command, args, { detached: true, stdio: "ignore", shell: false });
  child.on("error", (caught) => powertoysWarn(`open in ${name}: ${caught.message}`));
  child.unref();
  powertoysLog(`opened ${filePath} in ${name}`);
  return true;
}

function powertoysSettingsAction(name) {
  if (name === "rebuildRestart") {
    return powertoysRestartAndContinue({ rebuild: true, source: "settings" }).then((result) => {
      if (!result.ok) {
        throw Error(result.summary);
      }
    });
  }
  if (name === "editOpenInApps") {
    return electron.shell.openPath(powertoysOpenInFile());
  }
  if (name === "openModsFolder") {
    return electron.shell.openPath(powertoysModsDir());
  }
  if (name === "openFolder") {
    return electron.shell.openPath(powertoysDir());
  }
  if (name === "resetHiddenFolders") {
    powertoysWriteJson("hidden-folders.json", []);
    powertoysEvents.emit("hiddenFolders", []);
    return true;
  }
  throw Error(`unknown action ${name}`);
}

/** Start-up and settings changes for this file. */
function powertoysStartSystem() {
  powertoysApplySpellchecker();
  powertoysApplyTrayOnly();
  powertoysWatchMods();
  powertoysEvents.on("settings", () => {
    powertoysApplySpellchecker();
    powertoysApplyTrayOnly();
  });
}
