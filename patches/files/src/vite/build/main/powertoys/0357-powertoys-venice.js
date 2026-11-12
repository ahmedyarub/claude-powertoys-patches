// ---------------------------------------------------------------------------------------------
// Powertoys: Venice AI sessions.
//
// Starts Claude Code in a Windows Terminal tab with its model requests going to Venice AI instead
// of the subscription. Venice only speaks the OpenAI chat format, so a local LiteLLM proxy on
// 127.0.0.1 translates Claude Code's Anthropic Messages requests. Only Venice's uncensored models
// that take tools are served, so a session can't reach Venice's Claude or other models. The proxy
// holds the Venice key (the user's VENICE_API_KEY environment variable); Claude Code gets the proxy
// and its own key through a settings file passed with --settings, so the app's sessions and a plain
// `claude` stay on the subscription. Reached from the "V" button beside the sidebar's settings button, the
// tray menu and the Powertoys menu.
// ---------------------------------------------------------------------------------------------
const POWERTOYS_VENICE_API = "https://api.venice.ai/api/v1";
let powertoysVeniceProxy = null; // the LiteLLM child process this app started
let powertoysVeniceStarting = null; // the promise of a start in progress

function powertoysVeniceDir() {
  let dir = powertoysPath.join(powertoysDir(), "venice");
  powertoysFs.mkdirSync(dir, { recursive: true });
  return dir;
}
function powertoysVeniceBaseUrl() {
  return `http://127.0.0.1:${powertoysSetting("veniceProxyPort")}`;
}

/** The saved user variable, not this process's environment: the app may have started before `setx`. */
function powertoysVeniceApiKey() {
  try {
    let output = require("node:child_process").execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", "VENICE_API_KEY"], { encoding: "utf8", windowsHide: true });
    let match = output.match(/VENICE_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(.*)/);
    return match?.[1].trim() || null;
  } catch {
    return null;
  }
}

/** The key Claude Code presents to the local proxy (generated once), so other programs can't spend the Venice key through it. */
function powertoysVeniceProxyKey() {
  let file = powertoysPath.join(powertoysVeniceDir(), "proxy-key.txt");
  try {
    let key = powertoysFs.readFileSync(file, "utf8").trim();
    if (key) {
      return key;
    }
  } catch {}
  let key = `sk-${powertoysCrypto.randomBytes(24).toString("hex")}`;
  powertoysFs.writeFileSync(file, key);
  return key;
}

