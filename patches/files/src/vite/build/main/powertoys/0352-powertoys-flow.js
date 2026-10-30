
// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the ticket-to-PR flow and keeping many sessions in hand.
//
// - Start from a ticket: a new session in the ticket's project, told to fetch the ticket and branch.
// - Fix CI, review comments, ticket status: prompts queued to the session that owns the PR (they go
//   when it is idle, through the prompt queue). Ticket status follows the PR by itself: ready for
//   review -> ticketStatusOnReady, merged -> ticketStatusOnMerged (the session moves it, with its
//   Notion tools; Powertoys has no Notion access of its own).
// - Broadcast, most urgent session, a digest of "finished" notifications, the day's timeline,
//   worktrees, cost and context warnings, per-project instructions.
// ---------------------------------------------------------------------------------------------

/** Queues `text` for a session and sends it at once when the session is idle. */
function powertoysQueuePrompt(sessionId, text, why) {
  powertoysQueueChange(sessionId, "add", text);
  powertoysSendQueued(sessionId, why).catch((caught) => powertoysWarn(`queue: sending to ${sessionId} failed: ${caught.message}`));
}
/** Runs a command and resolves its stdout (rejects with stderr). */
function powertoysExec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    require("node:child_process").execFile(
      command,
      args,
      { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60000, ...options },
      (error, stdout, stderr) => (error ? reject(Error(String(stderr || error.message).trim().slice(0, 500))) : resolve(String(stdout))),
    );
  });
}
/** The sessions bound to a PR ("owner/repo#123"). */
function powertoysSessionsOfPr(repo, number) {
  return [...powertoysSessionViews.values()].filter((view) =>
    (view.prs ?? []).some((pr) => !pr.dismissed && String(pr.repo).toLowerCase() === String(repo).toLowerCase() && String(pr.prNumber) === String(number)),
  );
}
async function powertoysTicketOf(sessionId) {
  let view = powertoysSessionViews.get(sessionId);
  let record = powertoysSessionManager()?.sessions.get(sessionId);
  let cliSessionId = record?.cliSessionId ?? record?.unarchivedCliSessionId;
  let topic = cliSessionId ? await powertoysTranscripts("topic", { cliSessionId }).catch(() => null) : null;
  return powertoysPickTicket(topic, view ? powertoysSessionTitle(view) : "", view);
}

// --- New sessions started from outside the page (Slack Powertoys' newSession, Start from ticket) ---------
// A session the page starts carries what the page knows (connectors, MCP servers, model, effort, the tools
// it allows). The last start request the page sent is kept per folder (LocalSessions.start, see
// ccd-local-sessions-api), and a new session started here is that request with its own folder, prompt and
// permission mode, through the same start call, so it is set up as one started in the app.
const POWERTOYS_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"];
const POWERTOYS_START_ONLY_FIELDS = ["message", "sessionId", "title", "typedText", "editedDraftText", "attachments", "images", "pastes", "messageUuid", "sessionMentions", "scheduledTaskId", "scheduledTaskManualStart", "sourceBranch", "branchHint"];
const powertoysStartTemplates = new Map(); // folder (lower case) or "" -> { request, start }
function powertoysNoteStartRequest(request, start) {
  // A local start can carry a remoteTarget too ({ kind: "local" }); only SSH and WSL ones are remote.
  let remote = request?.sshConfig || toSshConnectionConfig(request?.remoteTarget) || toWslConnectionConfig(request?.remoteTarget);
  if (!request || typeof request !== "object" || request.powertoysStarted || request.scheduledTaskId || remote) {
    return;
  }
  if (!powertoysStartTemplates.has(powertoysWindowsPath(String(request.cwd ?? "")).toLowerCase())) {
    powertoysLog(`new sessions: keeping the page's start request for ${request.cwd} (${Object.keys(request).length} fields)`);
  }
  let template = { ...request };
  for (let field of POWERTOYS_START_ONLY_FIELDS) {
    delete template[field];
  }
  let entry = { request: template, start };
  powertoysStartTemplates.set(powertoysWindowsPath(String(request.cwd ?? "")).toLowerCase(), entry);
  powertoysStartTemplates.set("", entry);
  powertoysSaveStartTemplates(start);
}
/**
 * Kept on disk too (start-templates.json), so other programs can start sessions right after a restart, before the
 * page has started one; anything named like a credential is left out, at every depth.
 */
