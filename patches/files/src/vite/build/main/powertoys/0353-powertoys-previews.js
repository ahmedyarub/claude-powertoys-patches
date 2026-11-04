
// --- Link previews: Slack messages, GitHub PRs and Notion pages linked in a conversation ------------------
// The page shows a compact card under the link and a fuller one on hover (linkPreviews); this reads them:
// Slack through Slack Powertoys' bridge (Slack must be running), GitHub through gh, Notion through the claude.ai Notion
// connector (notionPreviewsViaConnector: its notion-fetch tool, called as the app calls connector tools for Code
// sessions, through claude.ai with the app's sign-in) or the API with an internal integration's token (notion-token.txt in the Powertoys folder, never sent
// to the page).
const POWERTOYS_PREVIEW_TTL = 5 * 60 * 1000;
const powertoysPreviewCache = new Map(); // url -> { at, promise }
const POWERTOYS_NOTION_TOKEN_FILE = "notion-token.txt";
const POWERTOYS_NOTION_VERSION = "2022-06-28";
/** The kind of a link the previews know: { kind: "slack" | "github" | "notion", … } or null. */
function powertoysPreviewKind(url) {
  let link;
  try {
    link = new URL(String(url));
  } catch {
    return null;
  }
  if (/(^|\.)slack\.com$/i.test(link.hostname) && /^\/archives\/[A-Z0-9]+\/p\d{16}$/i.test(link.pathname)) {
    return { kind: "slack" };
  }
  let pr = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(link.pathname);
  if (/^(www\.)?github\.com$/i.test(link.hostname) && pr) {
    return { kind: "github", repo: `${pr[1]}/${pr[2]}`, number: Number(pr[3]) };
  }
  let page = /([0-9a-f]{32})(?![0-9a-f])/i.exec(link.pathname.replace(/-/g, ""))?.[1];
  if (/(^|\.)notion\.(so|site|com)$/i.test(link.hostname) && page) {
    return { kind: "notion", pageId: page.toLowerCase() };
  }
  return null;
}
/** A link's preview (see the readers below), cached for 5 minutes; a failed read is not kept. */
function powertoysLinkPreview(url) {
  let kind = powertoysPreviewKind(url);
  if (!kind) {
    throw Error("Not a Slack message, GitHub PR or Notion page link");
  }
  let cached = powertoysPreviewCache.get(url);
  if (cached && Date.now() - cached.at < POWERTOYS_PREVIEW_TTL) {
    return cached.promise;
  }
  let read =
    kind.kind === "slack"
      ? powertoysSlackPreview(url)
      : kind.kind === "github"
        ? powertoysGithubPreview(kind)
        : powertoysSettings().notionPreviewsViaConnector
          ? powertoysNotionConnectorPreview(kind.pageId)
          : powertoysNotionPreview(kind.pageId);
  let promise = read.then(
    (preview) => ({ kind: kind.kind, ...preview }),
    (caught) => {
      powertoysPreviewCache.delete(url);
      powertoysLog(`link preview: ${kind.kind} ${url} failed: ${caught.message}`);
      throw caught;
    },
  );
  powertoysPreviewCache.set(url, { at: Date.now(), promise });
  return promise;
}
/**
 * { workspace, conversation, messages: [root, then the last 3 replies] as { author, time, avatar, html, files }, replyCount }
 * from Slack Powertoys (rich=1: blocks, names, avatars, image thumbnails, when its bridge has them).
 */
