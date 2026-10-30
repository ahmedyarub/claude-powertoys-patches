// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): usage and cost, opening a session's files in IntelliJ, exporting a
// conversation as HTML or PDF, archiving old scratch sessions, the "while you were away" summary,
// the quick-send window, and the Network Service watchdog.
// ---------------------------------------------------------------------------------------------

// --- Usage and cost ------------------------------------------------------------------------------
/**
 * API list prices in USD per million tokens (claude-api reference, cached 2026-10-06): input,
 * output, cache read. Cache writes cost 1.25× input (5-minute) or 2× input (1-hour). On a
 * subscription these are API-equivalent estimates, not what is billed. First match wins.
 */
const POWERTOYS_MODEL_PRICES = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-(5|4-[5-9])/, 5, 25, 0.5],
  [/opus/, 15, 75, 1.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku-5/, 0.1, 0.5, 0.01],
  [/haiku/, 1, 5, 0.1],
];
function powertoysModelCost(model, tokens) {
  let price = POWERTOYS_MODEL_PRICES.find(([pattern]) => pattern.test(model));
  if (!price) {
    return 0;
  }
  let [, input, output, cacheRead] = price;
  return (
    (tokens.input * input + tokens.output * output + tokens.cacheRead * cacheRead + tokens.cacheWrite5m * input * 1.25 + tokens.cacheWrite1h * input * 2) /
    1e6
  );
}
function powertoysSumUsage(byDay, onlyDay = null) {
  let total = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: new Set() };
  for (let [day, models] of Object.entries(byDay ?? {})) {
    if (onlyDay && day !== onlyDay) {
      continue;
    }
    for (let [model, tokens] of Object.entries(models)) {
      total.cost += powertoysModelCost(model, tokens);
      total.input += tokens.input;
      total.output += tokens.output;
      total.cacheRead += tokens.cacheRead;
      total.cacheWrite += tokens.cacheWrite5m + tokens.cacheWrite1h;
      total.models.add(model);
    }
  }
  return { ...total, models: [...total.models] };
}
function powertoysLocalCliIds() {
  let ids = {};
  for (let record of powertoysSessionManager()?.sessions.values() ?? []) {
    let cliSessionId = record.cliSessionId ?? record.unarchivedCliSessionId;
    if (cliSessionId) {
      ids[record.sessionId] = { cliSessionId, record };
    }
  }
  return ids;
}
/** Usage of the given sessions (local ones; others are omitted) and today's total over every local session active today. */
async function powertoysUsage(sessionIds) {
  let local = powertoysLocalCliIds();
  let today = new Date().toLocaleDateString("sv");
  let startOfDay = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  let wanted = new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => local[id]));
  for (let [sessionId, { record }] of Object.entries(local)) {
    if ((record.lastActivityAt ?? 0) >= startOfDay) {
      wanted.add(sessionId);
    }
  }
  let stats = await powertoysTranscripts("stats", { cliSessionIds: [...wanted].map((id) => local[id].cliSessionId) });
  let sessions = {};
  let todayTotal = { cost: 0, output: 0 };
  for (let sessionId of wanted) {
    let byDay = stats[local[sessionId].cliSessionId]?.byDay;
    if (!byDay) {
      continue;
    }
    let all = powertoysSumUsage(byDay);
    let day = powertoysSumUsage(byDay, today);
    sessions[sessionId] = { total: all, today: day };
    todayTotal.cost += day.cost;
    todayTotal.output += day.output;
  }
  return { sessions, today: todayTotal };
}

// --- Open a session's edited files in IntelliJ IDEA ----------------------------------------------
function powertoysIdeaCommand() {
  let configured = powertoysSetting("ideaCommand");
  if (configured && powertoysFs.existsSync(configured)) {
    return configured;
  }
  let localAppData = process.env.LOCALAPPDATA ?? "";
  let candidates = [
    powertoysPath.join(localAppData, "JetBrains", "Toolbox", "scripts", "idea.cmd"),
    powertoysPath.join(localAppData, "Programs", "IntelliJ IDEA", "bin", "idea64.exe"),
  ];
  try {
    let jetBrains = "C:\\Program Files\\JetBrains";
    for (let name of powertoysFs.readdirSync(jetBrains).filter((entry) => /^IntelliJ IDEA/i.test(entry)).sort().reverse()) {
      candidates.push(powertoysPath.join(jetBrains, name, "bin", "idea64.exe"));
    }
  } catch {}
  return candidates.find((candidate) => powertoysFs.existsSync(candidate)) ?? null;
}
/** The files the session edited (from its transcript) that still exist, newest first. */
async function powertoysSessionEditedFiles(sessionId) {
  let cliSessionId = powertoysLocalCliIds()[sessionId]?.cliSessionId;
  if (!cliSessionId) {
    throw Error("Only sessions on this computer keep their edits in a transcript here");
  }
  let stats = await powertoysTranscripts("stats", { cliSessionIds: [cliSessionId] });
  return (stats[cliSessionId]?.files ?? []).map((file) => file.path).filter((file) => powertoysFs.existsSync(file));
}
async function powertoysOpenEditedFilesInIdea(sessionId) {
  let command = powertoysIdeaCommand();
  if (!command) {
    throw Error("IntelliJ IDEA was not found (set its path in Powertoys settings)");
  }
  let files = (await powertoysSessionEditedFiles(sessionId)).slice(0, 30);
  if (files.length === 0) {
    return 0;
  }
  let { spawn } = require("node:child_process");
  let child = command.toLowerCase().endsWith(".cmd")
    ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command, ...files], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(command, files, { detached: true, stdio: "ignore" });
  child.on("error", (caught) => powertoysWarn(`opening files in IntelliJ failed: ${caught.message}`));
  child.unref();
  powertoysLog(`opened ${files.length} edited file(s) of ${sessionId} in IntelliJ`);
  return files.length;
}