const POWERTOYS_SECRET_KEY = /token|secret|auth|header|password|cookie|key$/i;
function powertoysWithoutSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(powertoysWithoutSecrets);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !POWERTOYS_SECRET_KEY.test(key)).map(([key, inner]) => [key, powertoysWithoutSecrets(inner)]));
  }
  return value;
}
let powertoysStartFunction = null; // the page's LocalSessions.start, once it has been called
function powertoysSaveStartTemplates(start) {
  powertoysStartFunction = start;
  let saved = Object.fromEntries([...powertoysStartTemplates].map(([folder, entry]) => [folder, powertoysWithoutSecrets(entry.request)]));
  powertoysWriteJson("start-templates.json", saved);
}
/** A template kept from an earlier run, started through the page's start call (available once the page has loaded). */
function powertoysSavedStartTemplate(folder) {
  let saved = powertoysReadJson("start-templates.json", {});
  let request = saved[folder] ?? saved[""];
  let start = powertoysStartFunction ?? powertoysLocalSessionsStart;
  return request && start ? { request, start } : null;
}
let powertoysLocalSessionsStart = null; // set by ccd-local-sessions-api when the page's API is created
function powertoysNoteLocalSessionsApi(start) {
  powertoysLocalSessionsStart = start;
}
Object.defineProperty(exports, "powertoysNoteLocalSessionsApi", { enumerable: true, get: () => powertoysNoteLocalSessionsApi });
Object.defineProperty(exports, "powertoysNoteStartRequest", { enumerable: true, get: () => powertoysNoteStartRequest });
/** { folder, text, permissionMode? } -> { sessionId, cliSessionId, cwd }: a new Code session that has been sent `text`. */
async function powertoysNewSession({ folder, text, permissionMode } = {}) {
  let cwd = powertoysWindowsPath(String(folder ?? "").trim());
  let prompt = String(text ?? "").trim();
  if (!/^(?:[A-Za-z]:\\|\\\\)/.test(cwd) || !powertoysFs.existsSync(cwd)) {
    throw Error(`Not a folder on this computer: ${folder}`);
  }
  if (!prompt) {
    throw Error("A new session needs a first message (text)");
  }
  if (permissionMode !== undefined && !POWERTOYS_PERMISSION_MODES.includes(permissionMode)) {
    throw Error(`Unknown permission mode "${permissionMode}" (one of ${POWERTOYS_PERMISSION_MODES.join(", ")})`);
  }
  let template = powertoysStartTemplates.get(cwd.toLowerCase()) ?? powertoysStartTemplates.get("") ?? powertoysSavedStartTemplate(cwd.toLowerCase());
  if (!template) {
    throw Error("No session has been started in Claude Desktop since it started, so there are no settings to start one with");
  }
  let sessionId = `local_${require("node:crypto").randomUUID()}`;
  let request = { ...template.request, cwd, message: prompt, sessionId, powertoysStarted: true, ...(permissionMode && { permissionMode }) };
  powertoysLog(`new session ${sessionId} in ${cwd}${permissionMode ? ` (${permissionMode})` : ""}`);
  let started = template.start(request).catch((caught) => {
    powertoysWarn(`new session ${sessionId} failed to start: ${caught.message}`);
    throw caught;
  });
  // Answered as soon as the session exists with its CLI id (Slack waits a few seconds), not when it has spawned.
  let manager = powertoysSessionManager();
  for (let waited = 0; waited < 15000; waited += 100) {
    let record = manager?.sessions.get(sessionId);
    if (record?.cliSessionId) {
      powertoysOpenSession(sessionId);
      return { sessionId, cliSessionId: record.cliSessionId, cwd: record.cwd ?? cwd };
    }
    let failure = await Promise.race([started.then(() => null, (caught) => caught), new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
    if (failure) {
      throw failure;
    }
  }
  throw Error("The session did not start within 15 s");
}
/** The Code conversation on screen now: { sessionId, cliSessionId, cwd, title } or null. */
function powertoysSelectedSession() {
  let sessionId = powertoysRouteSessionId();
  let record = sessionId ? powertoysSessionManager()?.sessions.get(sessionId) : null;
  let view = sessionId ? powertoysSessionViews.get(sessionId) : null;
  return record
    ? { sessionId, cliSessionId: record.cliSessionId ?? record.unarchivedCliSessionId ?? null, cwd: record.cwd ?? null, title: view ? powertoysSessionTitle(view) : record.title ?? "" }
    : null;
}

// --- 1. Start from a ticket -----------------------------------------------------------------------
/** The folder a ticket's sessions start in: ticketProjects { "ISS": "E:\\…" }, else the one given. */
function powertoysTicketFolder(ticketId, fallbackFolder) {
  let prefix = String(ticketId).split("-")[0].toUpperCase();
  let mapped = (powertoysSetting("ticketProjects") ?? {})[prefix];
  return powertoysWindowsPath(typeof mapped === "string" && mapped ? mapped : fallbackFolder || "");
}
function powertoysStartFromTicket(ticketId, fallbackFolder) {
  let id = String(ticketId ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(id)) {
    throw Error("A ticket ID looks like ISS-1234");
  }
  let folder = powertoysTicketFolder(id, fallbackFolder);
  if (!folder) {
    throw Error(`No folder for ${id}: open a session in its project first, or set ticketProjects in the settings file`);
  }
  let prompt = String(powertoysSetting("ticketPrompt") || POWERTOYS_TICKET_PROMPT).replace(/\{id\}/g, id);
  powertoysLog(`start from ticket ${id} in ${folder}`);
  return powertoysNewSession({ folder, text: prompt }).then(
    () => ({ id, folder }),
    (caught) => {
      // Without a start request to model it on, the app's own link opens it (prefilled, not yet sent).
      powertoysWarn(`start from ticket: ${caught.message}; opening the new-session link instead`);
      handleClaudeDeepLinkWhenMainViewReady(`${getCcdProtocolScheme(false)}//code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(prompt)}`);
      return { id, folder, prefilled: true };
    },
  );
}
const POWERTOYS_TICKET_PROMPT =
  "Work on Notion ticket {id}. Fetch it with the Notion tools and read its description, acceptance criteria and comments. " +
  "Then create a branch named {id}-<a short slug of its title> from the up-to-date default branch (or check it out if it exists), " +
  "make a plan with an estimate per step, and implement it.";

// --- 2. Fix CI ---------------------------------------------------------------------------------------
function powertoysFixCi(sessionId) {
  let view = powertoysSessionViews.get(sessionId);
  let pr = powertoysSessionPrs(view).find((each) => /fail|error/i.test(String(each.checks)));
  if (!pr) {
    throw Error("This session has no PR with failing checks");
  }
  let text =
    `CI failed on PR #${pr.number} (${pr.url || pr.repo}). List the failing checks with \`gh pr checks ${pr.number} --repo ${pr.repo}\`, ` +
    `read their logs with \`gh run view <run id> --log-failed --repo ${pr.repo}\`, find the cause, fix it, push, and watch the checks again.`;
  powertoysQueuePrompt(sessionId, text, "fix CI");
  return pr.number;
}

// --- 3. Review comments to answer ---------------------------------------------------------------------
const POWERTOYS_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body url createdAt}}}}}}}";
/** Unresolved review threads on every open PR of a session: [{ sessionId, title, pr, path, line, author, body, url, replies }]. */
async function powertoysReviewThreads() {
  let found = [];
  let seen = new Set();
  for (let view of powertoysSessionViews.values()) {
    if (view.isArchived) {
      continue;
    }
    for (let pr of powertoysSessionPrs(view)) {
      let key = `${pr.repo}#${pr.number}`.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      let [owner, name] = String(pr.repo).split("/");
      let json = await powertoysExec("gh", ["api", "graphql", "-f", `query=${POWERTOYS_THREADS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pr.number}`]).catch((caught) => {
        powertoysWarn(`review comments of ${key}: ${caught.message}`);
        return null;
      });
      let threads = json ? JSON.parse(json)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [] : [];
      for (let thread of threads.filter((each) => !each.isResolved)) {
        let comments = thread.comments?.nodes ?? [];
        let first = comments[0];
        if (!first) {
          continue;
        }
        found.push({
          sessionId: view.sessionId,
          title: powertoysSessionTitle(view),
          pr: pr.number,
          repo: pr.repo,
          path: thread.path ?? "",
          line: thread.line ?? null,
          outdated: thread.isOutdated === true,
          author: first.author?.login ?? "",
          body: String(first.body ?? ""),
          url: comments.at(-1)?.url ?? first.url ?? "",
          replies: comments.length - 1,
          at: comments.at(-1)?.createdAt ?? first.createdAt ?? "",
        });
      }
    }
  }
  return found.sort((left, right) => String(right.at).localeCompare(String(left.at)));
}
function powertoysSendReviewThread(thread) {
  let where = thread.path ? ` on ${thread.path}${thread.line ? `:${thread.line}` : ""}` : "";
  let text =
    `Review comment from ${thread.author || "a reviewer"} on PR #${thread.pr}${where} (${thread.url}):\n\n${String(thread.body).slice(0, 4000)}\n\n` +
    "Address it: change the code if it is right, then reply on the thread (gh) saying what you did, or why not.";
  powertoysQueuePrompt(String(thread.sessionId), text, "review comment");
}

