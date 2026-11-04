
// --- Link previews' rendering: Notion pages and Slack messages as HTML, images inlined as data: URIs ------------
// The page puts this HTML through an allowlist (sanitizeHtml) before showing it, in the linked app's own dark look.
const POWERTOYS_PREVIEW_IMAGE_BYTES = 3 * 1024 * 1024;
const POWERTOYS_PREVIEW_IMAGES = 30;
const POWERTOYS_PREVIEW_IMAGES_BYTES = 24 * 1024 * 1024; // all of a preview's images together
function powertoysHtmlEscape(text) {
  return String(text ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function powertoysHtmlLink(url, labelHtml) {
  return /^https?:\/\//i.test(url) ? `<a href="${powertoysHtmlEscape(url)}">${labelHtml}</a>` : labelHtml;
}
/** An image as a data: URI (at most 3 MB; anything but an image is refused). */
async function powertoysImageData(url, headers = {}) {
  let response = await electron.net.fetch(url, { headers });
  let type = response.headers.get("content-type") ?? "";
  if (!response.ok || !/^image\//i.test(type)) {
    throw Error(`image ${response.status} ${type}`);
  }
  let bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > POWERTOYS_PREVIEW_IMAGE_BYTES) {
    throw Error(`image of ${bytes.length} bytes`);
  }
  return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
}
/**
 * The <img data-pt-image="N"> placeholders of `html` given their data: URIs (resolve(sources) answers one per source,
 * null when it could not be read: that image becomes its caption, as a link when it has one).
 */
async function powertoysInlineImages(html, sources, resolve) {
  let wanted = sources.slice(0, POWERTOYS_PREVIEW_IMAGES);
  let data = wanted.length ? await resolve(wanted) : [];
  let total = 0;
  data = data.map((uri) => (uri && (total += uri.length) <= POWERTOYS_PREVIEW_IMAGES_BYTES ? uri : null));
  return html.replace(/<img data-pt-image="(\d+)"([^>]*)>/g, (whole, index, rest) => {
    let uri = data[Number(index)];
    if (uri) {
      return `<img src="${uri}"${rest}>`;
    }
    let alt = /alt="([^"]*)"/.exec(rest)?.[1] || "image";
    return `<span class="pt-missing-image">🖼 ${alt}</span>`;
  });
}