async function powertoysVeniceProxyUp() {
  try {
    let response = await fetch(`${powertoysVeniceBaseUrl()}/health/liveliness`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Venice's uncensored text models that take tools, which Claude Code needs; the list is public. */
async function powertoysVeniceModels() {
  let response = await fetch(`${POWERTOYS_VENICE_API}/models?type=text`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw Error(`Venice's model list failed (HTTP ${response.status})`);
  }
  let { data } = await response.json();
  return data
    .filter((model) => /uncensored/i.test(model.id) && model.model_spec?.capabilities?.supportsFunctionCalling)
    .map((model) => model.id);
}

function powertoysVeniceProxyConfig(models) {
  let lines = ["model_list:"];
  for (let id of models) {
    lines.push(
      `  - model_name: "${id}"`,
      "    litellm_params:",
      `      model: "openai/${id}"`,
      `      api_base: "${POWERTOYS_VENICE_API}"`,
      "      api_key: os.environ/VENICE_API_KEY",
      // Venice adds its own system prompt unless told not to; Claude Code brings its own.
      "      extra_body:",
      "        venice_parameters:",
      "          include_venice_system_prompt: false",
    );
  }
  lines.push("litellm_settings:", "  drop_params: true", "general_settings:", "  master_key: os.environ/LITELLM_MASTER_KEY", "");
  return lines.join("\n");
}

async function powertoysVeniceEnsureProxy(veniceKey) {
  if ((powertoysVeniceProxy && powertoysVeniceProxy.exitCode === null) || (await powertoysVeniceProxyUp())) {
    return;
  }
  let dir = powertoysVeniceDir();
  let config = powertoysPath.join(dir, "litellm.yaml");
  let models = await powertoysVeniceModels();
  if (models.length === 0) {
    throw Error("Venice lists no uncensored models that take tools");
  }
  powertoysFs.writeFileSync(config, powertoysVeniceProxyConfig(models));
  let logFd = powertoysFs.openSync(powertoysPath.join(dir, "proxy.log"), "w");
  let child = require("node:child_process").spawn(
    powertoysSetting("veniceLiteLlmPath") || "litellm",
    ["--config", config, "--host", "127.0.0.1", "--port", String(powertoysSetting("veniceProxyPort"))],
    {
      cwd: dir,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: {
        ...process.env,
        VENICE_API_KEY: veniceKey,
        LITELLM_MASTER_KEY: powertoysVeniceProxyKey(),
        // LiteLLM's start-up banner crashes on a non-UTF-8 console encoding.
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    },
  );
  powertoysFs.closeSync(logFd);
  child.on("error", (caught) => powertoysWarn(`venice: the proxy didn't start (${caught.message}); is LiteLLM installed (pip install "litellm[proxy]")?`));
  child.on("exit", (code) => {
    powertoysLog(`venice: proxy exited (${code}); log: ${powertoysPath.join(dir, "proxy.log")}`);
    if (powertoysVeniceProxy === child) {
      powertoysVeniceProxy = null;
    }
  });
  powertoysVeniceProxy = child;
  powertoysLog(`venice: proxy started on ${powertoysVeniceBaseUrl()} (pid ${child.pid}, ${models.length} models)`);
}

function powertoysVeniceStopProxy() {
  let child = powertoysVeniceProxy;
  powertoysVeniceProxy = null;
  if (child && child.exitCode === null) {
    // litellm.exe is a launcher with Python under it: end the whole tree.
    require("node:child_process").spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    powertoysLog("venice: proxy stopped");
  }
}
electron.app.on("will-quit", powertoysVeniceStopProxy);

function powertoysVeniceClaudeSettings() {
  let model = powertoysSetting("veniceModel");
  let file = powertoysPath.join(powertoysVeniceDir(), "claude-settings.json");
  let env = {
    ANTHROPIC_BASE_URL: powertoysVeniceBaseUrl(),
    ANTHROPIC_AUTH_TOKEN: powertoysVeniceProxyKey(),
    // A user-level Anthropic key would also be sent, in x-api-key, and clash with the proxy key.
    ANTHROPIC_API_KEY: "",
    // Lists the proxy's Venice models in /model.
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Subagents and background work (titles, summaries) ask for these tiers; the proxy serves no Claude models.
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    // Pre-release request fields that the OpenAI translation can't carry.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
  powertoysFs.writeFileSync(file, JSON.stringify({ env }, null, 2));
  return file;
}

function powertoysVeniceOpenTerminal(folder) {
  let quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  let settingsFile = powertoysVeniceClaudeSettings();
  let log = powertoysPath.join(powertoysVeniceDir(), "proxy.log");
  let script = [
    "$Host.UI.RawUI.WindowTitle = 'Claude Code (Venice)'",
    "Write-Host 'Waiting for the Venice proxy' -NoNewline",
    "for ($i = 0; $i -lt 90; $i++) {",
    `  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ${quote(`${powertoysVeniceBaseUrl()}/health/liveliness`)} | Out-Null; break }`,
    "  catch { Write-Host '.' -NoNewline; Start-Sleep 1 }",
    "}",
    "Write-Host ''",
    `if ($i -eq 90) { Write-Host ${quote(`The proxy didn't start. Its log: ${log}`)} -ForegroundColor Red }`,
    // A terminal that inherited a Claude session's variables (its base URL, sign-in, child-session
    // marker) would beat the settings file and go to the subscription.
    "Get-ChildItem Env: | Where-Object Name -match '^(CLAUDE|ANTHROPIC)' | Remove-Item",
    `claude --settings ${quote(settingsFile)} --model ${quote(powertoysSetting("veniceModel"))}`,
  ].join("\n");
  let encoded = Buffer.from(script, "utf16le").toString("base64");
  let child = require("node:child_process").spawn(
    "wt.exe",
    ["-d", folder, "--title", "Claude Code (Venice)", "powershell.exe", "-NoLogo", "-NoExit", "-EncodedCommand", encoded],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", (caught) => powertoysWarn(`venice: Windows Terminal didn't start: ${caught.message}`));
  child.unref();
}

/** Opens a terminal tab running Claude Code on Venice in `folder` (the home folder when empty). */
async function powertoysVeniceStart(folder) {
  let veniceKey = powertoysVeniceApiKey();
  if (!veniceKey) {
    throw Error("Set your Venice API key first: setx VENICE_API_KEY <key>");
  }
  folder = typeof folder === "string" && folder !== "" ? folder : powertoysOs.homedir();
  if (!powertoysFs.existsSync(folder) || !powertoysFs.statSync(folder).isDirectory()) {
    throw Error(`Not a folder: ${folder}`);
  }
  powertoysLog(`venice: new session in ${folder}`);
  // The terminal opens right away and waits for the proxy, which takes several seconds to start.
  powertoysVeniceStarting ??= powertoysVeniceEnsureProxy(veniceKey)
    .catch((caught) => powertoysWarn(`venice: ${caught.message}`))
    .finally(() => (powertoysVeniceStarting = null));
  powertoysVeniceOpenTerminal(folder);
  return true;
}

/** The folder a local session works in, or null. */
function powertoysVeniceSessionFolder(sessionId) {
  let view = sessionId ? powertoysSessionViews.get(sessionId) : null;
  if (!view || view.isScratchWorkspace || view.remoteTarget || view.sshConfig) {
    return null;
  }
  let folder = (view.originCwd || view.cwd || "").replace(/[\\/]+$/, "");
  return folder && powertoysFs.existsSync(folder) ? folder : null;
}

/** The folders to offer: the given session's first, then recent ones. */
function powertoysVeniceFolders(sessionId) {
  let current = powertoysVeniceSessionFolder(sessionId);
  let recent = powertoysRecentFolders(12).filter((folder) => folder.toLowerCase() !== current?.toLowerCase());
  return { current, recent, proxyRunning: !!powertoysVeniceProxy && powertoysVeniceProxy.exitCode === null };
}

/** Menu items for the tray and the Powertoys menu. */
function powertoysVeniceMenuItems() {
  let start = (folder) => () => powertoysVeniceStart(folder).catch((caught) => {
    powertoysWarn(`venice: ${caught.message}`);
    electron.dialog.showMessageBox({ type: "info", title: "Venice AI", message: caught.message });
  });
  let { recent, proxyRunning } = powertoysVeniceFolders(null);
  return [
    ...recent.map((folder) => ({ label: powertoysPath.basename(folder).replace(/&/g, "&&"), sublabel: folder, toolTip: folder, click: start(folder) })),
    { label: "Home folder", click: start(null) },
    { type: "separator" },
    { label: "Stop Venice proxy", enabled: proxyRunning, click: powertoysVeniceStopProxy },
  ];
}

try {
  powertoysHandle("veniceFolders", (event, sessionId) => powertoysVeniceFolders(typeof sessionId === "string" ? sessionId : null));
  powertoysHandle("veniceStart", (event, folder) => powertoysVeniceStart(folder));
  powertoysHandle("veniceStopProxy", () => (powertoysVeniceStopProxy(), true));
} catch (caught) {
  logger.error("[powertoys] registering the Venice IPC failed: %o", caught);
}