// --- 4. The ticket's status follows its PR -------------------------------------------------------------
/** Last seen state per PR ("owner/repo#123" -> "draft" | "open" | "merged" | "closed"), kept across restarts. */
let powertoysPrStates = null;
function powertoysPrStateOf(details) {
  let state = String(details?.state ?? "").toUpperCase();
  return state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : state === "OPEN" ? (details?.isDraft ? "draft" : "open") : "";
}
async function powertoysOnPrChanged(rows) {
  powertoysPrStates ??= powertoysReadJson("pr-states.json", {});
  let changed = false;
  for (let row of rows) {
    let state = powertoysPrStateOf(row?.details);
    let key = `${row?.repo}#${row?.identifier}`.toLowerCase();
    if (!state || !row?.repo || powertoysPrStates[key] === state) {
      continue;
    }
    let before = powertoysPrStates[key];
    powertoysPrStates[key] = state;
    changed = true;
    // Only a change seen while the app runs moves a ticket (a PR first seen merged does not).
    let status =
      before === "draft" && state === "open"
        ? powertoysSetting("ticketStatusOnReady")
        : (before === "draft" || before === "open") && state === "merged"
          ? powertoysSetting("ticketStatusOnMerged")
          : "";
    if (!before || !status || powertoysSetting("autoTicketStatus") === false) {
      continue;
    }
    for (let view of powertoysSessionsOfPr(row.repo, row.identifier)) {
      let ticket = await powertoysTicketOf(view.sessionId);
      if (!ticket?.id) {
        powertoysLog(`ticket status: PR ${key} is ${state}, but ${view.sessionId} has no ticket`);
        continue;
      }
      let event = state === "merged" ? "was merged" : "is ready for review";
      powertoysLog(`ticket status: PR ${key} ${event}; asking ${view.sessionId} to set ${ticket.id} to "${status}"`);
      powertoysQueuePrompt(
        view.sessionId,
        `PR #${row.identifier} ${event}. With the Notion tools, set the Status of ticket ${ticket.id} to "${status}", unless it is already at that status or a later one. Change nothing else, and reply in one line.`,
        "ticket status",
      );
    }
  }
  if (changed) {
    powertoysWriteJson("pr-states.json", powertoysPrStates);
  }
}