// --- Export as HTML / PDF --------------------------------------------------------------------------
function powertoysEscapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}
function powertoysInlineMarkdown(text) {
  let codes = [];
  let html = powertoysEscapeHtml(text).replace(/`([^`]+)`/g, (match, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  html = html
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return html.replace(/\u0000(\d+)\u0000/g, (match, index) => `<code>${codes[Number(index)]}</code>`);
}
/** Markdown to HTML for exports: headings, fenced code, lists, tables, quotes, rules, links, emphasis. */
function powertoysMarkdownToHtml(markdown) {
  let lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  let out = [];
  let paragraph = [];
  let flush = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(powertoysInlineMarkdown).join("<br>")}</p>`);
      paragraph = [];
    }
  };
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    let fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      let code = [];
      while (++index < lines.length && !lines[index].trim().startsWith(fence[1])) {
        code.push(lines[index]);
      }
      out.push(`<pre><code${fence[2] ? ` class="language-${fence[2]}"` : ""}>${powertoysEscapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    let heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${powertoysInlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1] ?? "")) {
      flush();
      let cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => powertoysInlineMarkdown(cell.trim()));
      let rows = [`<tr>${cells(line).map((cell) => `<th>${cell}</th>`).join("")}</tr>`];
      index++;
      while (index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index + 1])) {
        rows.push(`<tr>${cells(lines[++index]).map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
      }
      out.push(`<table>${rows.join("")}</table>`);
      continue;
    }
    let item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      let ordered = /\d/.test(item[2]);
      let items = [item[3]];
      while (index + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index + 1])) {
        items.push(lines[++index].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((text) => `<li>${powertoysInlineMarkdown(text)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    let quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      out.push(`<blockquote>${powertoysInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return out.join("\n");
}
function powertoysConversationHtml(markdown, title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${powertoysEscapeHtml(title)}</title><style>
  body { font: 14px/1.55 "Segoe UI", system-ui, sans-serif; max-width: 860px; margin: 32px auto; padding: 0 24px; color: #1f1e1d; background: #fff; }
  h1 { font-size: 22px; } h2 { font-size: 15px; margin-top: 28px; padding-top: 12px; border-top: 1px solid #e5e2da; color: #8a5a44; }
  pre { background: #f6f5f1; padding: 10px 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  code { font: 12.5px Consolas, "Cascadia Mono", monospace; background: #f6f5f1; padding: 1px 4px; border-radius: 4px; } pre code { padding: 0; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ddd; padding: 4px 8px; text-align: left; vertical-align: top; }
  blockquote { margin: 0; padding-left: 12px; border-left: 3px solid #ddd; color: #555; }
</style></head><body>
${powertoysMarkdownToHtml(markdown)}
</body></html>`;
}
async function powertoysExportAs(event, sessionId, format, fallbackMarkdown, fallbackTitle) {
  let local = powertoysLocalRecord(sessionId);
  let title = local?.title || fallbackTitle || "Conversation";
  let markdown = local?.cliSessionId ? await powertoysTranscripts("markdown", { cliSessionId: local.cliSessionId, title }) : null;
  markdown ??= typeof fallbackMarkdown === "string" && fallbackMarkdown !== "" ? fallbackMarkdown : null;
  if (!markdown) {
    return null;
  }
  let extension = { markdown: "md", html: "html", pdf: "pdf" }[format];
  if (!extension) {
    throw Error(`unknown format ${format}`);
  }
  let { canceled, filePath } = await electron.dialog.showSaveDialog(electron.BrowserWindow.fromWebContents(event.sender) ?? mainWindow, {
    title: "Export conversation",
    defaultPath: powertoysPath.join(electron.app.getPath("documents"), `${powertoysSafeFileName(title)}.${extension}`),
    filters: [{ name: { md: "Markdown", html: "Web page", pdf: "PDF" }[extension], extensions: [extension] }],
  });
  if (canceled || !filePath) {
    return null;
  }
  if (format === "markdown") {
    await powertoysFs.promises.writeFile(filePath, markdown, "utf8");
  } else if (format === "html") {
    await powertoysFs.promises.writeFile(filePath, powertoysConversationHtml(markdown, title), "utf8");
  } else {
    let html = powertoysConversationHtml(markdown, title);
    let window = new electron.BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
    try {
      // Loaded from a temporary file: a data: URL that large is slow and capped.
      let temporary = powertoysPath.join(electron.app.getPath("temp"), `powertoys-export-${process.pid}-${Date.now()}.html`);
      await powertoysFs.promises.writeFile(temporary, html, "utf8");
      try {
        await window.loadFile(temporary);
        let pdf = await window.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { marginType: "default" } });
        await powertoysFs.promises.writeFile(filePath, pdf);
      } finally {
        powertoysFs.promises.rm(temporary, { force: true }).catch(() => undefined);
      }
    } finally {
      window.destroy();
    }
  }
  powertoysLog(`exported '${title}' as ${format} to ${filePath}`);
  return filePath;
}

// --- Archive old scratch sessions ------------------------------------------------------------------
function powertoysIsScratchSession(record) {
  return record.isScratchWorkspace === true || (typeof record.cwd === "string" && /[\\/]scratch-workspaces[\\/]/i.test(record.cwd));
}
async function powertoysArchiveOldScratchSessions() {
  let archived = await powertoysArchiveIdleSessions(powertoysSetting("scratchArchiveDays"), powertoysIsScratchSession, "scratch");
  // Every other project's finished sessions too, when that setting is on: not starred ones, scheduled
  // tasks' or ones waiting for you (an approval, a question) or with a reply not read yet.
  archived += await powertoysArchiveIdleSessions(
    powertoysSetting("archiveIdleDays"),
    (record) => {
      let view = powertoysSessionViews.get(record.sessionId);
      return !powertoysIsScratchSession(record) && !record.isStarred && !record.scheduledTaskId && !(view && ["needsYou", "newReply"].includes(powertoysStateOf(view)));
    },
    "finished",
  );
  return archived;
}
/** Archives the sessions `matches` picks that have been idle for `days`, unless open in a tab or working. */
async function powertoysArchiveIdleSessions(days, matches, label) {
  let manager = powertoysSessionManager();
  if (!manager || !(days > 0)) {
    return 0;
  }
  let tabs = powertoysTabs.read();
  let tabbed = new Set([...tabs.pinned, ...(tabs.open ?? [])].map((tab) => tab.id));
  let cutoff = Date.now() - days * 24 * 3600 * 1000;
  let running = new Set(manager.listRunningSessions?.().map((session) => session.sessionId) ?? []);
  let archived = 0;
  for (let record of [...manager.sessions.values()]) {
    if (
      record.isArchived ||
      record.prewarmHidden ||
      !matches(record) ||
      tabbed.has(record.sessionId) ||
      running.has(record.sessionId) ||
      !((record.lastActivityAt ?? 0) < cutoff)
    ) {
      continue;
    }
    try {
      await manager.archiveSession(record.sessionId);
      archived++;
    } catch (caught) {
      powertoysWarn(`archiving ${label} session ${record.sessionId} failed: ${caught.message}`);
    }
  }
  if (archived) {
    powertoysLog(`archived ${archived} ${label} session(s) idle for more than ${days} day(s)`);
  }
  return archived;
}

// --- While you were away ---------------------------------------------------------------------------
/** Local sessions active since `since`: what each did, newest first. */
async function powertoysAwaySummary(since) {
  if (!Number.isFinite(since)) {
    throw Error("bad time");
  }
  let local = powertoysLocalCliIds();
  let active = Object.entries(local).filter(([, { record }]) => (record.lastActivityAt ?? 0) >= since && !record.isArchived && !record.prewarmHidden);
  if (active.length === 0) {
    return [];
  }
  let stats = await powertoysTranscripts("stats", { cliSessionIds: active.map(([, value]) => value.cliSessionId), since });
  let views = powertoysStatusSnapshot.waiting;
  return active
    .map(([sessionId, { cliSessionId, record }]) => {
      let recent = stats[cliSessionId]?.since;
      return {
        sessionId,
        title: powertoysSessionTitle(record),
        lastActivityAt: record.lastActivityAt ?? 0,
        state: views.find((item) => item.sessionId === sessionId)?.state ?? "",
        prompts: recent?.prompts ?? 0,
        tools: recent?.tools ?? 0,
        edited: (recent?.edited ?? []).slice(0, 8),
        lastAnswer: recent?.lastAnswer?.text ?? "",
      };
    })
    .filter((item) => item.prompts || item.tools || item.lastAnswer || item.state)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

// --- Quick send: a small window that sends a prompt to a chosen session ---------------------------
var powertoysQuickSendWindow = null;
function powertoysQuickSendHtml(sessions) {
  let options = sessions.map((session) => `<option value="${powertoysEscapeHtml(session.sessionId)}">${powertoysEscapeHtml(session.title)}</option>`).join("");
  let dark = electron.nativeTheme.shouldUseDarkColors;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Quick send</title><style>
  body { margin: 0; padding: 12px; font: 13px "Segoe UI", system-ui, sans-serif; background: ${dark ? "#262624" : "#faf9f5"}; color: ${dark ? "#f5f4ef" : "#1f1e1d"}; display: flex; flex-direction: column; gap: 8px; height: 100vh; box-sizing: border-box; }
  select, textarea { font: inherit; color: inherit; background: ${dark ? "#1f1e1d" : "#fff"}; border: 1px solid ${dark ? "#4a4945" : "#d9d6cc"}; border-radius: 6px; padding: 6px 8px; outline: 0; }
  textarea { flex: 1; resize: none; } .row { display: flex; justify-content: space-between; align-items: center; color: #8a877f; font-size: 12px; }
  button { font: inherit; padding: 5px 14px; border-radius: 6px; border: 0; background: #c96442; color: #fff; cursor: pointer; }
</style></head><body>
<select id="session">${options}</select>
<textarea id="text" placeholder="Message (Enter sends, Shift+Enter: new line, Esc: close)" autofocus></textarea>
<div class="row"><span>Sent to the session without opening it</span><button id="send">Send</button></div>
<script>
  const send = () => { const text = document.getElementById("text").value.trim(); if (!text) return;
    document.title = "powertoys-send:" + btoa(unescape(encodeURIComponent(JSON.stringify({ sessionId: document.getElementById("session").value, text })))); };
  document.getElementById("send").onclick = send;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.title = "powertoys-close";
    if (event.key === "Enter" && !event.shiftKey && event.target.id === "text") { event.preventDefault(); send(); }
  });
</script></body></html>`;
}
async function powertoysOpenQuickSend() {
  if (powertoysQuickSendWindow && !powertoysQuickSendWindow.isDestroyed()) {
    powertoysQuickSendWindow.show();
    powertoysQuickSendWindow.focus();
    return;
  }
  let local = powertoysLocalCliIds();
  let sessions = Object.entries(local)
    .map(([sessionId, { record }]) => ({ sessionId, title: powertoysSessionTitle(record), lastActivityAt: record.lastActivityAt ?? 0, record }))
    .filter((session) => !session.record.isArchived && !session.record.prewarmHidden)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    .slice(0, 30);
  if (sessions.length === 0) {
    powertoysWarn("quick send: no sessions on this computer");
    return;
  }
  let window = new electron.BrowserWindow({
    width: 520,
    height: 220,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    title: "Quick send",
    autoHideMenuBar: true,
    backgroundColor: electron.nativeTheme.shouldUseDarkColors ? "#262624" : "#faf9f5",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  powertoysQuickSendWindow = window;
  window.on("closed", () => (powertoysQuickSendWindow = null));
  window.on("blur", () => !window.isDestroyed() && window.close());
  window.on("page-title-updated", async (event, title) => {
    event.preventDefault();
    if (title === "powertoys-close") {
      window.close();
    } else if (title.startsWith("powertoys-send:")) {
      let request;
      try {
        request = JSON.parse(Buffer.from(title.slice("powertoys-send:".length), "base64").toString("utf8"));
      } catch {
        return;
      }
      if (!local[request?.sessionId] || typeof request.text !== "string") {
        return;
      }
      window.close();
      let sent = await powertoysSendToSession(request.sessionId, request.text);
      if (!sent) {
        notificationService.showNotification("Quick send failed", `The message to ${powertoysSessionTitle(local[request.sessionId].record)} was not delivered.`, "powertoys-quick-send");
      }
    }
  });
  let temporary = powertoysPath.join(electron.app.getPath("temp"), `powertoys-quick-send-${process.pid}.html`);
  await powertoysFs.promises.writeFile(temporary, powertoysQuickSendHtml(sessions), "utf8");
  await window.loadFile(temporary);
}

// --- Network Service watchdog ----------------------------------------------------------------------
var powertoysNetworkRestartScheduled = false;
/** Called by platform/0200 when the Network Service dies outside quit: restart once no session is working. */
function powertoysOnNetworkServiceGone(details) {
  if (!powertoysSetting("networkWatchdog") || powertoysNetworkRestartScheduled) {
    return;
  }
  powertoysNetworkRestartScheduled = true;
  // A shutdown or a kill of the whole app also takes the Network Service down first; only an app
  // still running a while later has really lost it (2026-10-16: a force-kill relaunched the app).
  powertoysLog(`network watchdog: the Network Service died (${details?.reason}); checking again in 15 s`);
  setTimeout(() => {
    if (isEffectivelyQuitting()) {
      powertoysNetworkRestartScheduled = false;
      return;
    }
    powertoysLog("network watchdog: still running without it; restarting when no session is working");
    powertoysScheduleNetworkRestart();
  }, 15000);
}
function powertoysScheduleNetworkRestart() {
  scheduleRestartWhenIdle(localSessionActivitySources, () => {
    powertoysWriteJson("restart-notice.json", { at: Date.now(), text: "Claude restarted itself because its network connection had broken (the Network Service process stopped)." });
    powertoysRestartAndContinue({ rebuild: false, source: "network watchdog" }).catch((caught) => powertoysWarn(`network watchdog restart failed: ${caught.message}`));
  });
}
function powertoysShowRestartNotice() {
  let notice = powertoysReadJson("restart-notice.json", null);
  if (!notice) {
    return;
  }
  try {
    powertoysFs.rmSync(powertoysFile("restart-notice.json"), { force: true });
  } catch {}
  if (Date.now() - notice.at < 10 * 60 * 1000) {
    setTimeout(() => notificationService.showNotification("Claude restarted", String(notice.text), "powertoys-restart-notice"), 8000).unref();
  }
}

function powertoysStartWork() {
  powertoysShowRestartNotice();
  setTimeout(() => powertoysArchiveOldScratchSessions().catch((caught) => powertoysWarn(`scratch clean-up failed: ${caught.message}`)), 120000).unref();
  setInterval(() => powertoysArchiveOldScratchSessions().catch((caught) => powertoysWarn(`scratch clean-up failed: ${caught.message}`)), 3600000).unref();
}

try {
  powertoysHandle("usage", (event, sessionIds) => powertoysUsage(sessionIds));
  powertoysHandle("openEditedInIdea", (event, sessionId) => powertoysOpenEditedFilesInIdea(String(sessionId)));
  powertoysHandle("exportAs", (event, sessionId, format, fallbackMarkdown, fallbackTitle) => powertoysExportAs(event, sessionId, String(format), fallbackMarkdown, fallbackTitle));
  powertoysHandle("awaySummary", (event, since) => powertoysAwaySummary(Number(since)));
  powertoysHandle("quickSend", () => powertoysOpenQuickSend());
} catch (caught) {
  logger.error("[powertoys] registering the work IPC failed: %o", caught);
}

// --- Saved workspaces: a named set of tabs plus the split layout ---------------------------------
function powertoysReadWorkspaces() {
  let list = powertoysReadJson("workspaces.json", []);
  return Array.isArray(list) ? list.filter((workspace) => workspace && typeof workspace.name === "string") : [];
}
async function powertoysCurrentLayout() {
  // The window's layout command requires a caller (the app's get_window_layout tool passes its session).
  let callerSessionId = powertoysRouteSessionId();
  if (!callerSessionId) {
    return { primary: null, splits: [] };
  }
  let dispatched = await sendLayoutCommandToWindow({ kind: LayoutCommandKind.GetLayout, callerSessionId });
  let layout = dispatched?.kind === "result" ? dispatched.result?.layout : null;
  if (!layout) {
    return { primary: powertoysRouteSessionId(), splits: [] };
  }
  return {
    primary: layout.primarySessionId ?? powertoysRouteSessionId(),
    splits: (layout.panes ?? []).map((pane) => pane.sessionId).filter((sessionId) => typeof sessionId === "string"),
  };
}
async function powertoysSaveWorkspace(name) {
  name = String(name ?? "").trim().slice(0, 80);
  if (!name) {
    throw Error("Give the workspace a name");
  }
  let tabs = powertoysTabs.read();
  let workspace = { name, tabs: { pinned: tabs.pinned, open: tabs.open ?? [] }, layout: await powertoysCurrentLayout(), savedAt: Date.now() };
  let list = powertoysReadWorkspaces().filter((other) => other.name !== name);
  list.unshift(workspace);
  powertoysWriteJson("workspaces.json", list);
  powertoysLog(`workspace '${name}' saved: ${workspace.tabs.pinned.length + workspace.tabs.open.length} tab(s), ${workspace.layout.splits.length} split(s)`);
  refreshTrayContextMenu();
  return powertoysReadWorkspaces();
}
function powertoysDeleteWorkspace(name) {
  powertoysWriteJson("workspaces.json", powertoysReadWorkspaces().filter((other) => other.name !== name));
  refreshTrayContextMenu();
  return powertoysReadWorkspaces();
}
async function powertoysRestoreWorkspace(name) {
  let workspace = powertoysReadWorkspaces().find((other) => other.name === name);
  if (!workspace) {
    throw Error(`No workspace named ${name}`);
  }
  powertoysTabs.replace(workspace.tabs);
  await powertoysApplyLayout(workspace.layout, `workspace '${name}'`);
  powertoysLog(`workspace '${name}' restored`);
  return true;
}
function powertoysWorkspaceMenuItems() {
  let list = powertoysReadWorkspaces();
  return [
    ...list.map((workspace) => ({ label: workspace.name.replace(/&/g, "&&"), click: () => powertoysRestoreWorkspace(workspace.name).catch((caught) => powertoysWarn(caught.message)) })),
    ...(list.length ? [{ type: "separator" }] : []),
    { label: "Save the current tabs and splits…", click: () => powertoysCommandMainView({ type: "saveWorkspace" }) },
    { label: "Manage…", click: () => powertoysCommandMainView({ type: "openPalette", query: "workspace" }) },
  ];
}
try {
  powertoysHandle("workspaces", (event, operation, ...args) => {
    if (operation === "list") {
      return powertoysReadWorkspaces();
    }
    if (operation === "save") {
      return powertoysSaveWorkspace(args[0]);
    }
    if (operation === "delete") {
      return powertoysDeleteWorkspace(String(args[0]));
    }
    if (operation === "restore") {
      return powertoysRestoreWorkspace(String(args[0]));
    }
    throw Error(`unknown workspaces operation ${operation}`);
  });
  // A tab dropped on the conversation on screen: open its session beside that one (the page's own
  // split view, through the layout command its open_session_in tool sends). Returns the outcome.
  powertoysHandle("openInSplit", async (event, callerSessionId, targetSessionId) => {
    if (typeof callerSessionId !== "string" || typeof targetSessionId !== "string" || !callerSessionId || !targetSessionId) {
      throw Error("openInSplit needs two session ids");
    }
    let dispatched = await sendLayoutCommandToWindow({ kind: LayoutCommandKind.OpenInSplit, callerSessionId, targetSessionId });
    let outcome = dispatched?.kind === "result" ? dispatched.result?.outcome : dispatched?.kind;
    if (outcome !== "done" && outcome !== "noop") {
      powertoysWarn(`split ${targetSessionId} beside ${callerSessionId} not opened (${dispatched?.result?.reason ?? outcome})`);
    }
    return dispatched?.result?.reason && outcome !== "done" ? `${outcome}: ${dispatched.result.reason}` : outcome;
  });
  // A tab clicked while sessions are side by side: the app's own "focus" layout command (its
  // open_session_in tool's target "focus"). A session already in a pane gets that pane focused; any
  // other takes the place of the session being worked in, so the split stays. Returns the outcome.
  powertoysHandle("focusSessionInSplit", async (event, callerSessionId, targetSessionId) => {
    if (typeof callerSessionId !== "string" || typeof targetSessionId !== "string" || !callerSessionId || !targetSessionId) {
      throw Error("focusSessionInSplit needs two session ids");
    }
    let dispatched = await sendLayoutCommandToWindow({ kind: LayoutCommandKind.Focus, callerSessionId, targetSessionId });
    let outcome = dispatched?.kind === "result" ? dispatched.result?.outcome : dispatched?.kind;
    if (outcome !== "done" && outcome !== "noop") {
      powertoysWarn(`focusing ${targetSessionId} from ${callerSessionId} gave ${dispatched?.result?.reason ?? outcome}`);
    }
    return outcome;
  });
  // A side conversation collapsed back to a tab: its split pane closes (the session keeps running).
  powertoysHandle("closeSplit", async (event, callerSessionId, targetSessionId) => {
    if (typeof callerSessionId !== "string" || typeof targetSessionId !== "string" || !callerSessionId || !targetSessionId) {
      throw Error("closeSplit needs two session ids");
    }
    let dispatched = await sendLayoutCommandToWindow({ kind: LayoutCommandKind.CloseSplit, callerSessionId, targetSessionId });
    let outcome = dispatched?.kind === "result" ? dispatched.result?.outcome : dispatched?.kind;
    powertoysLog(`split: ${targetSessionId} collapsed to a tab: ${outcome}${dispatched?.result?.reason ? ` (${dispatched.result.reason})` : ""}`);
    return outcome;
  });
} catch (caught) {
  logger.error("[powertoys] registering the workspaces IPC failed: %o", caught);
}

// --- Snippet placeholders: {{folder}} {{branch}} {{file}} {{clipboard}} ----------------------------
try {
  powertoysHandle("snippetContext", async (event, sessionId) => {
    let info = typeof sessionId === "string" && sessionId ? await powertoysStatusInfo(sessionId).catch(() => null) : null;
    let file = "";
    if (typeof sessionId === "string" && powertoysLocalCliIds()[sessionId]) {
      file = (await powertoysSessionEditedFiles(sessionId).catch(() => []))[0] ?? "";
    }
    // Electron 44: clipboard reads are asynchronous.
    return { folder: info?.folder ?? "", branch: info?.branch ?? "", file, clipboard: String((await electron.clipboard.readText()) ?? "") };
  });
} catch (caught) {
  logger.error("[powertoys] registering the snippet IPC failed: %o", caught);
}

// --- Next scheduled run per session: a /loop wake-up (ScheduleWakeup) or a recurring loop (CronCreate) --
function powertoysScheduledRuns() {
  let manager = powertoysSessionManager();
  let now = Date.now();
  let runs = {};
  for (let record of manager?.sessions.values() ?? []) {
    if (record.isArchived || record.prewarmHidden) {
      continue;
    }
    let candidates = [];
    let wakeAt = record.pendingLoopWakeup?.scheduledFor;
    if (typeof wakeAt === "number" && wakeAt > now) {
      candidates.push({ at: wakeAt, label: "Scheduled wake-up" });
    }
    let loops = [];
    try {
      loops = manager.sessionViewRecord?.collectSessionLoops?.(record) ?? [];
    } catch {}
    for (let loop of loops) {
      if (typeof loop.nextRunAt === "number" && loop.nextRunAt > now) {
        candidates.push({ at: loop.nextRunAt, label: `${loop.humanSchedule || loop.cron || "Loop"}${loop.prompt ? `: ${String(loop.prompt).replace(/\s+/g, " ").slice(0, 80)}` : ""}` });
      }
    }
    candidates.sort((left, right) => left.at - right.at);
    if (candidates.length) {
      runs[record.sessionId] = candidates[0];
    }
  }
  return runs;
}
try {
  powertoysHandle("scheduledRuns", () => powertoysScheduledRuns());
} catch (caught) {
  logger.error("[powertoys] registering the scheduled-runs IPC failed: %o", caught);
}

// --- /rename with no title: a generated name, as in Claude Code -----------------------------------
/** The last part of a session's conversation as text, for naming it. */
async function powertoysConversationExcerpt(record) {
  let cliSessionId = record.cliSessionId ?? record.unarchivedCliSessionId;
  let conversation = cliSessionId ? await powertoysTranscripts("conversation", { cliSessionId }) : null;
  let text = (conversation?.parts ?? []).map((part) => `${part.fromUser ? "User" : "Claude"}: ${part.text}`).join("\n\n");
  return text.slice(-6000);
}
function powertoysCleanTitle(title) {
  return String(title ?? "").replace(/^["'\s]+|["'\s.]+$/g, "").replace(/\s+/g, " ").slice(0, 80);
}
async function powertoysAutoRename(sessionId) {
  let manager = powertoysSessionManager();
  let record = manager?.sessions.get(sessionId);
  if (!record) {
    throw Error("Only sessions on this computer can be named this way");
  }
  let excerpt = await powertoysConversationExcerpt(record);
  if (excerpt.length < 10) {
    throw Error("Nothing to name it after yet");
  }
  let title = "";
  // The session's own Claude Code process names it, as its /rename does. A stopped session is woken
  // first, as opening it would (the app's host generator below signs in only for 3P providers: for a
  // first-party account its run fails with "Authentication required", seen 2026-10-19).
  if (typeof record.query?.generateSessionTitle !== "function" && !record.isArchived) {
    await manager.warmSession(sessionId, { userInitiated: true }).catch((caught) => powertoysWarn(`/rename: waking ${sessionId} failed: ${caught.message}`));
    for (let waited = 0; waited < 30000 && typeof record.query?.generateSessionTitle !== "function"; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  let query = record.query;
  if (typeof query?.generateSessionTitle === "function") {
    title = powertoysCleanTitle(await withTimeout(query.generateSessionTitle(excerpt, { persist: false }), 30000, "naming the session timed out").catch(() => ""));
  }
  if (!title) {
    title = powertoysCleanTitle(await Promise.resolve()
        .then(() => require("./session-title-branch-generator.js"))
        .then((titleGen) => titleGen.generateTitle(excerpt, titleGen.GENERIC_SESSION_TITLE_PROMPT, record.model)).catch(() => ""));
  }
  if (!title) {
    throw Error("Couldn't generate a name");
  }
  await manager.updateSession(sessionId, { title });
  powertoysLog(`renamed ${sessionId} by /rename`);
  return title;
}
try {
  powertoysHandle("autoRename", (event, sessionId) => powertoysAutoRename(String(sessionId)));
} catch (caught) {
  logger.error("[powertoys] registering the rename IPC failed: %o", caught);
}

// --- Tab preview, per-project defaults, splits kept across a restart ----------------------------
/** What hovering a conversation's tab shows: its last answer, with model, effort, context and state. */
async function powertoysTabPreview(sessionId) {
  let record = powertoysSessionManager()?.sessions.get(sessionId);
  let cliSessionId = record?.cliSessionId ?? record?.unarchivedCliSessionId;
  let [info, text, usage] = await Promise.all([
    powertoysStatusInfo(sessionId),
    cliSessionId ? powertoysTranscripts("lastAnswer", { cliSessionId }).catch(() => null) : null,
    cliSessionId ? powertoysUsage([sessionId]).catch(() => null) : null,
  ]);
  return {
    text: typeof text === "string" ? text.slice(0, 4000) : "",
    model: info.model ?? "",
    effort: info.effort ?? "",
    contextTokens: info.contextTokens ?? 0,
    state: info.state ?? "",
    cost: usage?.sessions?.[sessionId]?.total?.cost ?? 0,
  };
}
// --- Tab extras: PR checks, why a session waits, task lists, queued prompts ------------------------------
/** A session's open PRs with their checks, from the app's PR tracker: [{ number, repo, url, checks }]. */
function powertoysSessionPrs(view) {
  let bound = (view?.prs ?? []).filter((pr) => !pr.dismissed && pr.prNumber && pr.repo);
  if (bound.length === 0) {
    return [];
  }
  let tracked = getForgeStateTracker().snapshot();
  return bound.flatMap((pr) => {
    let entry = tracked.find((each) => String(each.repo ?? "").toLowerCase() === String(pr.repo).toLowerCase() && each.identifier === String(pr.prNumber));
    let state = String(entry?.details?.state ?? pr.state ?? "").toUpperCase();
    let details = entry?.details ?? {};
    return state && state !== "OPEN"
      ? []
      : [
          {
            number: pr.prNumber,
            repo: pr.repo,
            url: pr.url ?? entry?.url ?? "",
            checks: details.checks ?? "",
            draft: details.isDraft === true || pr.isDraft === true,
            review: details.reviewDecision ?? "",
            mergeable: details.mergeable ?? "",
            additions: details.additions ?? null,
            deletions: details.deletions ?? null,
            comments: typeof details.openReviewComments === "number" ? details.openReviewComments : (details.openReviewComments?.count ?? null),
          },
        ];
  });
}
/** "Bash", "WebFetch", "github: create pull request" for mcp__github__create_pull_request. */
function powertoysToolLabel(name) {
  let mcp = /^mcp__(.+?)__(.+)$/.exec(String(name));
  return mcp ? `${mcp[1]}: ${mcp[2].replace(/_/g, " ")}` : String(name);
}
/** Why a session waits for the person, in a few words; "" when it does not. */
function powertoysWaitReason(view, state = powertoysStateOf(view)) {
  if (state === "needsYou") {
    let tools = (view.pendingToolPermissions ?? []).map((request) => request?.toolName ?? "");
    if (tools.includes("AskUserQuestion")) {
      return "question";
    }
    if (tools.includes("ExitPlanMode")) {
      return "plan to approve";
    }
    if (tools[0]) {
      return `permission: ${powertoysToolLabel(tools[0])}`;
    }
    return view.pendingCwdTrustPrompt ? "folder trust" : "a prompt to answer";
  }
  if (state === "ciFailed") {
    return "CI failed";
  }
  if (state === "newReply") {
    return view.error ? "error" : "finished";
  }
  return "";
}
/**
 * The Notion ticket a conversation is about, from the pages it fetched (see trackTopic): the one whose ID is in the
 * session's title, else the one whose ID the person mentions most, else the first one fetched with an ID; with no
 * fetched ticket, an ID in the title alone. Only tickets the session's project takes count (powertoysTicketPrefixes).
 */
function powertoysPickTicket(topic, title, view) {
  let prefixes = powertoysTicketPrefixes(view);
  let takes = (id) => !prefixes || prefixes.includes(id.split("-")[0]);
  let property = (page, pattern) => Object.entries(page.properties ?? {}).find(([key]) => pattern.test(key))?.[1];
  let idOf = (page) => {
    let value = property(page, /(^|:)ID$/i);
    return typeof value === "string" && /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(value) ? value : "";
  };
  let mentions = topic?.mentions ?? {};
  let tickets = (topic?.pages ?? []).map((page) => ({ page, id: idOf(page) })).filter((ticket) => ticket.id && takes(ticket.id));
  let chosen =
    tickets.find((ticket) => title.includes(ticket.id)) ??
    [...tickets].sort((left, right) => (mentions[right.id] ?? 0) - (mentions[left.id] ?? 0) || left.page.order - right.page.order)[0];
  if (!chosen) {
    let id = title.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g)?.find(takes);
    return id ? { id, title: "", url: "", status: "", read: false } : null;
  }
  let text = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.filter((each) => typeof each === "string" && !/^https?:/.test(each)).join(", ") : "");
  return {
    id: chosen.id,
    title: chosen.page.title,
    url: chosen.page.url ?? "",
    status: text(property(chosen.page, /^status$/i)),
    priority: text(property(chosen.page, /^priority$/i)),
    type: text(property(chosen.page, /^type$/i)),
    description: text(property(chosen.page, /^description$/i)).slice(0, 600),
    read: true,
    at: chosen.page.updatedAt ?? chosen.page.seenAt,
  };
}
/**
 * The ticket prefixes a session's project takes: with ticketProjects set ({ "ISS": "E:\\…\\lscore" }), those mapped
 * to its folder (none for any other project); with none set, any (null).
 */
function powertoysTicketPrefixes(view) {
  let mapping = Object.entries(powertoysSetting("ticketProjects") ?? {}).filter(([, folder]) => typeof folder === "string" && folder);
  if (!mapping.length) {
    return null;
  }
  let key = (folder) => powertoysWindowsPath(String(folder).replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, "")).toLowerCase();
  let folder = key(view?.originCwd || view?.cwd || "");
  return mapping.filter(([, mapped]) => key(mapped) === folder).map(([prefix]) => prefix.toUpperCase());
}
/** For the page's tabs: { [sessionId]: { prs, reason, queued, todos, taskList, topic } }. */
async function powertoysTabExtras(sessionIds) {
  let manager = powertoysSessionManager();
  let waiting = new Map(powertoysStatusSnapshot.waiting.map((item) => [item.sessionId, item]));
  let queue = powertoysPromptQueue();
  let result = {};
  await Promise.all(
    (Array.isArray(sessionIds) ? sessionIds : []).slice(0, 60).map(async (sessionId) => {
      let view = powertoysSessionViews.get(sessionId);
      if (!view) {
        return;
      }
      let state = powertoysStateOf(view);
      let cliSessionId = manager?.sessions.get(sessionId)?.cliSessionId;
      let [todos, topic] = cliSessionId
        ? await Promise.all([powertoysTranscripts("todos", { cliSessionId }).catch(() => null), powertoysTranscripts("topic", { cliSessionId }).catch(() => null)])
        : [null, null];
      result[sessionId] = {
        prs: powertoysSessionPrs(view),
        reason: waiting.get(sessionId)?.reason ?? powertoysWaitReason(view, state),
        queued: queue[sessionId]?.length ?? 0,
        taskList: manager?.sessions.get(sessionId)?.turnBoxMounted === true || manager?.sessions.get(sessionId)?.turnBoxDeclared === true,
        todos: todos?.items.length ? { ...todos, state } : null,
        topic: { ticket: powertoysPickTicket(topic, powertoysSessionTitle(view), view), recap: topic?.recap ?? null },
      };
    }),
  );
  return result;
}
/**
 * A prompt from outside the app (Slack Powertoys' "Share with Claude", scripts/powertoys-command.mjs) for a session,
 * named by its id or by its Claude Code session id (the transcript's name): it joins the session's prompt queue,
 * so it is sent now when the session is idle, else when its turn ends, as a message the app shows. With a model
 * ("haiku", "sonnet", "opus" or an id the model picker offers) that one turn runs on it (powertoysSendQueued).
 */
function powertoysQueuePromptFromRequest(request) {
  let manager = powertoysSessionManager();
  let text = typeof request?.text === "string" ? request.text.trim() : "";
  if (!text) {
    throw Error("No prompt text");
  }
  let sessionId = typeof request.sessionId === "string" && manager?.sessions.has(request.sessionId) ? request.sessionId : null;
  if (!sessionId && typeof request.cliSessionId === "string" && request.cliSessionId) {
    sessionId =
      [...(manager?.sessions.values() ?? [])].find((record) => record.cliSessionId === request.cliSessionId || record.unarchivedCliSessionId === request.cliSessionId)
        ?.sessionId ?? null;
  }
  if (!sessionId) {
    throw Error(`No Claude Desktop session has ${request.cliSessionId ? `Claude Code session ${request.cliSessionId}` : `id ${request.sessionId}`}`);
  }
  let model = request.model === undefined || request.model === null || request.model === "" ? null : powertoysPickModel(request.model);
  let queue = powertoysQueueChange(sessionId, "add", text, model);
  powertoysLog(`prompt queue: ${text.length} characters queued for ${sessionId} by a command request${model ? ` (on ${model})` : ""}`);
  // Not awaited: the answer goes back at once; sending waits for the session.
  powertoysSendQueued(sessionId, "queued by a command request");
  return { sessionId, queued: queue[sessionId]?.length ?? 0, ...(model ? { model } : {}) };
}
/** A model the model picker offers, by id (date suffix optional) or by family ("haiku" -> its newest); unknown ones throw. */
function powertoysPickModel(name) {
  let wanted = typeof name === "string" ? name.trim() : "";
  let models = powertoysSessionManager()?.getAvailableCodeModels() ?? [];
  if (!models.length) {
    throw Error("The app has not reported its model list yet; try again in a moment");
  }
  let family = wanted.toLowerCase();
  let newest = (list) => list.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  let model =
    models.find((each) => each === wanted) ??
    models.find((each) => stripModelDateSuffix(each) === stripModelDateSuffix(wanted)) ??
    (/^[a-z]+$/.test(family) ? newest(models.filter((each) => each.toLowerCase().split("-").includes(family))) : undefined);
  if (!model) {
    throw Error(`Unknown model "${wanted}" (available: ${models.join(", ")}, or haiku, sonnet, opus)`);
  }
  return model;
}
/** Sessions running one queued prompt on its own model: sessionId -> { model, back }, the model to return to. */
const powertoysTurnModels = new Map();
/** After that turn: back to the session's own model, unless someone picked another meanwhile. */
async function powertoysRestoreTurnModel(sessionId) {
  let turn = powertoysTurnModels.get(sessionId);
  if (!turn) {
    return;
  }
  powertoysTurnModels.delete(sessionId);
  let current = powertoysSessionManager()?.sessions.get(sessionId)?.model;
  if (current && stripModelDateSuffix(current) !== stripModelDateSuffix(turn.model)) {
    powertoysLog(`prompt queue: ${sessionId} was moved to ${current} during its ${turn.model} turn; left there`);
    return;
  }
  await powertoysSessionManager().setModel(sessionId, turn.back);
  powertoysLog(`prompt queue: ${sessionId} is back on ${turn.back ?? "the default model"} after a turn on ${turn.model}`);
}
/** Sends a session's next queued prompt when its turn is over and nothing waits for an answer. */
const powertoysQueueSending = new Set();
async function powertoysSendQueued(sessionId, why) {
  let view = powertoysSessionViews.get(sessionId);
  let list = powertoysPromptQueue()[sessionId] ?? [];
  if (!view || list.length === 0 || powertoysQueueSending.has(sessionId)) {
    return;
  }
  if (view.turnRunning || powertoysStateOf(view) === "needsYou") {
    return;
  }
  if (view.error) {
    powertoysLog(`prompt queue: ${sessionId} stopped with an error; ${list.length} queued prompt(s) wait`);
    return;
  }
  powertoysQueueSending.add(sessionId);
  try {
    let manager = powertoysSessionManager();
    let own = manager.sessions.get(sessionId)?.model;
    if (list[0].model && (!own || stripModelDateSuffix(own) !== stripModelDateSuffix(list[0].model))) {
      await manager.setModel(sessionId, list[0].model);
      powertoysTurnModels.set(sessionId, { model: list[0].model, back: own });
      powertoysLog(`prompt queue: ${sessionId} runs its next turn on ${list[0].model} (its own: ${own ?? "the default model"})`);
    }
    let result = await manager.sendMessage(sessionId, list[0].text).catch((caught) => ({ delivered: false, reason: caught.message }));
    if (result?.delivered === false) {
      powertoysWarn(`prompt queue: the next prompt to ${sessionId} was not delivered: ${result.reason}`);
      await powertoysRestoreTurnModel(sessionId);
      return;
    }
    powertoysQueueChange(sessionId, "remove", list[0].id);
    powertoysLog(`prompt queue: sent the next prompt to ${sessionId} (${why}); ${list.length - 1} left`);
  } finally {
    powertoysQueueSending.delete(sessionId);
  }
}
/** Where a session's context went (contextMap in the transcript worker), with the model's context window. */
async function powertoysContextMap(sessionId) {
  let record = powertoysSessionManager()?.sessions.get(sessionId);
  let cliSessionId = record?.cliSessionId ?? record?.unarchivedCliSessionId;
  if (!cliSessionId) {
    throw Error("This session has no transcript yet");
  }
  let map = await powertoysTranscripts("contextMap", { cliSessionId });
  if (!map) {
    throw Error("This session's transcript was not found");
  }
  let model = record.model || map.model || "";
  let peak = Math.max(0, ...map.points.map((point) => point.context), ...map.compactions.map((compaction) => compaction.pre));
  // The app's own size for the model when it has one; else 1M for a [1m] model or a session that went past 200k.
  let contextWindow = getContextWindowForModel(model, map.model) ?? (/[1m]/i.test(model) || peak > 200000 ? 1000000 : 200000);
  return { ...map, contextWindow };
}
/** A session's task list with each item's times (transcript), and whether the session is working now. */
async function powertoysTodoProgress(sessionId) {
  let record = powertoysSessionManager()?.sessions.get(sessionId);
  let cliSessionId = record?.cliSessionId ?? record?.unarchivedCliSessionId;
  if (!cliSessionId) {
    return null;
  }
  let [todos, info] = await Promise.all([powertoysTranscripts("todos", { cliSessionId }), powertoysStatusInfo(sessionId)]);
  return todos ? { ...todos, state: info.state ?? "" } : null;
}
/**
 * A large paste kept as a file the prompt then mentions (@"<path>"), so the message stays one line:
 * <userData>/powertoys/pastes/pasted-<date>-<time>.txt; files older than 30 days are removed.
 */
function powertoysSavePaste(text) {
  if (typeof text !== "string" || text === "") {
    throw Error("Nothing to save");
  }
  let dir = powertoysPath.join(powertoysDir(), "pastes");
  powertoysFs.mkdirSync(dir, { recursive: true });
  let cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (let name of powertoysFs.readdirSync(dir)) {
    try {
      if (powertoysFs.statSync(powertoysPath.join(dir, name)).mtimeMs < cutoff) {
        powertoysFs.rmSync(powertoysPath.join(dir, name), { force: true });
      }
    } catch {}
  }
  let stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let file = powertoysPath.join(dir, `pasted-${stamp}.txt`);
  for (let n = 2; powertoysFs.existsSync(file); n++) {
    file = powertoysPath.join(dir, `pasted-${stamp}-${n}.txt`);
  }
  powertoysFs.writeFileSync(file, text, "utf8");
  powertoysLog(`paste: ${text.length} characters saved to ${file}`);
  return file;
}
/**
 * The root a file outside the session's folders may be read from, or null: Powertoys' own pastes
 * folder, or, when the person is viewing it in the file pane, any file. Read only (the session
 * manager treats it as a temp root).
 * Called by the session manager's containToGrantedRoots (ccd-local-session-manager).
 */
function powertoysOutsideReadRoot(realAbs, viewing) {
  if (typeof realAbs !== "string") {
    return null;
  }
  if (viewing) {
    return powertoysPath.dirname(realAbs);
  }
  let pastes = powertoysPath.join(powertoysDir(), "pastes");
  return realAbs.toLowerCase().startsWith(`${pastes.toLowerCase()}${powertoysPath.sep}`) ? pastes : null;
}
Object.defineProperty(exports, "powertoysOutsideReadRoot", { enumerable: true, get: () => powertoysOutsideReadRoot });
/**
 * Token use and estimated cost over the last `days` days (today included), per project (a worktree
 * counts as its repository) and per session, most expensive first. Local sessions only.
 */
async function powertoysUsageReport(days) {
  days = Math.max(1, Math.min(90, Math.round(Number(days) || 7)));
  let local = powertoysLocalCliIds();
  let dayList = [...Array(days)].map((_, back) => new Date(Date.now() - back * 24 * 3600 * 1000).toLocaleDateString("sv"));
  let since = new Date(new Date().setHours(0, 0, 0, 0)).getTime() - (days - 1) * 24 * 3600 * 1000;
  let active = Object.entries(local).filter(([, { record }]) => (record.lastActivityAt ?? 0) >= since);
  let stats = active.length ? await powertoysTranscripts("stats", { cliSessionIds: active.map(([, { cliSessionId }]) => cliSessionId) }) : {};
  let projects = new Map();
  let sessions = [];
  for (let [sessionId, { cliSessionId, record }] of active) {
    let byDay = stats[cliSessionId]?.byDay;
    if (!byDay) {
      continue;
    }
    let inRange = Object.fromEntries(Object.entries(byDay).filter(([day]) => dayList.includes(day)));
    let sum = powertoysSumUsage(inRange);
    let tokens = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
    if (!tokens) {
      continue;
    }
    let today = powertoysSumUsage(byDay, dayList[0]);
    let view = powertoysSessionViews.get(sessionId);
    let folder = String(view?.originCwd || record.cwd || "").replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, "").replace(/[\\/]+$/, "");
    let session = { sessionId, title: view ? powertoysSessionTitle(view) : record.title || "Untitled session", folder, cost: sum.cost, tokens, output: sum.output, todayCost: today.cost };
    sessions.push(session);
    let key = folder.toLowerCase();
    let project = projects.get(key) ?? { folder, name: powertoysPath.basename(folder) || "No folder", cost: 0, tokens: 0, output: 0, todayCost: 0, sessions: 0 };
    project.cost += session.cost;
    project.tokens += tokens;
    project.output += sum.output;
    project.todayCost += today.cost;
    project.sessions++;
    projects.set(key, project);
  }
  return {
    days,
    projects: [...projects.values()].sort((left, right) => right.cost - left.cost),
    sessions: sessions.sort((left, right) => right.cost - left.cost),
  };
}
/** The models this computer's sessions have used, most used first (the project-defaults menu offers them). */
function powertoysKnownModels() {
  let counts = new Map();
  for (let record of powertoysSessionManager()?.sessions.values() ?? []) {
    if (typeof record.model === "string" && record.model) {
      counts.set(record.model, (counts.get(record.model) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([model]) => model);
}
/**
 * A new session started from the app in a folder with project defaults (Powertoys settings,
 * projectDefaults) gets that project's model and effort. Called by LocalSessions.start
 * (ccd-local-sessions-api) before the session manager normalises the options.
 */
function powertoysApplyProjectDefaults(startOptions) {
  // A local session's folders with backslashes, as the app's own folder picker gives them (a claude:// link
  // can give E:/x, which the app would file as another project).
  if (startOptions && !startOptions.sshConfig && !startOptions.wslConfig) {
    startOptions.cwd = powertoysWindowsPath(startOptions.cwd);
    if (Array.isArray(startOptions.additionalDirectories)) {
      startOptions.additionalDirectories = startOptions.additionalDirectories.map(powertoysWindowsPath);
    }
  }
  let cwd = typeof startOptions?.cwd === "string" ? powertoysWindowsPath(startOptions.cwd).toLowerCase() : "";
  if (!cwd) {
    return;
  }
  powertoysApplyProjectInstructions(startOptions);
  for (let defaults of Object.values(powertoysSetting("projectDefaults") ?? {})) {
    let folder = typeof defaults?.folder === "string" ? powertoysWindowsPath(defaults.folder).toLowerCase() : "";
    if (!folder || (cwd !== folder && !cwd.startsWith(`${folder}\\`) && !cwd.startsWith(`${folder}/`))) {
      continue;
    }
    if (typeof defaults.model === "string" && defaults.model) {
      startOptions.model = defaults.model;
    }
    if (typeof defaults.effort === "string" && defaults.effort) {
      startOptions.effort = defaults.effort;
      startOptions.effortInherited = false;
    }
    powertoysLog(`new session in ${defaults.name ?? folder}: project defaults ${defaults.model || "app model"}, ${defaults.effort || "app effort"}`);
    return;
  }
}
Object.defineProperty(exports, "powertoysApplyProjectDefaults", { enumerable: true, get: () => powertoysApplyProjectDefaults });
// --- The app's task list (its plan tool, mcp__ccd_turn__update_plan, with the wrap-up box) ---------------------
// The page asks for it per new session only while two of its server flags allow it, and a session keeps the tool
// set it started with, so some sessions have no task list at all (nor Claude Code's own task tools).
/**
 * Added to the plan tool's description (setting agentEstimates): ask for an estimate per step, with how the last
 * finished steps went against theirs (estimates.json) and Claude's memory to learn from.
 */
function powertoysPlanToolNote() {
  if (powertoysSetting("agentEstimates") === false) {
    return "";
  }
  let steps = powertoysEstimateHistory().slice(-100);
  let calibration = "";
  if (steps.length >= 5) {
    let ratios = steps.map((step) => step.actual / step.estimate).sort((left, right) => left - right);
    let median = ratios[Math.floor(ratios.length / 2)];
    calibration = ` Measured on your last ${steps.length} finished steps: they took a median of ${median.toFixed(1)}× your estimate, so correct for that unless you know why this work differs.`;
  }
  return (
    "\n\nGive every step an estimate: the minutes you expect it to take you, judged from the work it involves (what to read and change, builds, deploys, tests, waiting for CI or reviews). Whenever you send the whole plan again, re-estimate the steps not done yet from what you have learned. The app shows the user the time left and when you will be done from these estimates, so make them your honest best guess." +
    calibration +
    " Learn from your memory: before estimating, use what it says about how long similar work took. When this tool tells you a finished step took under half or over double its estimate, save or update a short memory note (the kind of work and how long it really took) so your next estimates are better."
  );
}
// --- Estimates that learn: each finished step's real time against its estimate ----------------------------
const powertoysPlanSteps = new Map(); // sessionId -> [{ content, estimate, status, startedAt }]
/** The finished steps with an estimate: [{ project, content, estimate, actual, at }] (minutes; the last 300). */
function powertoysEstimateHistory() {
  try {
    let steps = JSON.parse(powertoysFs.readFileSync(powertoysPath.join(powertoysDir(), "estimates.json"), "utf8")).steps;
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}
/**
 * Called by the plan tool (update_plan) on each call that changes the plan: notes when each step starts and, for
 * the steps this call finished, keeps their real time in estimates.json and returns it for the tool's result, so
 * Claude sees how its estimates went (and can note it in its memory).
 */
function powertoysPlanFeedback(sessionId, input) {
  if (powertoysSetting("agentEstimates") === false || !input || typeof input !== "object") {
    return "";
  }
  let now = Date.now();
  let steps = powertoysPlanSteps.get(sessionId) ?? [];
  let finished = [];
  let setStatus = (step, status) => {
    if (status === "in_progress" && step.status !== "in_progress") {
      step.startedAt = now;
    }
    if (status === "completed" && step.status === "in_progress" && step.startedAt) {
      finished.push(step);
    }
    if (status === "pending" || status === "in_progress" || status === "completed") {
      step.status = status;
    }
  };
  if (Array.isArray(input.items)) {
    let fresh = input.scope === "first_task" || input.scope === "new_task";
    steps = input.items
      .filter((item) => typeof item?.content === "string" && item.content)
      .map((item) => {
        let before = fresh ? undefined : steps.find((step) => step.content === item.content);
        let step = { content: item.content, estimate: item.estimate > 0 ? item.estimate : before?.estimate, status: before?.status ?? "pending", startedAt: before?.startedAt };
        setStatus(step, item.status);
        return step;
      });
  } else {
    if (input.advance === true) {
      let current = steps.findIndex((step) => step.status === "in_progress");
      if (current >= 0) {
        setStatus(steps[current], "completed");
        let next = steps.slice(current + 1).find((step) => step.status === "pending");
        if (next) {
          setStatus(next, "in_progress");
        }
      }
    }
    for (let number of Array.isArray(input.done) ? input.done : []) {
      if (steps[number - 1]) {
        setStatus(steps[number - 1], "completed");
      }
    }
    if (Number.isInteger(input.start) && steps[input.start - 1]) {
      setStatus(steps[input.start - 1], "in_progress");
    }
  }
  powertoysPlanSteps.set(sessionId, steps);
  let timed = finished.filter((step) => step.estimate > 0).map((step) => ({ ...step, actual: Math.round((now - step.startedAt) / 6000) / 10 }));
  if (!timed.length) {
    return "";
  }
  let record = powertoysSessionManager()?.sessions.get(sessionId);
  let project = powertoysWindowsPath(String(record?.originCwd || record?.cwd || "").replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, ""));
  try {
    let history = [...powertoysEstimateHistory(), ...timed.map((step) => ({ project, content: step.content.slice(0, 200), estimate: step.estimate, actual: step.actual, at: now }))].slice(-300);
    powertoysFs.writeFileSync(powertoysPath.join(powertoysDir(), "estimates.json"), JSON.stringify({ steps: history }, null, 1));
  } catch (caught) {
    powertoysLog(`estimates: not saved: ${caught.message}`);
  }
  let far = timed.some((step) => step.actual > 2 * step.estimate || step.actual < step.estimate / 2);
  return (
    " Step times: " +
    timed.map((step) => `“${step.content.slice(0, 80)}” took ${step.actual} min (you estimated ${step.estimate})`).join("; ") +
    (far ? ". That is far from the estimate: note in your memory what made it take that long." : ".")
  );
}
Object.defineProperty(exports, "powertoysPlanFeedback", { enumerable: true, get: () => powertoysPlanFeedback });
Object.defineProperty(exports, "powertoysPlanToolNote", { enumerable: true, get: () => powertoysPlanToolNote });
/** A new session the person starts asks for the task list when the setting is on. */
function powertoysApplyTaskList(startOptions) {
  if (powertoysSetting("forceTaskList") === false || !startOptions || startOptions.turnBox === true || startOptions.violinBow) {
    return;
  }
  startOptions.turnBox = true;
  powertoysLog("new session: the task list asked for (Powertoys)");
}
Object.defineProperty(exports, "powertoysApplyTaskList", { enumerable: true, get: () => powertoysApplyTaskList });
/**
 * Gives an existing local session the task list from its next message: it is declared, the pinned prompt and tool
 * set are dropped (so the next start builds them with it; the conversation is read again once, without the cache),
 * and an idle Claude Code process is stopped so that start comes with the next message.
 */
async function powertoysAddTaskList(sessionId) {
  let manager = powertoysSessionManager();
  let session = manager?.sessions.get(sessionId);
  if (!session) {
    throw Error("Session not found");
  }
  if (session.backend?.remoteTarget || session.violinBow || session.wslConfig) {
    throw Error("Only a local Windows session can get the task list here");
  }
  if (!isFeatureEnabled("2371478310")) {
    throw Error("The app has the task list switched off for this account right now");
  }
  if (session.turnBoxMounted === true) {
    return "already";
  }
  if (session.query && !manager.canRestartForModelNow(session)) {
    throw Error("The session is busy: try again when its turn has ended");
  }
  session.turnBoxDeclared = true;
  session.promptAppendSnapshot = undefined;
  session.toolSurfaceSnapshot = undefined;
  manager.saveSession(session);
  if (session.query) {
    await manager.teardownSession(sessionId, "stop", { stopTrigger: "model_restart" });
  }
  powertoysLog(`task list added to ${sessionId}; it comes with the next message`);
  return "next message";
}
/** Opens `primary`, then each of `splits` beside it (a saved workspace, or the layout before a restart). */
async function powertoysApplyLayout(layout, label) {
  let { primary, splits } = layout ?? {};
  if (!primary) {
    return;
  }
  powertoysOpenSession(primary);
  // The page needs the conversation on screen before a split can open beside it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (let sessionId of splits ?? []) {
    let dispatched = await sendLayoutCommandToWindow({ kind: LayoutCommandKind.OpenInSplit, callerSessionId: primary, targetSessionId: sessionId });
    if (dispatched?.kind !== "result" || !["done", "noop"].includes(dispatched.result?.outcome)) {
      powertoysWarn(`${label}: split ${sessionId} not opened (${dispatched?.result?.reason ?? dispatched?.kind})`);
    }
  }
}
const POWERTOYS_RESTART_LAYOUT_FILE = "restart-layout.json";
/** Before a restart: keeps the conversations side by side, if any, for powertoysRestoreRestartLayout. */
async function powertoysSaveRestartLayout() {
  if (!powertoysSetting("restoreSplitsAfterRestart")) {
    return;
  }
  let layout = await powertoysCurrentLayout().catch(() => null);
  if (layout?.primary && layout.splits.length) {
    powertoysWriteJson(POWERTOYS_RESTART_LAYOUT_FILE, { ...layout, at: Date.now() });
    powertoysLog(`restart: keeping ${layout.splits.length} split(s) beside ${layout.primary}`);
  }
}
/** After a restart: reopens the saved splits once their main conversation has loaded. */
async function powertoysRestoreRestartLayout() {
  let layout = powertoysReadJson(POWERTOYS_RESTART_LAYOUT_FILE, null);
  try {
    powertoysFs.rmSync(powertoysFile(POWERTOYS_RESTART_LAYOUT_FILE), { force: true });
  } catch {}
  if (!layout?.primary || !(Date.now() - layout.at < 10 * 60 * 1000)) {
    return;
  }
  for (let waited = 0; waited < 60000 && !powertoysSessionManager()?.sessions.has(layout.primary); waited += 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await powertoysApplyLayout(layout, "restart");
  powertoysLog(`restart: reopened ${layout.splits.length} split(s) beside ${layout.primary}`);
}
try {
  powertoysHandle("tabPreview", (event, sessionId) => powertoysTabPreview(String(sessionId)));
  powertoysHandle("todoProgress", (event, sessionId) => powertoysTodoProgress(String(sessionId)));
  powertoysHandle("tabExtras", (event, sessionIds) => powertoysTabExtras(sessionIds));
  powertoysHandle("contextMap", (event, sessionId) => powertoysContextMap(String(sessionId ?? "")));
  powertoysHandle("addTaskList", (event, sessionId) => powertoysAddTaskList(String(sessionId ?? "")));
  // A PR's page from its tab's checks mark.
  powertoysHandle("openUrl", (event, url) => {
    if (!/^https:\/\//.test(String(url))) {
      throw Error("Only https links open");
    }
    return electron.shell.openExternal(String(url));
  });
  powertoysHandle("queue", (event, sessionId, change, argument) => {
    let queue = powertoysQueueChange(String(sessionId ?? ""), change, argument);
    // A prompt queued while the session is not working goes now.
    if (change === "add" || change === "first") {
      powertoysSendQueued(String(sessionId), "queued while idle");
    }
    return queue;
  });
  powertoysHandle("knownModels", () => powertoysKnownModels());
  powertoysHandle("usageReport", (event, days) => powertoysUsageReport(days));
  powertoysHandle("savePaste", (event, text) => powertoysSavePaste(text));
  powertoysHandle("setNote", (event, sessionId, text) => powertoysSetNote(String(sessionId ?? ""), text));
} catch (caught) {
  logger.error("[powertoys] registering the tab preview IPC failed: %o", caught);
}