async function powertoysSlackPreview(url) {
  let config;
  try {
    config = JSON.parse(powertoysFs.readFileSync(powertoysPath.join(electron.app.getPath("appData"), "Slack", "powertoys", "bridge.json"), "utf8"));
  } catch {
    throw Error("Slack is not running (Slack Powertoys' bridge is off)");
  }
  let response = await electron.net.fetch(`http://127.0.0.1:${config.port}/thread?${new URLSearchParams({ link: url, rich: 1 })}`, {
    headers: { authorization: `Bearer ${config.token}` },
  });
  let body = await response.json();
  if (!response.ok) {
    throw Error(body.error ?? `Slack answered HTTP ${response.status}`);
  }
  let [first, ...rest] = body.messages ?? [];
  return {
    workspace: body.workspace,
    conversation: body.conversation,
    messages: [first, ...rest.slice(-3)].filter(Boolean).map(powertoysSlackMessageHtml),
    replyCount: rest.length,
  };
}
// gh reads as its active account; a repository only another signed-in account can see is read as that one.
const powertoysGhOwnerLogins = new Map(); // owner -> the gh login that reads it ("" = the active account)
async function powertoysGhRead(repo, args) {
  let owner = repo.split("/")[0].toLowerCase();
  let run = async (login) => powertoysExec("gh", args, login ? { env: { ...process.env, GH_TOKEN: (await powertoysExec("gh", ["auth", "token", "--user", login])).trim() } } : {});
  if (powertoysGhOwnerLogins.has(owner)) {
    return run(powertoysGhOwnerLogins.get(owner));
  }
  try {
    let out = await run("");
    powertoysGhOwnerLogins.set(owner, "");
    return out;
  } catch (caught) {
    if (!/Could not resolve to a Repository|HTTP 404|Not Found/i.test(caught.message)) {
      throw caught;
    }
    let accounts = JSON.parse(await powertoysExec("gh", ["auth", "status", "--json", "hosts"])).hosts?.["github.com"] ?? [];
    for (let account of accounts.filter((each) => !each.active && each.state === "success")) {
      let out = await run(account.login).catch(() => null);
      if (out !== null) {
        powertoysGhOwnerLogins.set(owner, account.login);
        powertoysLog(`link preview: ${owner}'s repositories are read as gh account ${account.login}`);
        return out;
      }
    }
    throw caught;
  }
}
/** A PR as GitHub shows it: state, author and avatar, branches, labels with their colors, checks, size, its description rendered. */
async function powertoysGithubPreview({ repo, number }) {
  let view = JSON.parse(await powertoysGhRead(repo, ["pr", "view", String(number), "--repo", repo, "--json", "title,state,isDraft,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,headRefName,baseRefName"]));
  let api = JSON.parse(await powertoysGhRead(repo, ["api", `repos/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.full+json"]));
  let checks = { passed: 0, failed: 0, pending: 0, failedNames: [] };
  for (let check of view.statusCheckRollup ?? []) {
    let result = String(check.conclusion ?? check.state ?? "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result)) {
      checks.passed += 1;
    } else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result)) {
      checks.failed += 1;
      checks.failedNames.push(check.name ?? check.context ?? "?");
    } else {
      checks.pending += 1;
    }
  }
  // The description as GitHub renders it; its images (signed for a few minutes) are inlined now.
  let sources = [];
  let html = String(api.body_html ?? "").replace(/<img\b([^>]*?)\ssrc="([^"]+)"([^>]*)>/g, (whole, before, src, after) => `<img data-pt-image="${sources.push(src.replace(/&amp;/g, "&")) - 1}"${before}${after}>`);
  html = await powertoysInlineImages(html, sources, (wanted) => Promise.all(wanted.map((src) => powertoysImageData(src).catch(() => null))));
  let avatar = api.user?.avatar_url ? await powertoysImageData(`${api.user.avatar_url}${api.user.avatar_url.includes("?") ? "&" : "?"}s=64`).catch(() => null) : null;
  return {
    repo,
    number,
    title: view.title,
    state: view.isDraft && view.state === "OPEN" ? "DRAFT" : view.state,
    author: api.user?.login ?? "",
    avatar,
    head: view.headRefName,
    base: view.baseRefName,
    commits: api.commits ?? 0,
    comments: (api.comments ?? 0) + (api.review_comments ?? 0),
    createdAt: api.created_at,
    mergedAt: api.merged_at,
    additions: view.additions,
    deletions: view.deletions,
    changedFiles: view.changedFiles,
    reviewDecision: view.reviewDecision ?? "",
    checks,
    labels: (api.labels ?? []).map((label) => ({ name: label.name, color: /^[0-9a-f]{6}$/i.test(label.color ?? "") ? label.color : "8b949e" })),
    html,
  };
}
function powertoysNotionToken() {
  try {
    return powertoysFs.readFileSync(powertoysFile(POWERTOYS_NOTION_TOKEN_FILE), "utf8").trim() || null;
  } catch {
    return null;
  }
}
async function powertoysNotionApi(token, route) {
  let response = await electron.net.fetch(`https://api.notion.com/v1/${route}`, {
    headers: { authorization: `Bearer ${token}`, "notion-version": POWERTOYS_NOTION_VERSION },
  });
  let body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(
      response.status === 404
        ? "Notion: page not found, or not shared with the Powertoys integration (share its database with it in Notion)"
        : `Notion: ${body.message ?? `HTTP ${response.status}`}`,
    );
  }
  return body;
}
/** A property's value as text ("" when it has none). */
function powertoysNotionValue(property) {
  let text = (parts) => (parts ?? []).map((part) => part.plain_text).join("");
  switch (property?.type) {
    case "title":
      return text(property.title);
    case "rich_text":
      return text(property.rich_text);
    case "status":
      return property.status?.name ?? "";
    case "select":
      return property.select?.name ?? "";
    case "multi_select":
      return property.multi_select.map((option) => option.name).join(", ");
    case "people":
      return property.people.map((person) => person.name ?? "").filter(Boolean).join(", ");
    case "unique_id":
      return property.unique_id?.number == null ? "" : `${property.unique_id.prefix ? `${property.unique_id.prefix}-` : ""}${property.unique_id.number}`;
    case "date":
      return property.date?.start ?? "";
    case "checkbox":
      return property.checkbox ? "yes" : "";
    case "number":
      return property.number == null ? "" : String(property.number);
    default:
      return "";
  }
}
/** { id, title, status, fields: [[name, value]] (selects, people, dates), text: its first blocks as plain text }. */
async function powertoysNotionPreview(pageId) {
  let token = powertoysNotionToken();
  if (!token) {
    throw Error("No Notion token: set one in Settings (Powertoys) to preview Notion links");
  }
  let [page, blocks] = await Promise.all([powertoysNotionApi(token, `pages/${pageId}`), powertoysNotionApi(token, `blocks/${pageId}/children?page_size=40`)]);
  let properties = Object.entries(page.properties ?? {});
  let title = powertoysNotionValue(properties.find(([, property]) => property.type === "title")?.[1]);
  let id = powertoysNotionValue(properties.find(([, property]) => property.type === "unique_id")?.[1]);
  let status = powertoysNotionValue(properties.find(([, property]) => property.type === "status")?.[1]);
  let fields = properties
    .filter(([, property]) => ["select", "multi_select", "people", "date"].includes(property.type))
    .map(([name, property]) => [name, powertoysNotionValue(property)])
    .filter(([, value]) => value);
  let lines = [];
  for (let block of blocks.results ?? []) {
    let rich = block[block.type]?.rich_text;
    if (!rich) {
      continue;
    }
    let line = rich.map((part) => part.plain_text).join("");
    let prefix = { heading_1: "# ", heading_2: "## ", heading_3: "### ", bulleted_list_item: "- ", numbered_list_item: "1. ", to_do: block.to_do?.checked ? "- [x] " : "- [ ] ", quote: "> " }[block.type] ?? "";
    if (line.trim()) {
      lines.push(prefix + line);
    }
  }
  return { id, title, status, fields, text: lines.join("\n").slice(0, 1500), url: page.url };
}
// --- Notion through the claude.ai connector: the one a Code session has (its uuid and account), called through claude.ai.
/** { uuid, name, account: { accountId, orgId } } of the claude.ai connector with notion-fetch, from a session that has it. */
function powertoysNotionConnector() {
  let manager = powertoysSessionManager();
  for (let [sessionId, record] of manager?.sessions ?? []) {
    let server = (record.remoteMcpServersConfig ?? []).find((each) => (each.tools ?? []).some((tool) => tool.name === "notion-fetch"));
    let account = server ? manager.mcpCoordinator?.recordedSessionAccount(sessionId) : null;
    if (account?.accountId && account.orgId) {
      return { uuid: server.uuid, name: server.name, account };
    }
  }
  throw Error("No Code session open in this app run has the claude.ai Notion connector (open one that has Notion enabled)");
}
async function powertoysNotionMcpCall(name, args) {
  let connector = powertoysNotionConnector();
  let response = await electron.net.fetch(`${claudeAiUrl()}/api/organizations/${connector.account.orgId}/mcp/servers/${encodeURIComponent(connector.uuid)}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mcp-client-name": "ClaudeCodeDesktop", [EXPECTED_ACCOUNT_HEADER]: connector.account.accountId },
    body: JSON.stringify({ tool_name: name, arguments: args }),
  });
  let text = await response.text();
  if (!response.ok) {
    throw Error(`Notion connector "${connector.name}": HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  let body = JSON.parse(text);
  let result = (body.content ?? []).map((part) => part.text ?? "").join("") || JSON.stringify(body.structured_content ?? body.structuredContent ?? "");
  if (body.is_error) {
    throw Error(`Notion: ${result.slice(0, 300)}`);
  }
  return result;
}
/** The same shape as powertoysNotionPreview, from the connector's notion-fetch (properties as JSON, content as markdown). */
async function powertoysNotionConnectorPreview(pageId) {
  let text = await powertoysNotionMcpCall("notion-fetch", { id: pageId });
  let page;
  try {
    page = JSON.parse(text);
  } catch {
    page = { text };
  }
  let body = String(page.text ?? "");
  let properties = {};
  try {
    properties = JSON.parse(/<properties>\s*([\s\S]*?)\s*<\/properties>/.exec(body)?.[1] ?? "{}") ?? {};
  } catch {}
  // People come as user:// ids, dates as "date:…" keys and checkboxes as __YES__/__NO__: left out, as unreadable.
  // A ticket's ID comes as "userDefined:ID".
  let readable = Object.entries(properties)
    .map(([name, value]) => [name.replace(/^userDefined:/, ""), Array.isArray(value) ? value.join(", ") : value])
    .filter(([name, value]) => typeof value === "string" && value && value.length <= 80 && !name.includes(":") && !/^(user|https?):\/\/|^\[|^__(YES|NO)__$/.test(value));
  let id = readable.find(([, value]) => /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(value))?.[1] ?? "";
  let status = readable.find(([name]) => /^status$/i.test(name))?.[1] ?? "";
  let fields = readable.filter(([, value]) => value !== id && value !== status && value !== page.title).slice(0, 8);
  let content = /<content>\s*([\s\S]*?)\s*<\/content>/.exec(body)?.[1] ?? "";
  let html = await powertoysNotionContentHtml(content);
  let icon = /<page\b[^>]*\sicon="([^"]*)"/.exec(body)?.[1] ?? "";
  // The title comes with the icon in front of it.
  let title = String(page.title ?? "");
  title = icon && title.startsWith(icon) ? title.slice(icon.length).trim() : title;
  return { id, title, icon, status, fields, html, url: page.url };
}
/** Saves (or, empty, removes) the Notion token after checking it with Notion; answers the integration's name. */
async function powertoysSetNotionToken(value) {
  let token = String(value ?? "").trim();
  let file = powertoysFile(POWERTOYS_NOTION_TOKEN_FILE);
  if (!token) {
    powertoysFs.rmSync(file, { force: true });
    powertoysLog("link preview: Notion token removed");
    return null;
  }
  let me = await powertoysNotionApi(token, "users/me");
  powertoysFs.writeFileSync(file, token, "utf8");
  for (let [url] of powertoysPreviewCache) {
    if (powertoysPreviewKind(url)?.kind === "notion") {
      powertoysPreviewCache.delete(url);
    }
  }
  powertoysLog(`link preview: Notion token set (integration ${me.name ?? me.id})`);
  return me.name ?? me.id;
}
try {
  powertoysHandle("linkPreview", (event, url) => powertoysLinkPreview(String(url ?? "")));
  powertoysHandle("hasNotionToken", () => !!powertoysNotionToken());
  powertoysHandle("setNotionToken", (event, value) => powertoysSetNotionToken(value));
} catch (caught) {
  logger.error("[powertoys] registering the link preview IPC failed: %o", caught);
}