// --- 6. Most urgent session; a digest of "finished" notifications -------------------------------------
function powertoysMostUrgent() {
  let waiting = [...powertoysSessionViews.values()]
    .filter((view) => !view.isArchived)
    .map((view) => ({ view, state: powertoysStateOf(view), reason: powertoysWaitReason(view) }))
    .filter((item) => item.state === "needsYou" || item.state === "ciFailed" || item.state === "newReply");
  waiting.sort((left, right) => powertoysUrgency(left) - powertoysUrgency(right) || (powertoysSeenAtOf(left.view) ?? 0) - (powertoysSeenAtOf(right.view) ?? 0));
  return waiting[0] ? { sessionId: waiting[0].view.sessionId, reason: waiting[0].reason } : null;
}
let powertoysDigestHeld = [];
let powertoysDigestTimer = null;
/** Holds a "finished" notification for the digest (finishedDigestMinutes > 0); true when held, not shown. */
function powertoysDigestHold(options) {
  let minutes = Number(powertoysSetting("finishedDigestMinutes")) || 0;
  if (minutes <= 0 || !/^idle/.test(String(options?.data?.type ?? ""))) {
    return false;
  }
  powertoysDigestHeld.push({ title: String(options.title ?? ""), sessionId: powertoysNotificationSessionId(options), at: Date.now() });
  powertoysDigestTimer ??= setTimeout(powertoysShowDigest, minutes * 60000);
  return true;
}
function powertoysShowDigest() {
  powertoysDigestTimer = null;
  let held = powertoysDigestHeld;
  powertoysDigestHeld = [];
  if (held.length === 0) {
    return;
  }
  let names = [...new Set(held.map((item) => item.title).filter(Boolean))];
  notificationBackend.show(
    {
      title: held.length === 1 ? names[0] || "A session finished" : `${held.length} sessions finished`,
      body: names.slice(0, 6).join(" · "),
      tag: "powertoys-digest",
      data: { type: "generic", sessionId: held[0].sessionId ?? undefined },
    },
    (interaction) => {
      if (interaction?.action === "click" && held[0].sessionId) {
        powertoysOpenSession(held[0].sessionId);
      }
    },
  );
}

