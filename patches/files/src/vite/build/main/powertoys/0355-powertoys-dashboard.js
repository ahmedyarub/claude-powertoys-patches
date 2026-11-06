// --- Token use dashboard: where the tokens went, over any period ---------------------------------------
// A window of its own (command palette "Token use dashboard"). Main collects every request of the period
// from the transcripts (subagents' too) with the app's session titles; the page filters, charts and warns.
// The page is sandboxed: it asks for data and actions by setting its title ("powertoys-dash:<base64 JSON>"),
// and gets data back through window.ptReceive.
var powertoysDashboardWindow = null;
async function powertoysDashboardData({ since, until }) {
  let usage = await powertoysTranscripts("tokenUsage", { since, until });
  let local = powertoysLocalCliIds();
  let byCli = new Map(Object.entries(local).map(([sessionId, { cliSessionId, record }]) => [cliSessionId, { sessionId, record }]));
  let sessions = {};
  for (let file of usage.files) {
    if (sessions[file.cliSessionId]) {
      continue;
    }
    let match = byCli.get(file.cliSessionId);
    // The app records a fork's parent (forkedFromSessionId); a fork's transcript starts with a copy of the
    // parent's history up to the fork, so it re-reads that history too.
    let parentId = match?.record?.forkedFromSessionId;
    let parent = parentId && parentId !== match.sessionId ? local[parentId] : null;
    sessions[file.cliSessionId] = {
      localId: match?.sessionId ?? null,
      title: match ? powertoysSessionTitle(match.record) : "",
      archived: match?.record?.isArchived === true,
      cwd: match?.record?.cwd ?? "",
      forkedFrom: parentId && parentId !== match.sessionId ? { localId: parentId, cliSessionId: parent?.cliSessionId ?? null, title: parent ? powertoysSessionTitle(parent.record) : "" } : null,
      createdAt: match?.record?.createdAt ?? null,
    };
  }
  return {
    ...usage,
    sessions,
    since,
    until,
    generatedAt: Date.now(),
    prices: POWERTOYS_MODEL_PRICES.map(([pattern, input, output, cacheRead]) => [pattern.source, input, output, cacheRead]),
    plan: await powertoysPlanUsage().catch(() => null),
    nudgeTokens: Number(powertoysSetting("contextNudgeTokens")) || 300000,
  };
}
async function powertoysOpenDashboard() {
  if (powertoysDashboardWindow && !powertoysDashboardWindow.isDestroyed()) {
    powertoysDashboardWindow.focus();
    return;
  }
  let dark = electron.nativeTheme.shouldUseDarkColors;
  let window = new electron.BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: "Token use",
    autoHideMenuBar: true,
    backgroundColor: dark ? "#1f1e1d" : "#faf9f5",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  powertoysDashboardWindow = window;
  window.on("closed", () => (powertoysDashboardWindow = null));
  let send = (data) => {
    if (!window.isDestroyed()) {
      window.webContents.executeJavaScript(`window.ptReceive(${JSON.stringify(data)})`).catch((caught) => powertoysWarn(`dashboard: ${caught.message}`));
    }
  };
  window.on("page-title-updated", async (event, title) => {
    event.preventDefault();
    if (!title.startsWith("powertoys-dash:")) {
      return;
    }
    let request;
    try {
      request = JSON.parse(Buffer.from(title.slice("powertoys-dash:".length).replace(/#\d+$/, ""), "base64").toString("utf8"));
    } catch {
      return;
    }
    let localIds = new Set(Object.keys(powertoysLocalCliIds()));
    if (request?.op === "load") {
      let since = Number(request.since) || Date.now() - 7 * 86400000;
      let until = Number(request.until) || Date.now() + 60000;
      let started = Date.now();
      try {
        let data = await powertoysDashboardData({ since, until });
        powertoysLog(`dashboard: ${data.requests.length} requests in ${data.files.length} transcripts (${Date.now() - started} ms)`);
        send({ kind: "data", data });
      } catch (caught) {
        powertoysWarn(`dashboard: reading the transcripts failed: ${caught.message}`);
        send({ kind: "error", message: caught.message });
      }
    } else if (localIds.has(request?.sessionId)) {
      // Actions on a session of this app only.
      if (request.op === "open") {
        powertoysOpenSession(request.sessionId);
        mainWindow?.show?.();
        mainWindow?.focus?.();
      } else if (request.op === "compact") {
        powertoysQueuePrompt(request.sessionId, "/compact", "compact now (dashboard)");
        send({ kind: "toast", message: "Compacting (now, or when its turn ends)" });
      } else if (request.op === "fresh") {
        powertoysStartFresh(request.sessionId).catch((caught) => powertoysWarn(`start fresh: ${caught.message}`));
        send({ kind: "toast", message: "Asked it for a handoff; a fresh session starts from it when it comes back" });
      }
    }
  });
  let temporary = powertoysPath.join(electron.app.getPath("temp"), `powertoys-dashboard-${process.pid}.html`);
  await powertoysFs.promises.writeFile(temporary, powertoysDashboardHtml(dark), "utf8");
  await window.loadFile(temporary);
}
function powertoysDashboardHtml(dark) {
  return `<!doctype html><html${dark ? ' class="dark"' : ""}><head><meta charset="utf-8"><title>Token use</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<style>${POWERTOYS_DASHBOARD_CSS}</style></head><body><div id="app"></div>
<script>(${powertoysDashboardPage.toString()})();</script></body></html>`;
}
const POWERTOYS_DASHBOARD_CSS = `
:root { --bg: #faf9f5; --panel: #ffffff; --panel2: #f3f1ea; --text: #1f1e1d; --dim: #6b6a65; --line: #e3e0d6; --accent: #c96442; --warn: #b45309; --bad: #b91c1c; --good: #15803d; --chip: #ece9df; }
.dark { --bg: #1f1e1d; --panel: #2a2927; --panel2: #262624; --text: #ecebe6; --dim: #a19f97; --line: #3a3936; --accent: #d97757; --warn: #e0a040; --bad: #ef6b5b; --good: #58c27d; --chip: #34332f; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.45 "Segoe UI", system-ui, sans-serif; }
#app { padding: 14px 18px 40px; display: grid; gap: 12px; }
h1 { font-size: 18px; margin: 0; font-weight: 600; }
h2 { font-size: 13px; margin: 0 0 8px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.grid2 { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
@media (max-width: 1150px) { .grid2, .grid3 { grid-template-columns: 1fr; } }
button, select, input { font: inherit; color: var(--text); background: var(--panel2); border: 1px solid var(--line); border-radius: 7px; padding: 4px 9px; }
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
input[type=search] { width: 220px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; border-right: 1px solid var(--line); }
.seg button:last-child { border-right: 0; }
.label { color: var(--dim); font-size: 12px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.kpi .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi .s { color: var(--dim); font-size: 11.5px; }
.warns { display: grid; gap: 6px; }
.warn { display: flex; gap: 10px; align-items: flex-start; padding: 7px 10px; border-radius: 8px; background: var(--panel2); border-left: 3px solid var(--dim); }
.warn.high { border-left-color: var(--bad); }
.warn.medium { border-left-color: var(--warn); }
.warn.info { border-left-color: var(--accent); }
.warn .t { flex: 1; }
.warn .t b { font-weight: 600; }
.warn .acts { display: flex; gap: 6px; flex: none; }
.warn .acts button { padding: 2px 8px; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 92px; overflow: auto; }
.chip { padding: 2px 8px; border-radius: 999px; background: var(--chip); border: 1px solid transparent; cursor: pointer; font-size: 12px; white-space: nowrap; }
.chip.on { border-color: var(--accent); }
.chip.off { opacity: .45; text-decoration: line-through; }
svg { display: block; width: 100%; overflow: visible; }
svg text { fill: var(--dim); font-size: 10.5px; }
.axis line, .axis path { stroke: var(--line); }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 5px 7px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th { color: var(--dim); font-weight: 600; cursor: pointer; position: sticky; top: 0; background: var(--panel); }
th:first-child, td:first-child { text-align: left; }
td.title { max-width: 380px; overflow: hidden; text-overflow: ellipsis; }
tr:hover td { background: var(--panel2); }
tr.sel td { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.tablewrap { max-height: 520px; overflow: auto; }
.flag { display: inline-block; padding: 0 5px; border-radius: 5px; font-size: 11px; margin-left: 4px; background: var(--chip); }
.flag.high { color: var(--bad); } .flag.medium { color: var(--warn); }
.legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; font-size: 12px; }
.legend span { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
#tip { position: fixed; pointer-events: none; z-index: 9; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.25); display: none; max-width: 420px; white-space: pre-line; }
#toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 7px 14px; border-radius: 8px; display: none; }
.muted { color: var(--dim); }
.detail { display: grid; gap: 8px; }
.empty { color: var(--dim); padding: 30px; text-align: center; }
`;
/** The dashboard page (runs in the sandboxed window; serialized into the HTML as is). */
function powertoysDashboardPage() {
  const DAY = 86400000;
  const HOUR = 3600000;
  const PALETTE = ["#d97757", "#5b8def", "#58c27d", "#e0a040", "#a77bd9", "#3fb8c7", "#e46f9e", "#9aa34b", "#c98b5a", "#7f8c9a"];
  const KINDS = [
    { key: "input", label: "Input", color: "#5b8def" },
    { key: "write", label: "Cache write", color: "#e0a040" },
    { key: "read", label: "Cache read", color: "#7f8c9a" },
    { key: "output", label: "Output", color: "#58c27d" },
  ];
  const CONTEXT_BUCKETS = [0, 25e3, 50e3, 100e3, 150e3, 200e3, 300e3, 400e3, 600e3, 800e3, 1e6];
  const state = {
    data: null,
    loading: false,
    period: "7d",
    customFrom: "",
    customTo: "",
    metric: "tokens", // tokens | cost | requests
    groupBy: "session", // session | project | model | agent | tool | kind
    granularity: "auto",
    kinds: new Set(KINDS.map((kind) => kind.key)),
    subagents: "include", // include | exclude | only
    archived: true,
    search: "",
    projects: new Set(), // empty = all
    models: new Set(),
    excludedProjects: new Set(),
    minContext: 0,
    session: null, // selected cliSessionId
    sort: { key: "tokens", desc: true },
    hidden: new Set(), // series hidden in the timeline legend
  };
  try {
    Object.assign(state, JSON.parse(localStorage.getItem("pt-dash") || "{}"), { kinds: new Set(JSON.parse(localStorage.getItem("pt-dash-kinds") || "null") ?? KINDS.map((kind) => kind.key)) });
  } catch {}
  for (let key of ["projects", "models", "excludedProjects", "hidden"]) {
    state[key] = new Set();
  }
  const remember = () => {
    try {
      let { period, customFrom, customTo, metric, groupBy, granularity, subagents, archived, minContext } = state;
      localStorage.setItem("pt-dash", JSON.stringify({ period, customFrom, customTo, metric, groupBy, granularity, subagents, archived, minContext }));
      localStorage.setItem("pt-dash-kinds", JSON.stringify([...state.kinds]));
    } catch {}
  };

  // --- Talking to the app ---
  let messageNumber = 0;
  const ask = (request) => {
    let json = JSON.stringify(request);
    let bytes = new TextEncoder().encode(json);
    let binary = "";
    bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
    document.title = `powertoys-dash:${btoa(binary)}#${++messageNumber}`;
  };
  window.ptReceive = (message) => {
    if (message.kind === "data") {
      state.data = prepare(message.data);
      state.loading = false;
      render();
    } else if (message.kind === "error") {
      state.loading = false;
      toast(`Could not read the transcripts: ${message.message}`);
      render();
    } else if (message.kind === "toast") {
      toast(message.message);
    }
  };
  function periodRange() {
    let now = Date.now();
    let presets = { "24h": DAY, "3d": 3 * DAY, "7d": 7 * DAY, "14d": 14 * DAY, "30d": 30 * DAY, "90d": 90 * DAY };
    if (state.period === "today") {
      return [new Date().setHours(0, 0, 0, 0), now + 60000];
    }
    if (state.period === "custom" && state.customFrom) {
      let from = new Date(`${state.customFrom}T00:00:00`).getTime();
      let to = state.customTo ? new Date(`${state.customTo}T00:00:00`).getTime() + DAY : now + 60000;
      return [from, to];
    }
    return [now - (presets[state.period] ?? 7 * DAY), now + 60000];
  }
  function load() {
    let [since, until] = periodRange();
    state.loading = true;
    render();
    ask({ op: "load", since, until });
  }

  // --- Data ---
  function prepare(data) {
    let prices = data.prices.map(([source, input, output, read]) => [new RegExp(source), input, output, read]);
    let modelPrice = data.models.map((model) => prices.find(([pattern]) => pattern.test(model)) ?? null);
    let sessions = new Map();
    let files = data.files.map((file) => {
      let info = data.sessions[file.cliSessionId] ?? {};
      let cwd = info.cwd || file.cwd || file.project;
      let session = sessions.get(file.cliSessionId);
      if (!session) {
        session = {
          id: file.cliSessionId,
          localId: info.localId,
          title: info.title || file.firstPrompt || "(untitled)",
          firstPrompt: file.firstPrompt,
          archived: info.archived,
          project: cwd,
          projectName: String(cwd).split(/[\\/]/).filter(Boolean).pop() || cwd,
          branch: file.branch,
          inApp: !!info.localId,
          forkedFrom: info.forkedFrom ?? null,
        };
        sessions.set(file.cliSessionId, session);
      }
      if (!file.subagent && file.firstPrompt) {
        session.firstPrompt = file.firstPrompt;
      }
      return { session, subagent: file.subagent, firstAt: file.firstAt };
    });
    let requests = data.requests.map(([fileIndex, at, model, input, write5m, write1h, read, output, tool]) => {
      let price = modelPrice[model];
      let cost = price
        ? { input: (input * price[1]) / 1e6, write: (write5m * price[1] * 1.25 + write1h * price[1] * 2) / 1e6, read: (read * price[3]) / 1e6, output: (output * price[2]) / 1e6 }
        : { input: 0, write: 0, read: 0, output: 0 };
      // Per-token prices, for the warnings' "what it would have saved".
      let unit = price ? { input: price[1] / 1e6, output: price[2] / 1e6, read: price[3] / 1e6 } : null;
      return { file: files[fileIndex], at, model, input, write: write5m + write1h, write1h, read, output, context: input + write5m + write1h + read, tool, cost, unit };
    });
    requests.sort((a, b) => a.at - b.at);
    let prompts = data.prompts.map(([fileIndex, at]) => ({ file: files[fileIndex], at }));
    let done = (data.done ?? []).map(([fileIndex, at]) => ({ file: files[fileIndex], at }));
    return { ...data, sessions: [...sessions.values()], requests, prompts, done };
  }
  const shortModel = (model) => String(model || "?").replace(/^claude-/, "").replace(/-\d{8}$/, "");
  function filtered() {
    let data = state.data;
    let search = state.search.trim().toLowerCase();
    return data.requests.filter((request) => {
      let session = request.file.session;
      if (state.subagents === "exclude" && request.file.subagent) return false;
      if (state.subagents === "only" && !request.file.subagent) return false;
      if (!state.archived && session.archived) return false;
      if (state.projects.size && !state.projects.has(session.project)) return false;
      if (state.excludedProjects.has(session.project)) return false;
      if (state.models.size && !state.models.has(data.models[request.model])) return false;
      if (state.minContext && request.context < state.minContext) return false;
      if (search && !`${session.title} ${session.projectName} ${session.branch} ${session.id}`.toLowerCase().includes(search)) return false;
      return true;
    });
  }
  /** The chosen measure of a request (tokens of the chosen kinds, their estimated cost, or 1 request). */
  function measure(request) {
    if (state.metric === "requests") return 1;
    let total = 0;
    for (let kind of state.kinds) {
      total += state.metric === "cost" ? request.cost[kind] : request[kind];
    }
    return total;
  }
  function groupKey(request) {
    let data = state.data;
    switch (state.groupBy) {
      case "project":
        return request.file.session.projectName;
      case "model":
        return shortModel(data.models[request.model]);
      case "agent":
        return request.file.subagent ? "Subagents" : "Main conversation";
      case "tool":
        return data.tools[request.tool] || "(text reply)";
      default:
        return request.file.session.id;
    }
  }
  function groupLabel(key) {
    if (state.groupBy === "session") {
      let session = state.data.sessions.find((candidate) => candidate.id === key);
      return session ? session.title : key;
    }
    return key;
  }

  // --- Formatting ---
  const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k` : `${Math.round(n)}`);
  const money = (n) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
  const value = (n) => (state.metric === "cost" ? money(n) : state.metric === "requests" ? `${Math.round(n)}` : fmt(n));
  const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");
  const date = (at, withTime = true) => new Date(at).toLocaleString([], { month: "short", day: "numeric", ...(withTime && { hour: "2-digit", minute: "2-digit" }) });
  const h = (tag, props = {}, ...children) => {
    let node = document.createElement(tag);
    for (let [key, val] of Object.entries(props)) {
      if (key === "class") node.className = val;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), val);
      else if (key === "style") node.style.cssText = val;
      else if (val !== false && val != null) node.setAttribute(key, val === true ? "" : val);
    }
    for (let child of children.flat()) {
      if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  };
  const svgNode = (tag, props = {}) => {
    let node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (let [key, val] of Object.entries(props)) node.setAttribute(key, val);
    return node;
  };
  let tip;
  const showTip = (event, text) => {
    tip.textContent = text;
    tip.style.display = "block";
    let x = Math.min(event.clientX + 14, innerWidth - tip.offsetWidth - 8);
    let y = Math.min(event.clientY + 14, innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  const hideTip = () => (tip.style.display = "none");
  let toastTimer;
  function toast(text) {
    let node = document.getElementById("toast");
    node.textContent = text;
    node.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (node.style.display = "none"), 3500);
  }

  // --- Analysis ---
  function sessionStats(requests) {
    let stats = new Map();
    for (let request of requests) {
      let session = request.file.session;
      let entry = stats.get(session.id);
      if (!entry) {
        entry = { session, tokens: 0, cost: 0, requests: 0, input: 0, write: 0, read: 0, output: 0, subagentTokens: 0, contextSum: 0, maxContext: 0, lastContext: 0, lastAt: 0, firstAt: Infinity, models: new Map(), rewrites: 0, rewriteTokens: 0, hourly: new Map(), measure: 0, lastMainAt: 0 };
        stats.set(session.id, entry);
      }
      let tokens = request.input + request.write + request.read + request.output;
      let cost = request.cost.input + request.cost.write + request.cost.read + request.cost.output;
      entry.tokens += tokens;
      entry.cost += cost;
      entry.measure += measure(request);
      entry.requests++;
      entry.input += request.input;
      entry.write += request.write;
      entry.read += request.read;
      entry.output += request.output;
      entry.models.set(request.model, (entry.models.get(request.model) ?? 0) + tokens);
      entry.firstAt = Math.min(entry.firstAt, request.at);
      if (request.file.subagent) {
        entry.subagentTokens += tokens;
      } else {
        entry.contextSum += request.context;
        entry.mainRequests = (entry.mainRequests ?? 0) + 1;
        // Requests come sorted by time: the first one's context is what the session started with (a fork's
        // inherited history).
        entry.firstContext ??= request.context;
        entry.maxContext = Math.max(entry.maxContext, request.context);
        if (request.at >= entry.lastAt) {
          entry.lastContext = request.context;
        }
        // A big cache write after a pause: the cache had expired, and the whole context was written again.
        if (entry.lastMainAt && request.at - entry.lastMainAt > 5 * 60000 && request.write > 100e3) {
          entry.rewrites++;
          entry.rewriteTokens += request.write;
        }
        entry.lastMainAt = request.at;
      }
      entry.lastAt = Math.max(entry.lastAt, request.at);
      let hour = Math.floor(request.at / HOUR);
      entry.hourly.set(hour, (entry.hourly.get(hour) ?? 0) + 1);
    }
    let promptsBySession = new Map();
    for (let prompt of state.data.prompts) {
      promptsBySession.set(prompt.file.session.id, (promptsBySession.get(prompt.file.session.id) ?? 0) + 1);
    }
    for (let entry of stats.values()) {
      entry.avgContext = entry.mainRequests ? entry.contextSum / entry.mainRequests : 0;
      entry.prompts = promptsBySession.get(entry.session.id) ?? 0;
      entry.perPrompt = entry.prompts ? entry.tokens / entry.prompts : 0;
      entry.readShare = entry.tokens ? entry.read / entry.tokens : 0;
      entry.subShare = entry.tokens ? entry.subagentTokens / entry.tokens : 0;
      entry.peakHour = Math.max(0, ...entry.hourly.values());
      entry.model = shortModel(state.data.models[[...entry.models].sort((a, b) => b[1] - a[1])[0]?.[0]]);
    }
    return stats;
  }
  /**
   * Only warnings whose saving can be counted from the requests, for an action that costs little or no quality:
   *   - a big context kept after its task was done (a commit, push, PR or release went out): replayed as if each
   *     such point had started fresh from a short handoff (the summary request and the new session's first
   *     cache write are charged), what every later reply would not have re-read;
   *   - messages that came after the prompt cache had expired (1 h or 5 min idle) into a big context, which wrote
   *     all of it again;
   *   - the context every new session starts with (system prompt, tools, CLAUDE.md, memory), re-read by every reply.
   * Shares of tokens, bursts, busy days and the like were dropped: they said nothing about what to change.
   */
  function startingContext(requests) {
    // What a new session holds before its first message: the median first context of the sessions started here.
    let firsts = new Map();
    for (let request of requests) {
      let file = request.file;
      if (!file.subagent && !firsts.has(file.session.id) && file.firstAt && request.at - file.firstAt < 600000 && request.at >= file.firstAt) {
        firsts.set(file.session.id, request.context);
      }
    }
    let values = [...firsts.values()].filter((value) => value > 5000).sort((a, b) => a - b);
    return { tokens: values.length >= 3 ? values[Math.floor(values.length / 2)] : 0, sessions: values.length };
  }
  function replayFreshStarts(entryRequests, doneTimes, nudge, fresh) {
    // entryRequests: one session's main requests in time order.
    let saved = 0;
    let extra = 0;
    let points = 0;
    let offset = 0; // tokens a fresh start would have dropped, still dropped from every later request
    let doneIndex = 0;
    let previous = 0;
    for (let request of entryRequests) {
      // A compaction or /clear the session really had: the replay starts over from it.
      if (previous && request.context < previous * 0.6) {
        offset = 0;
      }
      previous = request.context;
      let passedDone = false;
      while (doneIndex < doneTimes.length && doneTimes[doneIndex] < request.at) {
        doneIndex++;
        passedDone = true;
      }
      let unit = request.unit;
      if (!unit) {
        continue;
      }
      if (passedDone && request.context - offset >= nudge) {
        let dropped = request.context - offset - fresh;
        if (dropped > 0) {
          points++;
          // The handoff: one more request that re-reads the context and writes about 2k tokens; then the new
          // session writes its starting context into the cache once.
          extra += (request.context - offset) * unit.read + 2000 * unit.output + fresh * unit.input * 2;
          offset += dropped;
        }
      }
      if (offset > 0) {
        let fromRead = Math.min(offset, request.read);
        let fromWrite = Math.min(offset - fromRead, request.write);
        saved += fromRead * unit.read + fromWrite * unit.input * (request.write1h > 0 ? 2 : 1.25);
      }
    }
    return { saved: saved - extra, points };
  }
  function warnings(requests, stats) {
    let data = state.data;
    let nudge = data.nudgeTokens;
    let list = [];
    let start = startingContext(data.requests);
    let fresh = (start.tokens || 100e3) + 5000;
    let mainBySession = new Map();
    for (let request of requests) {
      if (!request.file.subagent) {
        mainBySession.set(request.file.session.id, [...(mainBySession.get(request.file.session.id) ?? []), request]);
      }
    }
    let doneBySession = new Map();
    for (let done of data.done) {
      if (!done.file.subagent) {
        doneBySession.set(done.file.session.id, [...(doneBySession.get(done.file.session.id) ?? []), done.at]);
      }
    }
    let totalCost = requests.reduce((sum, request) => sum + request.cost.input + request.cost.write + request.cost.read + request.cost.output, 0);
    let freshTotal = 0;
    let coldTotal = 0;
    for (let entry of stats.values()) {
      let name = entry.session.title;
      let own = mainBySession.get(entry.session.id) ?? [];
      let doneTimes = (doneBySession.get(entry.session.id) ?? []).sort((a, b) => a - b);
      let replay = replayFreshStarts(own, doneTimes, nudge, fresh);
      if (replay.points > 0 && replay.saved >= Math.max(1, entry.cost * 0.1)) {
        freshTotal += replay.saved;
        list.push({
          level: replay.saved >= entry.cost * 0.3 ? "high" : "medium",
          saving: replay.saved,
          session: entry.session,
          text: `<b>${esc(name)}</b>: ${replay.points} time${replay.points === 1 ? "" : "s"} its work went out (a commit, push, PR or release) with ${fmt(nudge)}+ of context, and every later reply kept re-reading it. Starting fresh from a handoff at those points, where what came next was a new task, would have saved up to <b>${money(replay.saved)}</b> (${pct(replay.saved, entry.cost)} of this session).`,
          actions: entry.lastContext >= nudge ? ["fresh", "compact"] : [],
        });
      }
      // Messages after the cache expired, into a big context: the whole context was written again.
      let cold = { count: 0, cost: 0, tokens: 0 };
      for (let i = 1; i < own.length; i++) {
        let request = own[i];
        let ttl = request.write1h > 0 ? HOUR : 5 * 60000;
        if (request.at - own[i - 1].at > ttl && request.write >= Math.max(100e3, nudge / 3)) {
          cold.count++;
          cold.cost += request.cost.write;
          cold.tokens += request.write;
        }
      }
      if (cold.count >= 2 && cold.cost >= 5) {
        coldTotal += cold.cost;
        list.push({
          level: "medium",
          saving: cold.cost,
          session: entry.session,
          text: `<b>${esc(name)}</b>: ${cold.count} messages came after its cache had expired and wrote all ${fmt(cold.tokens / cold.count)} of context again: <b>${money(cold.cost)}</b>. After a break, a new task in a new session skips that (the ❄ on a tab marks it).`,
        });
      }
    }
    // The starting context, re-read by every reply of every session.
    if (start.tokens) {
      let floorCost = requests.reduce((sum, request) => sum + (request.unit ? Math.min(request.context, start.tokens) * request.unit.read : 0), 0);
      if (floorCost >= Math.max(1, totalCost * 0.05)) {
        list.push({
          level: floorCost >= totalCost * 0.15 ? "medium" : "info",
          saving: floorCost,
          text: `New sessions here start with about <b>${fmt(start.tokens)}</b> of context before your first message (system prompt, tools, MCP servers, skills, CLAUDE.md, memory; median of ${start.sessions} sessions). Every reply re-reads it: <b>${money(floorCost)}</b> (${pct(floorCost, totalCost)}) in this period. MCP servers, plugins and instructions you do not use cost that on every request; each 10k less would save about ${money((floorCost * 10e3) / start.tokens)}.`,
        });
      }
    }
    if (freshTotal + coldTotal > 0) {
      list.push({ level: "info", summary: true, text: `Altogether about <b>${money(freshTotal + coldTotal)}</b> (${pct(freshTotal + coldTotal, totalCost)}) of this period could have been saved by starting fresh once work went out, and by new sessions after breaks.` });
    }
    // Plan limits.
    let plan = data.plan;
    if (plan) {
      for (let [label, window] of [["5-hour", plan.fiveHour], ["Weekly", plan.sevenDay], ...(plan.scoped ?? []).map((scoped) => [`${scoped.name} weekly`, scoped])]) {
        let used = window?.percent ?? window?.utilization;
        if (typeof used === "number" && used >= 80) {
          let resets = window.resetsAt ? ` (resets ${date(Date.parse(window.resetsAt) || window.resetsAt)})` : "";
          list.push({ level: used >= 95 ? "high" : "medium", text: `<b>${label} plan limit</b> at ${Math.round(used)}%${resets}.` });
        }
      }
    }
    // The total first, then by level, the biggest saving first within one.
    let order = { high: 0, medium: 1, info: 2 };
    return list.sort((a, b) => (b.summary ? 1 : 0) - (a.summary ? 1 : 0) || order[a.level] - order[b.level] || (b.saving ?? 0) - (a.saving ?? 0));
  }
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // --- Charts ---
  function bucketSize(span) {
    if (state.granularity === "hour") return HOUR;
    if (state.granularity === "day") return DAY;
    if (state.granularity === "week") return 7 * DAY;
    return span <= 2 * DAY ? HOUR : span <= 45 * DAY ? DAY : 7 * DAY;
  }
  function bucketStart(at, size) {
    let d = new Date(at);
    if (size === HOUR) return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    if (size === DAY) return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    let day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return day.getTime() - ((day.getDay() + 6) % 7) * DAY;
  }
  function timeline(requests, keys) {
    let [since, until] = [state.data.since, Math.min(state.data.until, Date.now())];
    let size = bucketSize(until - since);
    let buckets = [];
    for (let at = bucketStart(since, size); at < until; at += size) buckets.push(at);
    let series = new Map(keys.map((key) => [key, new Array(buckets.length).fill(0)]));
    let other = new Array(buckets.length).fill(0);
    let index = (at) => {
      let start = bucketStart(at, size);
      let i = Math.round((start - buckets[0]) / size);
      return Math.max(0, Math.min(buckets.length - 1, i));
    };
    for (let request of requests) {
      let key = groupKey(request);
      let i = index(request.at);
      (series.get(key) ?? other)[i] += measure(request);
    }
    if (other.some((v) => v > 0)) series.set("Other", other);
    return { buckets, size, series };
  }
  function drawTimeline(container, requests, keys, colors) {
    let { buckets, size, series } = timeline(requests, keys);
    let width = container.clientWidth || 900;
    let height = 260;
    let pad = { l: 56, r: 10, t: 10, b: 26 };
    let visible = [...series].filter(([key]) => !state.hidden.has(key));
    let totals = buckets.map((_, i) => visible.reduce((sum, [, values]) => sum + values[i], 0));
    let max = Math.max(1, ...totals);
    let svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, height });
    let x = (i) => pad.l + (i * (width - pad.l - pad.r)) / buckets.length;
    let barWidth = Math.max(1, (width - pad.l - pad.r) / buckets.length - (buckets.length > 120 ? 0 : 2));
    let y = (v) => height - pad.b - (v / max) * (height - pad.t - pad.b);
    for (let tick = 0; tick <= 4; tick++) {
      let v = (max * tick) / 4;
      svg.append(svgNode("line", { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), stroke: "var(--line)", "stroke-dasharray": tick ? "2 3" : "" }));
      let label = svgNode("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end" });
      label.textContent = value(v);
      svg.append(label);
    }
    let labelEvery = Math.ceil(buckets.length / Math.max(1, Math.floor((width - pad.l) / 70)));
    buckets.forEach((at, i) => {
      if (i % labelEvery === 0) {
        let label = svgNode("text", { x: x(i) + barWidth / 2, y: height - 8, "text-anchor": "middle" });
        label.textContent = size === HOUR ? new Date(at).toLocaleString([], { day: "numeric", hour: "2-digit" }) : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
        svg.append(label);
      }
      let base = 0;
      let lines = [];
      for (let [key, values] of visible) {
        let v = values[i];
        if (v <= 0) continue;
        let rect = svgNode("rect", { x: x(i), y: y(base + v), width: barWidth, height: Math.max(0.5, y(base) - y(base + v)), fill: colors.get(key) ?? "#888", rx: 1 });
        svg.append(rect);
        base += v;
        lines.push([key, v]);
      }
      let hit = svgNode("rect", { x: x(i), y: pad.t, width: barWidth + 2, height: height - pad.t - pad.b, fill: "transparent" });
      hit.addEventListener("mousemove", (event) =>
        showTip(
          event,
          `${size === HOUR ? new Date(at).toLocaleString() : new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}${size === 7 * DAY ? " (week)" : ""}\nTotal ${value(totals[i])}\n` +
            lines
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([key, v]) => `• ${groupLabel(key).slice(0, 60)}: ${value(v)}`)
              .join("\n"),
        ),
      );
      hit.addEventListener("mouseleave", hideTip);
      svg.append(hit);
    });
    container.replaceChildren(svg);
  }
  function drawShares(container, groups, colors, total) {
    container.replaceChildren(
      ...groups.slice(0, 14).map(([key, v]) => {
        let row = h(
          "div",
          { style: "display:grid;grid-template-columns:minmax(0,1fr) 70px 52px;gap:8px;align-items:center;padding:3px 0;cursor:pointer", title: groupLabel(key) },
          h("div", { style: "min-width:0" }, h("div", { style: "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px" }, groupLabel(key)), h("div", { style: `height:6px;border-radius:3px;margin-top:3px;background:${colors.get(key) ?? "#888"};width:${Math.max(1, (v / groups[0][1]) * 100)}%` })),
          h("div", { style: "text-align:right;font-variant-numeric:tabular-nums" }, value(v)),
          h("div", { class: "muted", style: "text-align:right" }, pct(v, total)),
        );
        row.addEventListener("click", () => {
          if (state.groupBy === "session") {
            state.session = key;
          } else if (state.groupBy === "project") {
            let session = state.data.sessions.find((candidate) => candidate.projectName === key);
            if (session) state.projects = new Set([session.project]);
          } else if (state.groupBy === "model") {
            state.models = new Set(state.data.models.filter((model) => shortModel(model) === key));
          } else if (state.groupBy === "agent") {
            state.subagents = key === "Subagents" ? "only" : "exclude";
          }
          render();
        });
        return row;
      }),
    );
  }
  function drawHistogram(container, requests) {
    let counts = CONTEXT_BUCKETS.map(() => 0);
    let sums = CONTEXT_BUCKETS.map(() => 0);
    for (let request of requests) {
      if (request.file.subagent) continue;
      let i = CONTEXT_BUCKETS.findLastIndex((edge) => request.context >= edge);
      counts[i]++;
      sums[i] += measure(request);
    }
    let width = container.clientWidth || 400;
    let height = 200;
    let pad = { l: 8, r: 8, t: 10, b: 30 };
    let max = Math.max(1, ...sums);
    let svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, height });
    let w = (width - pad.l - pad.r) / CONTEXT_BUCKETS.length;
    let nudge = state.data.nudgeTokens;
    CONTEXT_BUCKETS.forEach((edge, i) => {
      let barHeight = (sums[i] / max) * (height - pad.t - pad.b);
      let rect = svgNode("rect", { x: pad.l + i * w + 2, y: height - pad.b - barHeight, width: w - 4, height: Math.max(0.5, barHeight), fill: edge >= nudge ? "var(--bad)" : edge >= nudge / 2 ? "var(--warn)" : "var(--accent)", rx: 2 });
      let next = CONTEXT_BUCKETS[i + 1];
      rect.addEventListener("mousemove", (event) => showTip(event, `Context ${fmt(edge)}${next ? `–${fmt(next)}` : "+"} per request\n${counts[i]} requests, ${value(sums[i])}`));
      rect.addEventListener("mouseleave", hideTip);
      svg.append(rect);
      let label = svgNode("text", { x: pad.l + i * w + w / 2, y: height - 12, "text-anchor": "middle" });
      label.textContent = `${fmt(edge)}${next ? "" : "+"}`;
      svg.append(label);
    });
    container.replaceChildren(svg);
  }
  function drawHeatmap(container, requests) {
    let grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (let request of requests) {
      let d = new Date(request.at);
      grid[(d.getDay() + 6) % 7][d.getHours()] += measure(request);
    }
    let max = Math.max(1, ...grid.flat());
    let width = container.clientWidth || 400;
    let cell = Math.max(8, (width - 36) / 24);
    let height = cell * 7 + 18;
    let svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, height });
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((day, row) => {
      let label = svgNode("text", { x: 0, y: row * cell + cell / 2 + 4 });
      label.textContent = day;
      svg.append(label);
      for (let hour = 0; hour < 24; hour++) {
        let v = grid[row][hour];
        let rect = svgNode("rect", { x: 34 + hour * cell, y: row * cell, width: cell - 2, height: cell - 2, rx: 2, fill: "var(--accent)", "fill-opacity": v ? 0.08 + 0.92 * Math.sqrt(v / max) : 0.04 });
        rect.addEventListener("mousemove", (event) => showTip(event, `${day} ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00\n${value(v)}`));
        rect.addEventListener("mouseleave", hideTip);
        svg.append(rect);
      }
    });
    for (let hour = 0; hour < 24; hour += 3) {
      let label = svgNode("text", { x: 34 + hour * cell, y: height - 2 });
      label.textContent = String(hour).padStart(2, "0");
      svg.append(label);
    }
    container.replaceChildren(svg);
  }
  function drawKinds(container, requests) {
    let sums = Object.fromEntries(KINDS.map((kind) => [kind.key, { tokens: 0, cost: 0 }]));
    for (let request of requests) {
      for (let kind of KINDS) {
        sums[kind.key].tokens += request[kind.key];
        sums[kind.key].cost += request.cost[kind.key];
      }
    }
    let totalTokens = KINDS.reduce((sum, kind) => sum + sums[kind.key].tokens, 0);
    let totalCost = KINDS.reduce((sum, kind) => sum + sums[kind.key].cost, 0);
    let strip = (field) =>
      h(
        "div",
        { style: "display:flex;height:16px;border-radius:5px;overflow:hidden;margin:4px 0 10px" },
        KINDS.map((kind) => {
          let part = sums[kind.key][field];
          let total = field === "tokens" ? totalTokens : totalCost;
          let segment = h("div", { style: `background:${kind.color};width:${total ? (part / total) * 100 : 0}%` });
          segment.addEventListener("mousemove", (event) => showTip(event, `${kind.label}: ${field === "tokens" ? fmt(part) : money(part)} (${pct(part, total)})`));
          segment.addEventListener("mouseleave", hideTip);
          return segment;
        }),
      );
    container.replaceChildren(
      h("div", { class: "label" }, `Tokens (${fmt(totalTokens)})`),
      strip("tokens"),
      h("div", { class: "label" }, `Estimated cost at API prices (${money(totalCost)})`),
      strip("cost"),
      h(
        "div",
        { class: "legend" },
        KINDS.map((kind) => {
          let item = h("span", { class: state.kinds.has(kind.key) ? "" : "muted", title: "Count this kind in the charts and totals" }, h("i", { style: `background:${kind.color}` }), `${kind.label}: ${fmt(sums[kind.key].tokens)} · ${money(sums[kind.key].cost)}`);
          item.addEventListener("click", () => {
            state.kinds.has(kind.key) ? state.kinds.delete(kind.key) : state.kinds.add(kind.key);
            if (state.kinds.size === 0) state.kinds.add(kind.key);
            render();
          });
          return item;
        }),
      ),
    );
  }
  function drawSessionDetail(container, entry, requests) {
    let own = requests.filter((request) => request.file.session.id === entry.session.id && !request.file.subagent);
    let width = container.clientWidth || 600;
    let height = 170;
    let pad = { l: 50, r: 10, t: 8, b: 20 };
    let svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, height });
    if (own.length > 1) {
      let maxContext = Math.max(state.data.nudgeTokens, ...own.map((request) => request.context));
      let x = (i) => pad.l + (i / (own.length - 1)) * (width - pad.l - pad.r);
      let y = (v) => height - pad.b - (v / maxContext) * (height - pad.t - pad.b);
      svg.append(svgNode("line", { x1: pad.l, x2: width - pad.r, y1: y(state.data.nudgeTokens), y2: y(state.data.nudgeTokens), stroke: "var(--bad)", "stroke-dasharray": "4 3" }));
      let nudgeLabel = svgNode("text", { x: width - pad.r, y: y(state.data.nudgeTokens) - 4, "text-anchor": "end" });
      nudgeLabel.textContent = `nudge ${fmt(state.data.nudgeTokens)}`;
      svg.append(nudgeLabel);
      for (let tick = 0; tick <= 3; tick++) {
        let label = svgNode("text", { x: pad.l - 6, y: y((maxContext * tick) / 3) + 3, "text-anchor": "end" });
        label.textContent = fmt((maxContext * tick) / 3);
        svg.append(label);
      }
      svg.append(svgNode("polyline", { points: own.map((request, i) => `${x(i)},${y(request.context)}`).join(" "), fill: "none", stroke: "var(--accent)", "stroke-width": 1.5 }));
      let hit = svgNode("rect", { x: pad.l, y: pad.t, width: width - pad.l - pad.r, height: height - pad.t - pad.b, fill: "transparent" });
      hit.addEventListener("mousemove", (event) => {
        let box = svg.getBoundingClientRect();
        let i = Math.round(((event.clientX - box.left) * (width / box.width) - pad.l) / ((width - pad.l - pad.r) / (own.length - 1)));
        let request = own[Math.max(0, Math.min(own.length - 1, i))];
        showTip(event, `${date(request.at)}\nContext ${fmt(request.context)} (read ${fmt(request.read)}, written ${fmt(request.write)})\nOutput ${fmt(request.output)} · ${shortModel(state.data.models[request.model])}${state.data.tools[request.tool] ? ` · ${state.data.tools[request.tool]}` : ""}`);
      });
      hit.addEventListener("mouseleave", hideTip);
      svg.append(hit);
    }
    let session = entry.session;
    let actions = h("div", { class: "bar" });
    if (session.localId) {
      for (let [op, label] of [["open", "Open"], ["compact", "Compact now"], ["fresh", "Start fresh"]]) {
        actions.append(h("button", { onclick: () => ask({ op, sessionId: session.localId }) }, label));
      }
    } else {
      actions.append(h("span", { class: "muted" }, "Not a session of this app (a terminal or cloud session)."));
    }
    actions.append(h("button", { onclick: () => ((state.session = null), render()) }, "Close"));
    container.replaceChildren(
      h("div", { class: "detail" }, h("div", {}, h("b", {}, session.title), h("span", { class: "muted" }, ` · ${session.project}${session.branch ? ` · ${session.branch}` : ""}`)), h("div", { class: "muted" }, `${entry.requests} requests, ${entry.prompts} messages from you, ${fmt(entry.tokens)} tokens, ${money(entry.cost)} est. · context now ${fmt(entry.lastContext)}, avg ${fmt(entry.avgContext)}, max ${fmt(entry.maxContext)} · cache reads ${pct(entry.read, entry.tokens)} · subagents ${pct(entry.subagentTokens, entry.tokens)}`), h("div", { class: "label" }, "Context per request (main conversation)"), svg, actions),
    );
  }

  // --- Page ---
  function chipFilter(title, values, selected, excluded, onChange) {
    return h(
      "div",
      {},
      h("div", { class: "label" }, title, " ", h("span", { class: "muted" }, "(click: only these · right-click: hide)")),
      h(
        "div",
        { class: "chips" },
        values.map(([key, label, amount]) => {
          let chip = h("span", { class: `chip${selected.has(key) ? " on" : ""}${excluded?.has(key) ? " off" : ""}`, title: key }, `${label} `, h("span", { class: "muted" }, fmt(amount)));
          chip.addEventListener("click", () => {
            selected.has(key) ? selected.delete(key) : selected.add(key);
            onChange();
          });
          chip.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            if (excluded) {
              excluded.has(key) ? excluded.delete(key) : excluded.add(key);
              onChange();
            }
          });
          return chip;
        }),
      ),
    );
  }
  function seg(options, current, onPick) {
    return h(
      "div",
      { class: "seg" },
      options.map(([key, label]) => h("button", { class: key === current ? "on" : "", onclick: () => onPick(key) }, label)),
    );
  }
  function render() {
    remember();
    let app = document.getElementById("app");
    if (!state.data) {
      app.replaceChildren(h("div", { class: "empty" }, state.loading ? "Reading the transcripts…" : "No data yet."));
      return;
    }
    let data = state.data;
    let requests = filtered();
    let total = requests.reduce((sum, request) => sum + measure(request), 0);
    let stats = sessionStats(requests);
    let allStats = [...stats.values()];
    let tokens = allStats.reduce((sum, entry) => sum + entry.tokens, 0);
    let cost = allStats.reduce((sum, entry) => sum + entry.cost, 0);
    let read = allStats.reduce((sum, entry) => sum + entry.read, 0);
    let output = allStats.reduce((sum, entry) => sum + entry.output, 0);
    let mainRequests = requests.filter((request) => !request.file.subagent);
    let avgContext = mainRequests.length ? mainRequests.reduce((sum, request) => sum + request.context, 0) / mainRequests.length : 0;
    let span = Math.max(HOUR, Math.min(data.until, Date.now()) - data.since);
    // Groups for the timeline and the shares.
    let groups = new Map();
    for (let request of requests) {
      let key = groupKey(request);
      groups.set(key, (groups.get(key) ?? 0) + measure(request));
    }
    let ranked = [...groups].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    let topKeys = ranked.slice(0, 9).map(([key]) => key);
    let colors = new Map(topKeys.map((key, i) => [key, PALETTE[i % PALETTE.length]]));
    colors.set("Other", "#8a8780");
    // Filter chips.
    let projectTotals = new Map();
    let modelTotals = new Map();
    for (let request of data.requests) {
      let tokensOf = request.input + request.write + request.read + request.output;
      projectTotals.set(request.file.session.project, (projectTotals.get(request.file.session.project) ?? 0) + tokensOf);
      let model = data.models[request.model];
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + tokensOf);
    }
    let projectChips = [...projectTotals].sort((a, b) => b[1] - a[1]).map(([project, amount]) => [project, String(project).split(/[\\/]/).filter(Boolean).pop() || project, amount]);
    let modelChips = [...modelTotals]
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([model, amount]) => [model, shortModel(model), amount]);
    let warns = warnings(requests, stats, tokens);

    let timelineBox = h("div");
    let sharesBox = h("div");
    let histogramBox = h("div");
    let heatmapBox = h("div");
    let kindsBox = h("div");
    let detailBox = h("div", { class: "panel" });

    // Table.
    let columns = [
      ["title", "Session"],
      ["model", "Model"],
      ["measure", state.metric === "cost" ? "Est. cost" : state.metric === "requests" ? "Requests" : "Tokens"],
      ["share", "Share"],
      ["cost", "Est. $"],
      ["requests", "Reqs"],
      ["prompts", "Msgs"],
      ["perPrompt", "Per msg"],
      ["lastContext", "Ctx now"],
      ["avgContext", "Avg ctx"],
      ["maxContext", "Max ctx"],
      ["readShare", "Cache rd"],
      ["subShare", "Subagents"],
      ["output", "Output"],
      ["lastAt", "Last"],
    ];
    let rows = allStats.slice();
    let sortKey = state.sort.key === "share" ? "measure" : state.sort.key;
    rows.sort((a, b) => {
      let left = sortKey === "title" ? a.session.title : sortKey === "model" ? a.model : a[sortKey];
      let right = sortKey === "title" ? b.session.title : sortKey === "model" ? b.model : b[sortKey];
      let order = typeof left === "string" ? left.localeCompare(right) : left - right;
      return state.sort.desc ? -order : order;
    });
    let flagsOf = (entry) => {
      let flags = [];
      if (entry.lastContext >= data.nudgeTokens) flags.push(["high", "long ctx"]);
      else if (entry.avgContext >= data.nudgeTokens * 0.8) flags.push(["medium", "big avg ctx"]);
      if (entry.rewrites >= 3) flags.push(["medium", `${entry.rewrites}× cache rewrite`]);
      if (entry.subShare >= 0.5) flags.push(["", "subagent-heavy"]);
      if (entry.session.forkedFrom) flags.push(["", `fork of ${(entry.session.forkedFrom.title || "a session").slice(0, 30)}`]);
      if (entry.session.archived) flags.push(["", "archived"]);
      if (!entry.session.inApp) flags.push(["", "terminal"]);
      return flags;
    };
    let table = h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          columns.map(([key, label]) =>
            h(
              "th",
              {
                onclick: () => {
                  state.sort = { key, desc: state.sort.key === key ? !state.sort.desc : key !== "title" && key !== "model" };
                  render();
                },
              },
              label,
              state.sort.key === key ? (state.sort.desc ? " ▾" : " ▴") : "",
            ),
          ),
        ),
      ),
      h(
        "tbody",
        {},
        rows.slice(0, 400).map((entry) =>
          h(
            "tr",
            { class: state.session === entry.session.id ? "sel" : "", onclick: () => ((state.session = entry.session.id), render()), ondblclick: () => entry.session.localId && ask({ op: "open", sessionId: entry.session.localId }) },
            h("td", { class: "title", title: `${entry.session.title}\n${entry.session.project}` }, entry.session.title, flagsOf(entry).map(([level, text]) => h("span", { class: `flag ${level}` }, text))),
            h("td", {}, entry.model),
            h("td", {}, value(entry.measure)),
            h("td", { class: "muted" }, pct(entry.measure, total)),
            h("td", {}, money(entry.cost)),
            h("td", {}, entry.requests),
            h("td", {}, entry.prompts),
            h("td", {}, entry.prompts ? fmt(entry.perPrompt) : "—"),
            h("td", {}, fmt(entry.lastContext)),
            h("td", {}, fmt(entry.avgContext)),
            h("td", {}, fmt(entry.maxContext)),
            h("td", {}, pct(entry.read, entry.tokens)),
            h("td", {}, entry.subagentTokens ? pct(entry.subagentTokens, entry.tokens) : "—"),
            h("td", {}, fmt(entry.output)),
            h("td", { class: "muted" }, date(entry.lastAt)),
          ),
        ),
      ),
    );

    let header = h(
      "div",
      { class: "bar" },
      h("h1", {}, "Token use"),
      h("span", { class: "muted" }, `${date(data.since, false)} – ${date(Math.min(data.until, Date.now()), false)} · ${data.requests.length.toLocaleString()} requests read ${state.loading ? "· loading…" : ""}`),
      h("span", { style: "flex:1" }),
      seg(
        [["today", "Today"], ["24h", "24 h"], ["3d", "3 d"], ["7d", "7 d"], ["14d", "14 d"], ["30d", "30 d"], ["90d", "90 d"], ["custom", "Custom"]],
        state.period,
        (period) => {
          state.period = period;
          if (period !== "custom") load();
          else render();
        },
      ),
      state.period === "custom" ? h("input", { type: "date", value: state.customFrom, onchange: (event) => ((state.customFrom = event.target.value), load()) }) : null,
      state.period === "custom" ? h("input", { type: "date", value: state.customTo, onchange: (event) => ((state.customTo = event.target.value), load()) }) : null,
      h("button", { onclick: load, title: "Read the transcripts again" }, "↻ Refresh"),
      h("button", { onclick: () => exportCsv(rows) }, "Export CSV"),
    );
    let controls = h(
      "div",
      { class: "panel" },
      h(
        "div",
        { class: "bar" },
        h("span", { class: "label" }, "Measure"),
        seg([["tokens", "Tokens"], ["cost", "Est. cost"], ["requests", "Requests"]], state.metric, (metric) => ((state.metric = metric), render())),
        h("span", { class: "label" }, "Group by"),
        seg([["session", "Session"], ["project", "Project"], ["model", "Model"], ["agent", "Main / subagents"], ["tool", "Tool called"]], state.groupBy, (groupBy) => ((state.groupBy = groupBy), state.hidden.clear(), render())),
        h("span", { class: "label" }, "Buckets"),
        seg([["auto", "Auto"], ["hour", "Hour"], ["day", "Day"], ["week", "Week"]], state.granularity, (granularity) => ((state.granularity = granularity), render())),
      ),
      h(
        "div",
        { class: "bar", style: "margin-top:8px" },
        h("span", { class: "label" }, "Subagents"),
        seg([["include", "Include"], ["exclude", "Exclude"], ["only", "Only"]], state.subagents, (subagents) => ((state.subagents = subagents), render())),
        h("label", { class: "label" }, h("input", { type: "checkbox", checked: state.archived, onchange: (event) => ((state.archived = event.target.checked), render()) }), " archived sessions"),
        h("span", { class: "label" }, "Min context per request"),
        h(
          "select",
          { onchange: (event) => ((state.minContext = Number(event.target.value)), render()) },
          [0, 50e3, 100e3, 200e3, 300e3, 500e3].map((v) => h("option", { value: v, selected: state.minContext === v }, v ? `≥ ${fmt(v)}` : "any")),
        ),
        h("input", {
          type: "search",
          placeholder: "Search sessions, folders, branches",
          value: state.search,
          oninput: (event) => {
            state.search = event.target.value;
            clearTimeout(window.searchTimer);
            window.searchTimer = setTimeout(render, 200);
          },
        }),
        state.projects.size || state.models.size || state.excludedProjects.size || state.search || state.minContext || state.subagents !== "include"
          ? h("button", { onclick: () => (state.projects.clear(), state.models.clear(), state.excludedProjects.clear(), (state.search = ""), (state.minContext = 0), (state.subagents = "include"), render()) }, "Clear filters")
          : null,
      ),
      h("div", { class: "grid2", style: "margin-top:8px" }, chipFilter("Projects", projectChips, state.projects, state.excludedProjects, render), chipFilter("Models", modelChips, state.models, null, render)),
    );
    let kpis = h(
      "div",
      { class: "kpis" },
      [
        [fmt(tokens), "tokens", `${allStats.length} sessions`],
        [money(cost), "est. cost at API prices", "not what a plan bills"],
        [requests.length.toLocaleString(), "requests", `${fmt(tokens / Math.max(1, requests.length))} per request`],
        [fmt(avgContext), "avg context per request", `nudge at ${fmt(data.nudgeTokens)}`],
        [pct(read, tokens), "cache reads", fmt(read)],
        [fmt(output), "output tokens", pct(output, tokens)],
        [fmt((tokens / span) * DAY), "tokens per day", `${money((cost / span) * DAY)} per day`],
        [String(data.prompts.length), "messages you sent", data.prompts.length ? `${fmt(tokens / data.prompts.length)} per message` : ""],
      ].map(([v, label, sub]) => h("div", { class: "kpi" }, h("div", { class: "v" }, v), h("div", {}, label), h("div", { class: "s" }, sub))),
    );
    let levels = ["high", "medium", "info"].map((level) => [level, warns.filter((warning) => warning.level === level).length]).filter(([, count]) => count);
    let shownWarnings = state.allWarnings ? warns : warns.slice(0, 6);
    let warnPanel = h(
      "div",
      { class: "panel" },
      h(
        "div",
        { class: "bar", style: "margin-bottom:8px" },
        h("h2", { style: "margin:0" }, `Warnings (${warns.length})`),
        levels.map(([level, count]) => h("span", { class: `flag ${level}` }, `${count} ${level}`)),
        h("span", { style: "flex:1" }),
        warns.length > 6 ? h("button", { onclick: () => ((state.allWarnings = !state.allWarnings), render()) }, state.allWarnings ? "Show the top 6" : `Show all ${warns.length}`) : null,
      ),
      warns.length
        ? h(
            "div",
            { class: "warns" },
            shownWarnings.map((warning) => {
              let text = h("div", { class: "t" });
              text.innerHTML = warning.text;
              let acts = h("div", { class: "acts" });
              if (warning.session) {
                acts.append(h("button", { onclick: () => ((state.session = warning.session.id), render()) }, "Details"));
                if (warning.session.localId) {
                  for (let op of warning.actions ?? []) {
                    acts.append(h("button", { onclick: () => ask({ op, sessionId: warning.session.localId }) }, op === "compact" ? "Compact now" : "Start fresh"));
                  }
                }
              }
              return h("div", { class: `warn ${warning.level}` }, text, acts);
            }),
          )
        : h("div", { class: "muted" }, "Nothing stands out."),
    );
    let selected = state.session ? stats.get(state.session) : null;
    app.replaceChildren(
      header,
      controls,
      kpis,
      warnPanel,
      ...(selected ? [detailBox] : []),
      h(
        "div",
        { class: "grid2" },
        h(
          "div",
          { class: "panel" },
          h("h2", {}, `Over time, by ${state.groupBy === "agent" ? "main / subagents" : state.groupBy}`),
          timelineBox,
          h(
            "div",
            { class: "legend" },
            [...topKeys, ...(ranked.length > topKeys.length ? ["Other"] : [])].map((key) => {
              let item = h("span", { class: state.hidden.has(key) ? "muted" : "", title: groupLabel(key) }, h("i", { style: `background:${colors.get(key)}` }), groupLabel(key).slice(0, 34));
              item.addEventListener("click", () => {
                state.hidden.has(key) ? state.hidden.delete(key) : state.hidden.add(key);
                render();
              });
              return item;
            }),
          ),
        ),
        h("div", { class: "panel" }, h("h2", {}, `Share by ${state.groupBy === "agent" ? "main / subagents" : state.groupBy}`), sharesBox),
      ),
      h(
        "div",
        { class: "grid3" },
        h("div", { class: "panel" }, h("h2", {}, "Kinds of tokens"), kindsBox),
        h("div", { class: "panel" }, h("h2", {}, "Context size per request"), histogramBox, h("div", { class: "muted", style: "font-size:11.5px" }, "Main conversations only. Red: past the nudge threshold.")),
        h("div", { class: "panel" }, h("h2", {}, "When (weekday × hour)"), heatmapBox),
      ),
      h("div", { class: "panel" }, h("h2", {}, `Sessions (${rows.length}) — click for details, double-click to open`), rows.length ? h("div", { class: "tablewrap" }, table) : h("div", { class: "empty" }, "No requests match these filters.")),
      h("div", { id: "toast" }),
    );
    requestAnimationFrame(() => {
      drawTimeline(timelineBox, requests, topKeys, colors);
      drawShares(sharesBox, ranked, colors, total);
      drawHistogram(histogramBox, requests);
      drawHeatmap(heatmapBox, requests);
      drawKinds(kindsBox, requests);
      if (selected) drawSessionDetail(detailBox, selected, requests);
    });
  }
  function exportCsv(rows) {
    let header = ["session", "project", "branch", "model", "tokens", "est_cost_usd", "requests", "messages", "input", "cache_write", "cache_read", "output", "subagent_tokens", "context_now", "avg_context", "max_context", "first", "last"];
    let quote = (text) => `"${String(text).replace(/"/g, '""')}"`;
    let lines = [header.join(",")].concat(
      rows.map((entry) =>
        [quote(entry.session.title), quote(entry.session.project), quote(entry.session.branch ?? ""), entry.model, entry.tokens, entry.cost.toFixed(4), entry.requests, entry.prompts, entry.input, entry.write, entry.read, entry.output, entry.subagentTokens, entry.lastContext, Math.round(entry.avgContext), entry.maxContext, new Date(entry.firstAt).toISOString(), new Date(entry.lastAt).toISOString()].join(","),
      ),
    );
    let link = h("a", { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })), download: `token-use-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
  }
  tip = h("div", { id: "tip" });
  document.body.append(tip);
  addEventListener("resize", () => {
    clearTimeout(window.resizeTimer);
    window.resizeTimer = setTimeout(render, 150);
  });
  render();
  load();
}
try {
  powertoysHandle("openDashboard", () => powertoysOpenDashboard());
} catch (caught) {
  logger.error("[powertoys] registering the dashboard IPC failed: %o", caught);
}