// --- Notion: its page markdown (markdown with Notion's own tags) as HTML -------------------------------------------
const powertoysNotionUserNames = new Map(); // user id -> name (notion-get-users)
async function powertoysNotionNames(ids) {
  await Promise.all(
    [...new Set(ids)]
      .filter((id) => !powertoysNotionUserNames.has(id))
      .slice(0, 20)
      .map(async (id) => {
        let text = await powertoysNotionMcpCall("notion-get-users", { user_id: id }).catch(() => "");
        let name = null;
        try {
          let answer = JSON.parse(text);
          let user = answer.results?.[0] ?? answer.user ?? answer;
          name = user?.name ?? null;
        } catch {}
        powertoysNotionUserNames.set(id, name);
      }),
  );
}
function powertoysNotionDate(start, end) {
  let format = (value) => {
    let date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return /T/.test(value) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : date.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
  };
  return end ? `${format(start)} → ${format(end)}` : format(start);
}
/** Inline markdown and Notion's inline tags as HTML; images become placeholders listed in context.images. */
function powertoysNotionInline(text, context) {
  let kept = [];
  let hold = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let source = String(text ?? "")
    .replace(/`([^`]+)`/g, (whole, code) => hold(`<code>${powertoysHtmlEscape(code)}</code>`))
    .replace(/\$`([^`]+)`\$|\$\$([^$]+)\$\$/g, (whole, one, two) => hold(`<code>${powertoysHtmlEscape(one ?? two)}</code>`))
    .replace(/<mention-user url="user:\/\/([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/mention-user>)/g, (whole, id, name) =>
      hold(`<span class="n-mention">@${powertoysHtmlEscape(name || powertoysNotionUserNames.get(id) || "someone")}</span>`),
    )
    .replace(/<mention-(page|database|data-source|agent)\s+url="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/mention-\1>)/g, (whole, kind, url, title) =>
      hold(powertoysHtmlLink(url, `<span class="n-page-mention">${kind === "page" ? "📄" : "🗃"} ${title ? powertoysNotionInline(title, context) : "Untitled"}</span>`)),
    )
    .replace(/<mention-date\s+start="([^"]+)"(?:\s+end="([^"]+)")?[^>]*?(?:\/>|>[\s\S]*?<\/mention-date>)/g, (whole, start, end) => hold(`<span class="n-date">@${powertoysHtmlEscape(powertoysNotionDate(start, end))}</span>`))
    .replace(/<span color="([a-z_]+)">/g, (whole, color) => hold(`<span class="n-${color}">`))
    .replace(/<span underline="true">/g, () => hold('<span class="n-underline">'))
    .replace(/<\/span>/g, () => hold("</span>"))
    .replace(/<br\s*\/?>/g, () => hold("<br>"))
    .replace(/<\/?[a-z][\w-]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, url) => hold(`<img data-pt-image="${context.images.push(url) - 1}" alt="${powertoysHtmlEscape(alt)}">`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => hold(powertoysHtmlLink(url, powertoysNotionInline(label, context))))
    .replace(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, (url) => hold(powertoysHtmlLink(url, powertoysHtmlEscape(url))));
  let html = powertoysHtmlEscape(source)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  for (let round = 0; round < 3 && html.includes("\u0000"); round++) {
    html = html.replace(/\u0000(\d+)\u0000/g, (whole, index) => kept[Number(index)]);
  }
  return html;
}
function powertoysNotionAttributes(tag) {
  return Object.fromEntries([...String(tag).matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
}
/** The lines from `start` (an opening <tag …>) to its closing </tag>, the inside one tab less indented. */
function powertoysNotionContainer(lines, start, tag) {
  let depth = 0;
  let inside = [];
  for (let index = start; index < lines.length; index++) {
    let line = lines[index];
    let opens = (line.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "g")) ?? []).length;
    let closes = (line.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    depth += opens - closes;
    if (index > start) {
      if (depth <= 0 && closes && line.trim() === `</${tag}>`) {
        return { inside, end: index + 1 };
      }
      inside.push(line.replace(/^\t/, ""));
    }
    if (depth <= 0) {
      return { inside, end: index + 1 };
    }
  }
  return { inside, end: lines.length };
}
function powertoysNotionTable(text, context) {
  let attributes = powertoysNotionAttributes(/<table([^>]*)>/.exec(text)?.[1] ?? "");
  let rows = [...text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row, rowIndex) =>
    [...row[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)]
      .map((cell, cellIndex) => {
        let header = (attributes["header-row"] === "true" && rowIndex === 0) || (attributes["header-column"] === "true" && cellIndex === 0);
        let color = powertoysNotionAttributes(cell[1]).color;
        return `<${header ? "th" : "td"}${color ? ` class="n-${color}"` : ""}>${powertoysNotionInline(cell[2].trim(), context)}</${header ? "th" : "td"}>`;
      })
      .join(""),
  );
  return `<div class="n-table"><table>${rows.map((row) => `<tr>${row}</tr>`).join("")}</table></div>`;
}
/** Notion page markdown (one tab per nesting level) as HTML. */
function powertoysNotionBlocks(lines, context) {
  let out = [];
  let list = null;
  let closeList = () => {
    if (list) {
      out.push(`<${list.tag}${list.todo ? ' class="n-todo"' : ""}>${list.items.join("")}</${list.tag}>`);
      list = null;
    }
  };
  let index = 0;
  let childLines = () => {
    let children = [];
    while (index < lines.length && (lines[index].startsWith("\t") || (lines[index].trim() === "" && lines[index + 1]?.startsWith("\t")))) {
      children.push(lines[index++].replace(/^\t/, ""));
    }
    return children;
  };
  while (index < lines.length) {
    let raw = lines[index];
    let attributes = {};
    let line = raw.replace(/\s*\{((?:[\w-]+="[^"]*"\s*)+)\}\s*$/, (whole, list) => {
      attributes = powertoysNotionAttributes(list);
      return "";
    });
    let colored = (html) => (attributes.color ? `<div class="n-${powertoysHtmlEscape(attributes.color)}">${html}</div>` : html);
    let container = /^<(callout|details|columns|column|toggle)(\s[^>]*)?>\s*$/.exec(line.trim());
    if (line.trim() === "") {
      closeList();
      index++;
      continue;
    }
    if (/^```/.test(line.trim())) {
      closeList();
      let code = [];
      while (++index < lines.length && !/^```/.test(lines[index].trim())) {
        code.push(lines[index]);
      }
      index++;
      out.push(`<pre><code>${powertoysHtmlEscape(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^<table[\s>]/.test(line.trim())) {
      closeList();
      let { inside, end } = powertoysNotionContainer(lines, index, "table");
      out.push(powertoysNotionTable(`${line}\n${inside.join("\n")}\n</table>`, context));
      index = end;
      continue;
    }
    if (container) {
      closeList();
      let [, tag, tagAttributes] = container;
      let { inside, end } = powertoysNotionContainer(lines, index, tag);
      index = end;
      let attrs = powertoysNotionAttributes(tagAttributes ?? "");
      if (tag === "callout") {
        out.push(`<div class="n-callout n-${powertoysHtmlEscape(attrs.color || "gray_bg")}"><div class="n-callout-icon">${powertoysHtmlEscape(attrs.icon || "💡")}</div><div class="n-callout-body">${powertoysNotionBlocks(inside, context)}</div></div>`);
      } else if (tag === "details" || tag === "toggle") {
        let summaryAt = inside.findIndex((each) => /<summary>/.test(each));
        let summary = summaryAt >= 0 ? /<summary>([\s\S]*?)<\/summary>/.exec(inside[summaryAt])?.[1] ?? "" : "";
        let rest = summaryAt >= 0 ? [...inside.slice(0, summaryAt), ...inside.slice(summaryAt + 1)] : inside;
        out.push(`<details><summary>${powertoysNotionInline(summary, context)}</summary>${powertoysNotionBlocks(rest, context)}</details>`);
      } else if (tag === "columns") {
        out.push(`<div class="n-columns">${powertoysNotionBlocks(inside, context)}</div>`);
      } else {
        out.push(`<div class="n-column">${powertoysNotionBlocks(inside, context)}</div>`);
      }
      continue;
    }
    index++;
    let trimmed = line.trim();
    if (/^<\/(callout|details|columns|column|toggle|table)>$/.test(trimmed) || /^<(unknown|empty-block)\b[^>]*\/?>$/.test(trimmed)) {
      closeList();
      if (/^<empty-block/.test(trimmed)) {
        out.push('<div class="n-empty"></div>');
      }
      continue;
    }
    // An embed may also run over several lines: <image source="…">, its caption, </image>.
    let opened = /^<(page|database|data-source|image|file|video|audio|pdf)\b([^>]*?)>$/.exec(trimmed);
    if (opened && !trimmed.endsWith("/>")) {
      let { inside, end } = powertoysNotionContainer(lines, index - 1, opened[1]);
      index = end;
      trimmed = `<${opened[1]}${opened[2]}>${inside.map((each) => each.trim()).filter(Boolean).join(" ")}</${opened[1]}>`;
    }
    let embed = /^<(page|database|data-source|image|file|video|audio|pdf)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)$/.exec(trimmed);
    if (embed) {
      closeList();
      let [, kind, tagAttributes, label] = embed;
      let attrs = powertoysNotionAttributes(tagAttributes);
      let url = attrs.url ?? attrs.source ?? attrs.src ?? "";
      if (kind === "image") {
        out.push(`<figure><img data-pt-image="${context.images.push(url) - 1}" alt="${powertoysHtmlEscape(label ?? "")}">${label ? `<figcaption>${powertoysNotionInline(label, context)}</figcaption>` : ""}</figure>`);
      } else {
        let icon = attrs.icon || { page: "📄", database: "🗃", "data-source": "🗃" }[kind] || "📎";
        out.push(`<div class="n-page-block">${powertoysHtmlLink(url, `${powertoysHtmlEscape(icon)} ${label ? powertoysNotionInline(label, context) : "Untitled"}`)}</div>`);
      }
      childLines();
      continue;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      closeList();
      let rows = [trimmed];
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
        rows.push(lines[index++].trim());
      }
      let cells = (row) => row.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
      let header = rows.length > 1 && /^\|[\s:|-]+\|$/.test(rows[1]);
      let body = rows.filter((row, at) => !(header && at === 1));
      let cell = (text, head) => `<${head ? "th" : "td"}>${powertoysNotionInline(text, context)}</${head ? "th" : "td"}>`;
      out.push(`<div class="n-table"><table>${body.map((row, at) => `<tr>${cells(row).map((text) => cell(text, header && at === 0)).join("")}</tr>`).join("")}</table></div>`);
      continue;
    }
    let heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeList();
      let level = Math.min(heading[1].length, 4);
      let children = childLines();
      let head = `<h${level}>${powertoysNotionInline(heading[2], context)}</h${level}>`;
      out.push(colored(attributes.toggle === "true" || children.length ? `<details><summary>${head}</summary>${powertoysNotionBlocks(children, context)}</details>` : head));
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      out.push("<hr>");
      continue;
    }
    let quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeList();
      let parts = [quote[1]];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        parts.push(lines[index++].trim().replace(/^>\s?/, ""));
      }
      let children = childLines();
      out.push(colored(`<blockquote>${parts.map((part) => powertoysNotionInline(part, context)).join("<br>")}${powertoysNotionBlocks(children, context)}</blockquote>`));
      continue;
    }
    let item = /^([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(trimmed);
    if (item) {
      let tag = /^\d/.test(item[1]) ? "ol" : "ul";
      let todo = item[2] !== undefined;
      if (!list || list.tag !== tag || list.todo !== todo) {
        closeList();
        list = { tag, todo, items: [] };
      }
      let children = childLines();
      let box = todo ? `<input type="checkbox" disabled${/x/i.test(item[2]) ? " checked" : ""}> ` : "";
      let body = `${box}<span${todo && /x/i.test(item[2]) ? ' class="n-done"' : ""}>${powertoysNotionInline(item[3], context)}</span>${children.length ? powertoysNotionBlocks(children, context) : ""}`;
      list.items.push(`<li${attributes.color ? ` class="n-${powertoysHtmlEscape(attributes.color)}"` : ""}>${body}</li>`);
      continue;
    }
    closeList();
    let children = childLines();
    out.push(colored(`<p>${powertoysNotionInline(trimmed, context)}</p>${children.length ? `<div class="n-indent">${powertoysNotionBlocks(children, context)}</div>` : ""}`));
  }
  closeList();
  return out.join("");
}
/** A fetched page's content as HTML, with its images (notion-file-block references or URLs) inlined. */
async function powertoysNotionContentHtml(content) {
  await powertoysNotionNames([...content.matchAll(/<mention-user url="user:\/\/([^"]+)"/g)].map((match) => match[1]));
  let context = { images: [] };
  let html = powertoysNotionBlocks(content.replace(/\r/g, "").split("\n"), context);
  if (!context.images.length && /notion-file-block:\/\/|<image\b/.test(content)) {
    let at = content.search(/notion-file-block:\/\/|<image\b/);
    powertoysLog(`link preview: a Notion image was not recognised: ${JSON.stringify(content.slice(Math.max(0, at - 120), at + 80))}`);
  }
  return powertoysInlineImages(html, context.images, async (sources) => {
    let references = sources.filter((source) => source.startsWith("notion-file-block://"));
    let signed = new Map();
    // notion-get-file-download-urls takes 25 references at a time.
    for (let at = 0; at < references.length; at += 25) {
      let answer = await powertoysNotionMcpCall("notion-get-file-download-urls", { references: references.slice(at, at + 25) }).catch((caught) => {
        powertoysLog(`link preview: Notion image URLs failed: ${caught.message}`);
        return "{}";
      });
      try {
        for (let file of JSON.parse(answer).files ?? []) {
          signed.set(file.reference, file.url);
        }
      } catch {}
    }
    return Promise.all(
      sources.map((source) => {
        let url = source.startsWith("notion-file-block://") ? signed.get(source) : /^https:\/\//.test(source) ? source : null;
        return url ? powertoysImageData(url).catch(() => null) : null;
      }),
    );
  });
}

// --- Slack: a message's rich-text blocks (or its mrkdwn) as HTML ---------------------------------------------------
function powertoysSlackMrkdwn(text, rich) {
  let kept = [];
  let hold = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let source = String(text ?? "")
    .replace(/```([\s\S]*?)```/g, (whole, code) => hold(`<pre>${powertoysHtmlEscape(code.replace(/^\n|\n$/g, ""))}</pre>`))
    .replace(/`([^`\n]+)`/g, (whole, code) => hold(`<code>${powertoysHtmlEscape(code)}</code>`))
    // Shortcodes the bridge resolved (bot messages' mrkdwn has no unicode of its own); others stay as written.
    .replace(/:([a-z0-9_+'-]+(?:::skin-tone-[2-6])?):/g, (whole, name) => (rich?.emoji?.[name] ? hold(powertoysSlackEmoji(name, null, rich)) : whole))
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (whole, url, label) => hold(powertoysHtmlLink(url, powertoysHtmlEscape(label))))
    .replace(/<(https?:[^>]+)>/g, (whole, url) => hold(powertoysHtmlLink(url, powertoysHtmlEscape(url))))
    .replace(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, (url) => hold(powertoysHtmlLink(url, powertoysHtmlEscape(url))))
    .replace(/(^|\s)(@[\w.-]+(?: [A-Z][\w.-]+)?)/g, (whole, space, name) => `${space}${hold(`<span class="s-mention">${powertoysHtmlEscape(name)}</span>`)}`);
  let html = powertoysHtmlEscape(source)
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?![\w~])/g, "$1<del>$2</del>")
    .split("\n")
    .map((line) => (/^&gt;\s?/.test(line) ? `<blockquote>${line.replace(/^&gt;\s?/, "")}</blockquote>` : line))
    .join("<br>")
    .replace(/<\/blockquote><br><blockquote>/g, "<br>")
    .replace(/<br>(<blockquote>)|(<\/blockquote>)<br>/g, "$1$2");
  for (let round = 0; round < 2 && html.includes("\u0000"); round++) {
    html = html.replace(/\u0000(\d+)\u0000/g, (whole, index) => kept[Number(index)]);
  }
  return html;
}
function powertoysSlackEmoji(name, unicode, rich) {
  if (unicode) {
    try {
      return String.fromCodePoint(...unicode.split("-").map((hex) => parseInt(hex, 16)));
    } catch {}
  }
  // The bridge's emoji map: a workspace's own emoji as a data: image, a standard one as its character.
  let known = rich?.emoji?.[name];
  if (typeof known === "string" && known.startsWith("data:image/")) {
    return `<img class="s-emoji" src="${powertoysHtmlEscape(known)}" alt=":${powertoysHtmlEscape(name)}:">`;
  }
  return typeof known === "string" && known ? powertoysHtmlEscape(known) : `:${powertoysHtmlEscape(name)}:`;
}
function powertoysSlackElement(element, rich) {
  let styled = (html) => {
    let style = element.style ?? {};
    html = style.code ? `<code>${html}</code>` : html;
    html = style.bold ? `<strong>${html}</strong>` : html;
    html = style.italic ? `<em>${html}</em>` : html;
    return style.strike ? `<del>${html}</del>` : html;
  };
  switch (element.type) {
    case "text":
      return styled(powertoysHtmlEscape(element.text).replace(/\n/g, "<br>"));
    case "link":
      return styled(powertoysHtmlLink(element.url, powertoysHtmlEscape(element.text || element.url)));
    case "emoji":
      return powertoysSlackEmoji(element.name, element.unicode, rich);
    case "user":
      return `<span class="s-mention">@${powertoysHtmlEscape(rich?.names?.[element.user_id] ?? element.user_id)}</span>`;
    case "usergroup":
      return `<span class="s-mention">@${powertoysHtmlEscape(rich?.names?.[element.usergroup_id] ?? "group")}</span>`;
    case "channel":
      return `<span class="s-mention">#${powertoysHtmlEscape(rich?.channels?.[element.channel_id] ?? element.channel_id)}</span>`;
    case "broadcast":
      return `<span class="s-mention s-broadcast">@${powertoysHtmlEscape(element.range)}</span>`;
    case "date":
      return powertoysHtmlEscape(element.fallback ?? "");
    case "color":
      return `<span class="s-color" style="background:${/^#[0-9a-f]{3,8}$/i.test(element.value) ? element.value : "transparent"}"></span>${powertoysHtmlEscape(element.value)}`;
    default:
      return powertoysHtmlEscape(element.text ?? "");
  }
}
function powertoysSlackBlocksHtml(blocks, rich) {
  let section = (part) => (part.elements ?? []).map((element) => powertoysSlackElement(element, rich)).join("");
  let out = [];
  for (let block of blocks ?? []) {
    if (block.type === "rich_text") {
      for (let part of block.elements ?? []) {
        if (part.type === "rich_text_section") {
          out.push(`<div class="s-line">${section(part)}</div>`);
        } else if (part.type === "rich_text_list") {
          let tag = part.style === "ordered" ? "ol" : "ul";
          out.push(`<${tag} class="s-indent-${Math.min(part.indent ?? 0, 4)}">${(part.elements ?? []).map((item) => `<li>${section(item)}</li>`).join("")}</${tag}>`);
        } else if (part.type === "rich_text_quote") {
          out.push(`<blockquote>${section(part)}</blockquote>`);
        } else if (part.type === "rich_text_preformatted") {
          out.push(`<pre>${(part.elements ?? []).map((element) => powertoysHtmlEscape(element.text ?? element.url ?? "")).join("")}</pre>`);
        }
      }
    } else if (block.type === "section" && block.text?.text) {
      out.push(`<div class="s-line">${block.text.type === "mrkdwn" ? powertoysSlackMrkdwn(block.text.text, rich) : powertoysHtmlEscape(block.text.text)}</div>`);
    } else if (block.type === "header" && block.text?.text) {
      out.push(`<div class="s-header">${powertoysHtmlEscape(block.text.text)}</div>`);
    } else if (block.type === "context") {
      out.push(`<div class="s-context">${(block.elements ?? []).map((element) => (element.text ? (element.type === "mrkdwn" ? powertoysSlackMrkdwn(element.text, rich) : powertoysHtmlEscape(element.text)) : "")).join(" ")}</div>`);
    } else if (block.type === "divider") {
      out.push("<hr>");
    }
  }
  return out.join("");
}
/** One message of a thread: { author, time, avatar, html, files: [{ name, thumb }] }. */
function powertoysSlackMessageHtml(message) {
  let rich = { names: message.names, channels: message.channels, emoji: message.emoji };
  let html = message.blocks?.length ? powertoysSlackBlocksHtml(message.blocks, rich) : "";
  return {
    author: message.author,
    time: message.time,
    avatar: typeof message.avatar === "string" && message.avatar.startsWith("data:image/") ? message.avatar : null,
    html: html || powertoysSlackMrkdwn(message.text ?? "", rich),
    files: (message.files ?? []).map((file) => ({ name: file.name, type: file.type, thumb: typeof file.thumb === "string" && file.thumb.startsWith("data:image/") ? file.thumb : null })),
  };
}