// --- 7. The day's timeline: when each session worked, waited for you, or rested ----------------------
const powertoysTimelineLast = new Map(); // sessionId -> state last recorded
function powertoysTimelineState(view) {
  let state = powertoysStateOf(view);
  return view.turnRunning ? "working" : state === "needsYou" || state === "ciFailed" ? "waiting" : "idle";
}
function powertoysRecordTimeline() {
  let file = powertoysPath.join(powertoysDir(), "timeline", `${new Date().toLocaleDateString("sv")}.jsonl`);
  let lines = [];
  for (let view of powertoysSessionViews.values()) {
    let state = powertoysTimelineState(view);
    if (powertoysTimelineLast.get(view.sessionId) !== state) {
      powertoysTimelineLast.set(view.sessionId, state);
      lines.push(JSON.stringify({ at: Date.now(), sessionId: view.sessionId, state, title: powertoysSessionTitle(view) }));
    }
  }
  if (lines.length) {
    powertoysFs.mkdirSync(powertoysPath.dirname(file), { recursive: true });
    powertoysFs.appendFileSync(file, `${lines.join("\n")}\n`);
  }
}
/** { day, now, sessions: [{ sessionId, title, spans: [{ state, from, to }] }] } for a day ("YYYY-MM-DD"). */
function powertoysTimeline(day = new Date().toLocaleDateString("sv")) {
  let file = powertoysPath.join(powertoysDir(), "timeline", `${String(day).replace(/[^\d-]/g, "")}.jsonl`);
  let events = powertoysFs.existsSync(file)
    ? powertoysFs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  let end = day === new Date().toLocaleDateString("sv") ? Date.now() : new Date(`${day}T23:59:59`).getTime();
  let bySession = new Map();
  for (let event of events) {
    let item = bySession.get(event.sessionId) ?? { sessionId: event.sessionId, title: event.title, spans: [] };
    let open = item.spans.at(-1);
    if (open && open.to === null) {
      open.to = event.at;
    }
    item.title = event.title || item.title;
    item.spans.push({ state: event.state, from: event.at, to: null });
    bySession.set(event.sessionId, item);
  }
  let sessions = [...bySession.values()]
    .map((item) => ({ ...item, spans: item.spans.map((span) => ({ ...span, to: span.to ?? end })).filter((span) => span.state !== "idle") }))
    .filter((item) => item.spans.length > 0);
  return { day, now: end, sessions };
}

// --- 8. Worktrees: branch, PR state, size, last use; remove the merged ones ----------------------------
async function powertoysWorktrees() {
  let { gitWorktreeManager } = await Promise.resolve().then(() => require("./git-worktree-manager.js"));
  let list = [];
  for (let [name, worktree] of Object.entries(gitWorktreeManager.getWorktrees())) {
    if (!worktree?.path || !powertoysFs.existsSync(worktree.path)) {
      continue;
    }
    let branch = await powertoysExec("git", ["-C", worktree.path, "rev-parse", "--abbrev-ref", "HEAD"]).then((out) => out.trim()).catch(() => "");
    let dirty = await powertoysExec("git", ["-C", worktree.path, "status", "--porcelain"]).then((out) => out.trim().length > 0).catch(() => null);
    let pr = branch && branch !== "HEAD"
      ? await powertoysExec("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,url", "--limit", "1"], { cwd: worktree.path })
          .then((out) => JSON.parse(out)[0] ?? null)
          .catch(() => null)
      : null;
    let lastUsed = 0;
    try {
      lastUsed = powertoysFs.statSync(powertoysPath.join(worktree.path, ".git")).mtimeMs;
    } catch {}
    let view = worktree.leasedBy ? powertoysSessionViews.get(worktree.leasedBy) : null;
    list.push({
      name,
      path: worktree.path,
      branch,
      dirty,
      pr: pr ? { number: pr.number, state: String(pr.state).toLowerCase(), url: pr.url } : null,
      session: view ? { sessionId: view.sessionId, title: powertoysSessionTitle(view), archived: view.isArchived === true } : null,
      lastUsed,
    });
  }
  return list.sort((left, right) => left.lastUsed - right.lastUsed);
}
/** Removes the named worktrees through the app (its records stay right); only clean ones whose PR merged. */
async function powertoysRemoveWorktrees(names) {
  let { gitWorktreeManager } = await Promise.resolve().then(() => require("./git-worktree-manager.js"));
  let current = new Map((await powertoysWorktrees()).map((each) => [each.name, each]));
  let removed = [];
  for (let name of Array.isArray(names) ? names : []) {
    let worktree = current.get(name);
    if (!worktree || worktree.dirty !== false || worktree.pr?.state !== "merged") {
      powertoysWarn(`worktrees: ${name} kept (not clean, or its PR is not merged)`);
      continue;
    }
    if (await gitWorktreeManager.removeWorktreeByName(name)) {
      removed.push(name);
    }
  }
  powertoysLog(`worktrees: removed ${removed.length} of ${names?.length ?? 0}`);
  return removed;
}

// --- 9. Cost and context warnings --------------------------------------------------------------------------
const powertoysWarned = new Map(); // sessionId -> { cost, context } thresholds already warned about
/** { [sessionId]: { cost, contextPercent, over: ["cost" | "context"] } } for the open sessions. */
async function powertoysSessionLimits(sessionIds) {
  let costLimit = Number(powertoysSetting("costWarnUsd")) || 0;
  let contextLimit = Number(powertoysSetting("contextWarnPercent")) || 0;
  let usage = await powertoysUsage(sessionIds).catch(() => null);
  let result = {};
  for (let sessionId of sessionIds) {
    let info = await powertoysStatusInfo(sessionId).catch(() => null);
    let model = String(info?.model ?? "");
    let window = getContextWindowForModel(model, model) ?? (/\[1m\]/i.test(model) ? 1000000 : 200000);
    let cost = usage?.sessions?.[sessionId]?.total?.cost ?? 0;
    let contextPercent = info?.contextTokens ? Math.round((info.contextTokens / window) * 100) : 0;
    let over = [...(costLimit > 0 && cost >= costLimit ? ["cost"] : []), ...(contextLimit > 0 && contextPercent >= contextLimit ? ["context"] : [])];
    result[sessionId] = { cost, contextPercent, over };
    let warned = powertoysWarned.get(sessionId) ?? {};
    for (let kind of over) {
      if (!warned[kind]) {
        warned[kind] = true;
        let view = powertoysSessionViews.get(sessionId);
        notificationBackend.show(
          {
            title: kind === "cost" ? `Over $${costLimit}: ${powertoysSessionTitle(view)}` : `Context ${contextPercent}% full: ${powertoysSessionTitle(view)}`,
            body: kind === "cost" ? `About $${cost.toFixed(2)} so far. Its tab's menu has "Compact now".` : "Its tab's menu has \"Compact now\".",
            tag: `powertoys-limit-${kind}-${sessionId}`,
            data: { type: "generic", sessionId },
          },
          (interaction) => interaction?.action === "click" && powertoysOpenSession(sessionId),
        );
      }
    }
    powertoysWarned.set(sessionId, warned);
  }
  return result;
}

// --- 10. Per-project standing instructions (added to every new session's system prompt) ----------------
function powertoysProjectInstructions(cwd) {
  let folder = powertoysWindowsPath(String(cwd ?? "")).toLowerCase();
  for (let entry of Object.values(powertoysSetting("projectInstructions") ?? {})) {
    let root = typeof entry?.folder === "string" ? powertoysWindowsPath(entry.folder).toLowerCase() : "";
    if (root && entry.enabled !== false && String(entry.text ?? "").trim() && (folder === root || folder.startsWith(`${root}\\`))) {
      return String(entry.text).trim();
    }
  }
  return "";
}
function powertoysApplyProjectInstructions(startOptions) {
  let text = powertoysProjectInstructions(startOptions?.cwd);
  if (text) {
    startOptions.systemPromptAppend = [startOptions.systemPromptAppend, `Project instructions (from the person, for every session in this project):\n${text}`].filter(Boolean).join("\n\n");
    powertoysLog(`new session in ${startOptions.cwd}: project instructions added (${text.length} characters)`);
  }
}
Object.defineProperty(exports, "powertoysApplyProjectInstructions", { enumerable: true, get: () => powertoysApplyProjectInstructions });
function powertoysSetProjectInstructions(key, folder, text, enabled) {
  let all = { ...(powertoysSetting("projectInstructions") ?? {}) };
  if (String(text ?? "").trim()) {
    all[key] = { folder: powertoysWindowsPath(folder), text: String(text), enabled: enabled !== false };
  } else {
    delete all[key];
  }
  powertoysSetSetting("projectInstructions", all);
  return all;
}


// --- Start-up and IPC --------------------------------------------------------------------------------------------
function powertoysStartFlow() {
  getForgeStateTracker().subscribe((rows) => powertoysOnPrChanged(rows).catch((caught) => powertoysWarn(`ticket status: ${caught.message}`)));
  setInterval(powertoysRecordTimeline, 15000).unref();
}
try {
  powertoysHandle("startFromTicket", (event, ticketId, folder) => powertoysStartFromTicket(ticketId, folder));
  powertoysHandle("fixCi", (event, sessionId) => powertoysFixCi(String(sessionId ?? "")));
  powertoysHandle("reviewThreads", () => powertoysReviewThreads());
  powertoysHandle("sendReviewThread", (event, thread) => powertoysSendReviewThread(thread));
  powertoysHandle("broadcast", (event, sessionIds, text) => {
    for (let sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
      powertoysQueuePrompt(String(sessionId), String(text ?? ""), "broadcast");
    }
    return sessionIds.length;
  });
  powertoysHandle("mostUrgent", () => powertoysMostUrgent());
  powertoysHandle("dayTimeline", (event, day) => powertoysTimeline(day ?? undefined));
  powertoysHandle("worktrees", () => powertoysWorktrees());
  powertoysHandle("removeWorktrees", (event, names) => powertoysRemoveWorktrees(names));
  powertoysHandle("sessionLimits", (event, sessionIds) => powertoysSessionLimits(Array.isArray(sessionIds) ? sessionIds.map(String) : []));
  powertoysHandle("compactNow", (event, sessionId) => powertoysQueuePrompt(String(sessionId), "/compact", "compact now"));
  powertoysHandle("projectInstructions", (event, key, folder, text, enabled) => powertoysSetProjectInstructions(String(key), String(folder), text, enabled));
} catch (caught) {
  logger.error("[powertoys] registering the flow IPC failed: %o", caught);
}
