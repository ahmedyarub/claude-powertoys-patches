// ---------------------------------------------------------------------------------------------
// Powertoys: reading Claude Code transcripts (~/.claude/projects/<project>/<cliSessionId>.jsonl).
//
// Prompt history and search read every recent transcript (hundreds of MB), so all parsing runs
// in a worker thread with per-file caches (re-read only when size or mtime changes); the main
// process only sends requests. Typed prompts are "user" entries with text content, prompts sent
// while Claude worked are "queued_command" attachments; tool results and injected text (isMeta,
// or text starting with a tag block such as <system-reminder>) are not prompts.
// ---------------------------------------------------------------------------------------------
function powertoysTranscriptWorkerMain() {
  const { parentPort } = require("node:worker_threads");
  const fs = require("node:fs");
  const path = require("node:path");
  const readline = require("node:readline");

  const LEADING_TAG_BLOCK = /^(\s*<([a-z][\w-]*)>[\s\S]*?<\/\2>)+/;
  function clean(text) {
    if (typeof text !== "string") {
      return null;
    }
    text = text.replace(LEADING_TAG_BLOCK, "").trim();
    if (text === "" || text.startsWith("<") || text.startsWith("[Request interrupted by user")) {
      return null;
    }
    return text;
  }
  function timestampOf(entry) {
    let at = Date.parse(entry.timestamp ?? "");
    return Number.isFinite(at) ? at : 0;
  }
  /** The prompt an entry records, or null. */
  function promptOf(entry) {
    if (entry.type === "attachment") {
      let attachment = entry.attachment;
      if (!attachment || attachment.type !== "queued_command") {
        return null;
      }
      if (attachment.origin?.kind && attachment.origin.kind !== "human") {
        return null;
      }
      return clean(attachment.prompt);
    }
    // A compaction summary is written as a user entry, but nobody typed it.
    if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) {
      return null;
    }
    let content = entry.message?.content;
    if (typeof content === "string") {
      return clean(content);
    }
    if (!Array.isArray(content)) {
      return null;
    }
    let texts = [];
    for (let block of content) {
      if (block?.type === "tool_result") {
        return null;
      }
      if (block?.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    return clean(texts.join("\n"));
  }

  // Lines that can't hold a prompt or Claude's text are skipped before parsing: most of a
  // transcript is tool traffic. Escaped quotes inside strings never match these patterns.
  function mayMatter(line) {
    if (line.includes('"type":"tool_result"')) {
      return false;
    }
    return (
      (line.includes('"type":"assistant"') && line.includes('"type":"text"')) ||
      line.includes('"type":"user"') ||
      line.includes('"queued_command"')
    );
  }

  /** Every prompt and every text block Claude wrote, in order. */
  async function readParts(file) {
    let parts = [];
    let promptIndex = -1;
    let input = fs.createReadStream(file, { encoding: "utf8" });
    let lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (let line of lines) {
      if (!mayMatter(line)) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.isSidechain === true) {
        continue;
      }
      if (entry.type === "assistant") {
        let message = entry.message;
        if (!Array.isArray(message?.content)) {
          continue;
        }
        for (let block of message.content) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
            parts.push({
              fromUser: false,
              text: block.text,
              uuid: entry.uuid ?? null,
              messageId: message.id ?? null,
              promptIndex,
              endsTurn: message.stop_reason === "end_turn",
              at: timestampOf(entry),
            });
          }
        }
        continue;
      }
      let prompt = promptOf(entry);
      if (prompt !== null) {
        promptIndex++;
        parts.push({ fromUser: true, text: prompt, uuid: entry.uuid ?? null, messageId: null, promptIndex, endsTurn: false, at: timestampOf(entry) });
      }
    }
    return parts;
  }

  const partsCache = new Map(); // file -> { size, mtimeMs, parts }
  async function partsOf(file) {
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      partsCache.delete(file);
      return [];
    }
    let cached = partsCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.parts;
    }
    let parts = await readParts(file);
    partsCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, parts });
    return parts;
  }

  const transcriptPaths = new Map(); // cliSessionId -> path
  function findTranscript(root, cliSessionId) {
    let known = transcriptPaths.get(cliSessionId);
    if (known && fs.existsSync(known)) {
      return known;
    }
    let dirs;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (let dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      let candidate = path.join(root, dir.name, `${cliSessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        transcriptPaths.set(cliSessionId, candidate);
        return candidate;
      }
    }
    return null;
  }

  function lastAnswer(parts) {
    let last = parts.findLast((part) => !part.fromUser && part.endsTurn);
    if (!last) {
      return null;
    }
    let sameMessage = parts.filter((part) => !part.fromUser && (last.messageId ? part.messageId === last.messageId : part === last));
    return sameMessage.map((part) => part.text).join("\n\n");
  }

  function markdown(parts, title) {
    let out = `# ${title}\n`;
    let lastFromUser = null;
    for (let part of parts) {
      out += part.fromUser !== lastFromUser ? (part.fromUser ? "\n## You\n\n" : "\n## Claude\n\n") : "\n";
      out += `${part.text.trim()}\n`;
      lastFromUser = part.fromUser;
    }
    return out;
  }

  async function history(root, days, max) {
    let since = Date.now() - days * 24 * 3600 * 1000;
    let files = [];
    let dirs;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (let dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(path.join(root, dir.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (let entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }
        let file = path.join(root, dir.name, entry.name);
        try {
          if (fs.statSync(file).mtimeMs >= since) {
            files.push(file);
          }
        } catch {}
      }
    }
    let prompts = [];
    for (let file of files) {
      for (let part of await partsOf(file)) {
        if (part.fromUser && part.at >= since) {
          prompts.push(part);
        }
      }
    }
    prompts.sort((left, right) => right.at - left.at);
    let seen = new Set();
    let result = [];
    for (let prompt of prompts) {
      let text = prompt.text.trim();
      if (!seen.has(text)) {
        seen.add(text);
        result.push(text);
        if (result.length >= max) {
          break;
        }
      }
    }
    return result;
  }

  /** Sessions whose title has every word first, then prompts and replies with every word (newest session first, latest part first). */
  async function search(root, query, sessions, max) {
    let terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    let hasAll = (text) => {
      let lower = text.toLowerCase();
      return terms.every((term) => lower.includes(term));
    };
    let hits = [];
    for (let session of sessions) {
      if (hits.length >= max) {
        break;
      }
      if (hasAll(session.title)) {
        hits.push({ sessionId: session.sessionId, title: session.title, isArchived: session.isArchived, inTitle: true, fromUser: false, text: session.title, promptIndex: -1, keys: [] });
      }
    }
    for (let session of sessions) {
      if (hits.length >= max || !session.cliSessionId) {
        continue;
      }
      let file = findTranscript(root, session.cliSessionId);
      if (!file) {
        continue;
      }
      let parts = await partsOf(file);
      for (let i = parts.length - 1; i >= 0 && hits.length < max; i--) {
        let part = parts[i];
        if (hasAll(part.text)) {
          hits.push({
            sessionId: session.sessionId,
            title: session.title,
            isArchived: session.isArchived,
            inTitle: false,
            fromUser: part.fromUser,
            text: part.text,
            promptIndex: part.promptIndex,
            keys: [part.uuid, part.messageId].filter(Boolean),
            promptKeys: promptKeysOf(parts, part.promptIndex),
          });
        }
      }
    }
    return hits;
  }
  function promptKeysOf(parts, promptIndex) {
    let prompt = parts.find((part) => part.fromUser && part.promptIndex === promptIndex);
    return prompt?.uuid ? [prompt.uuid] : [];
  }

  // Incremental tail per transcript: context size from the last assistant usage, and when the
  // current turn started (the prompt after the last finished turn).
  const tails = new Map(); // file -> { offset, contextTokens, turnStartedAt, ended }
  function tail(file) {
    let state = tails.get(file) ?? { offset: 0, contextTokens: 0, turnStartedAt: 0, ended: true };
    tails.set(file, state);
    let fd;
    try {
      fd = fs.openSync(file, "r");
      let size = fs.fstatSync(fd).size;
      if (size < state.offset) {
        Object.assign(state, { offset: 0, contextTokens: 0, turnStartedAt: 0, ended: true });
      }
      if (size === state.offset) {
        return state;
      }
      let buffer = Buffer.alloc(size - state.offset);
      let read = fs.readSync(fd, buffer, 0, buffer.length, state.offset);
      let end = buffer.lastIndexOf(10, read - 1);
      if (end < 0) {
        return state;
      }
      state.offset += end + 1;
      for (let line of buffer.toString("utf8", 0, end).split("\n")) {
        if (line.includes('"type":"assistant"')) {
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          let usage = entry.message?.usage;
          if (usage && entry.isSidechain !== true) {
            state.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          }
          if (entry.message?.stop_reason === "end_turn") {
            state.ended = true;
          }
        } else if ((line.includes('"type":"user"') || line.includes('"queued_command"')) && !line.includes('"type":"tool_result"')) {
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (promptOf(entry) !== null && state.ended) {
            state.turnStartedAt = timestampOf(entry);
            state.ended = false;
          }
        }
      }
      return state;
    } catch {
      return state;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  /** Every transcript file and its modification time. */
  function allTranscripts(root) {
    let files = [];
    let dirs;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return files;
    }
    for (let dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(path.join(root, dir.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (let entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          let file = path.join(root, dir.name, entry.name);
          try {
            files.push({ file, project: dir.name, cliSessionId: entry.name.slice(0, -6), mtimeMs: fs.statSync(file).mtimeMs });
          } catch {}
        }
      }
    }
    return files;
  }
  /**
   * The messages sent and received in [before - windowDays, before), newest first, at most `limit`.
   * A transcript last written before the window cannot hold anything in it, so it is not read.
   * Returns the entries and where the next (older) page starts.
   */
  async function timeline(root, { before, windowDays, limit, query, sessions }) {
    let since = before - windowDays * 24 * 3600 * 1000;
    let terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    let files = allTranscripts(root);
    let entries = [];
    for (let { file, project, cliSessionId, mtimeMs } of files) {
      if (mtimeMs < since) {
        continue;
      }
      let parts = await partsOf(file);
      let firstPrompt = parts.find((part) => part.fromUser)?.text ?? "";
      for (let part of parts) {
        if (part.at < since || part.at >= before) {
          continue;
        }
        if (terms.length && !terms.every((term) => part.text.toLowerCase().includes(term))) {
          continue;
        }
        let session = sessions[cliSessionId];
        entries.push({
          at: part.at,
          fromUser: part.fromUser,
          text: part.text.length > 600 ? `${part.text.slice(0, 600)}…` : part.text,
          keys: [part.uuid, part.messageId].filter(Boolean),
          sessionId: session?.sessionId ?? null,
          cliSessionId,
          title: session?.title || firstPrompt.replace(/\s+/g, " ").slice(0, 80) || project,
          project,
        });
      }
    }
    entries.sort((left, right) => right.at - left.at);
    let page = entries.slice(0, limit);
    let more = entries.length > limit;
    return {
      entries: page,
      nextBefore: more ? page[page.length - 1].at : since,
      exhausted: !more && !files.some(({ mtimeMs }) => mtimeMs < since),
    };
  }

  /**
   * Usage, edited files and recent activity of a transcript, read incrementally (only what was
   * appended since the last call). An assistant message is written once per content block, all with
   * the same usage, so usage is counted once per message id.
   */
  const statsCache = new Map();
  const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  function statsOf(file) {
    let state = statsCache.get(file) ?? { offset: 0, seen: new Set(), byDay: {}, files: new Map(), activity: [], lastAnswer: null };
    statsCache.set(file, state);
    let fd;
    try {
      fd = fs.openSync(file, "r");
      let size = fs.fstatSync(fd).size;
      if (size < state.offset) {
        statsCache.delete(file);
        fs.closeSync(fd);
        fd = undefined;
        return statsOf(file);
      }
      if (size === state.offset) {
        return state;
      }
      let buffer = Buffer.alloc(size - state.offset);
      let read = fs.readSync(fd, buffer, 0, buffer.length, state.offset);
      let end = buffer.lastIndexOf(10, read - 1);
      if (end < 0) {
        return state;
      }
      state.offset += end + 1;
      for (let line of buffer.toString("utf8", 0, end).split("\n")) {
        if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"queued_command"')) {
          continue;
        }
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        let at = timestampOf(entry);
        if (entry.isSidechain !== true) {
          trackTodos(state, entry, at);
        }
        if (entry.type === "assistant") {
          let message = entry.message ?? {};
          let usage = message.usage;
          let key = message.id ?? entry.requestId ?? entry.uuid;
          if (usage && key && !state.seen.has(key)) {
            state.seen.add(key);
            let day = new Date(at || Date.now()).toLocaleDateString("sv");
            let model = String(message.model ?? "unknown");
            let bucket = ((state.byDay[day] ??= {})[model] ??= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
            let creation = usage.cache_creation;
            bucket.input += usage.input_tokens ?? 0;
            bucket.output += usage.output_tokens ?? 0;
            bucket.cacheRead += usage.cache_read_input_tokens ?? 0;
            if (creation && typeof creation === "object") {
              bucket.cacheWrite5m += creation.ephemeral_5m_input_tokens ?? 0;
              bucket.cacheWrite1h += creation.ephemeral_1h_input_tokens ?? 0;
            } else {
              bucket.cacheWrite5m += usage.cache_creation_input_tokens ?? 0;
            }
          }
          for (let block of Array.isArray(message.content) ? message.content : []) {
            if (block?.type === "tool_use") {
              let target = block.input?.file_path ?? block.input?.notebook_path;
              if (EDIT_TOOLS.has(block.name) && typeof target === "string") {
                state.files.set(target, at);
              }
              state.activity.push({ at, kind: "tool", name: block.name, file: EDIT_TOOLS.has(block.name) && typeof target === "string" ? target : undefined });
            } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim() && entry.isSidechain !== true) {
              state.lastAnswer = { at, text: block.text.trim().slice(0, 600) };
              state.activity.push({ at, kind: "answer" });
            }
          }
        } else if (promptOf(entry) !== null) {
          state.activity.push({ at, kind: "prompt" });
        }
      }
      if (state.activity.length > 2000) {
        state.activity.splice(0, state.activity.length - 2000);
      }
      return state;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  /**
   * The session's task list as TodoWrite / TaskCreate / TaskUpdate left it, with when each item was created,
   * started and completed (the entries' timestamps), and when the list began: a TodoWrite sharing no item
   * with the previous list, or a TaskCreate once every earlier task was done.
   */
  function trackTodos(state, entry, at) {
    let todos = (state.todos ??= { items: new Map(), calls: new Map(), startedAt: 0 });
    let content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    let setStatus = (item, status, when) => {
      if (status === "in_progress" && item.status !== "in_progress") {
        item.startedAt ??= when;
      } else if (status === "completed" && item.status !== "completed") {
        item.doneAt = when;
      }
      if (status === "pending" || status === "in_progress" || status === "completed") {
        item.status = status;
      }
    };
    if (entry.type === "user") {
      // A TaskCreate's result carries the task's id, which later TaskUpdates use.
      for (let block of content) {
        let key = block?.type === "tool_result" ? todos.calls.get(block.tool_use_id) : undefined;
        if (key === undefined) {
          continue;
        }
        todos.calls.delete(block.tool_use_id);
        let id = entry.toolUseResult?.task?.id;
        if (block.is_error === true) {
          todos.items.delete(key);
        } else if (typeof id === "string" && todos.items.has(key)) {
          todos.items = new Map([...todos.items].map(([each, item]) => [each === key ? id : each, item]));
        }
      }
      return;
    }
    for (let block of content) {
      if (block?.type !== "tool_use" || !block.input || typeof block.input !== "object") {
        continue;
      }
      let input = block.input;
      // A whole list: items keep their times by text; a new list begins when no item carries over (or, for the
      // app's plan, when its scope is a new task).
      let replaceList = (entries, fresh) => {
        let previous = fresh ? [] : [...todos.items.values()];
        let next = new Map();
        for (let [index, todo] of entries.entries()) {
          if (typeof todo?.content !== "string" || todo.content === "") {
            continue;
          }
          let before = previous.find((item) => item.content === todo.content);
          let item = before ? { ...before } : { content: todo.content, status: "pending", createdAt: at };
          item.activeForm = typeof todo.activeForm === "string" ? todo.activeForm : item.activeForm;
          setStatus(item, todo.status, at);
          next.set(`todo-${index}`, item);
        }
        if (![...next.values()].some((item) => previous.some((old) => old.content === item.content))) {
          todos.startedAt = at;
        }
        todos.items = next;
      };
      if (block.name === "TodoWrite") {
        replaceList(Array.isArray(input.todos) ? input.todos : [], false);
      } else if (block.name === "mcp__ccd_turn__update_plan") {
        // The app's plan: a whole list (scope first_task / new_task / continuation), "advance" (the current step
        // is done and the next one starts), or steps by number from 1 (done: [2, 3], start: 4).
        let list = [...todos.items.values()];
        if (Array.isArray(input.items)) {
          replaceList(input.items, input.scope === "first_task" || input.scope === "new_task");
          continue;
        }
        if (input.advance === true) {
          let current = list.findIndex((item) => item.status === "in_progress");
          if (current >= 0) {
            setStatus(list[current], "completed", at);
            let next = list.slice(current + 1).find((item) => item.status === "pending");
            if (next) {
              setStatus(next, "in_progress", at);
            }
          }
        }
        for (let step of Array.isArray(input.done) ? input.done : []) {
          if (list[step - 1]) {
            setStatus(list[step - 1], "completed", at);
          }
        }
        if (Number.isInteger(input.start) && list[input.start - 1]) {
          setStatus(list[input.start - 1], "in_progress", at);
        }
      } else if (block.name === "TaskCreate" && typeof input.subject === "string" && input.subject) {
        if ([...todos.items.values()].every((item) => item.status === "completed")) {
          todos.items = new Map();
          todos.startedAt = at;
        }
        let key = `call-${block.id}`;
        todos.items.set(key, { content: input.subject, activeForm: input.activeForm, status: "pending", createdAt: at });
        todos.calls.set(block.id, key);
      } else if (block.name === "TaskUpdate" && typeof input.taskId === "string") {
        let item = todos.items.get(input.taskId);
        if (!item) {
          continue;
        }
        if (input.status === "deleted") {
          todos.items.delete(input.taskId);
          continue;
        }
        item.content = typeof input.subject === "string" && input.subject ? input.subject : item.content;
        item.activeForm = typeof input.activeForm === "string" ? input.activeForm : item.activeForm;
        setStatus(item, input.status, at);
      }
    }
  }

  /**
   * Where a session's context went: the context size at every request (exact, from each response's usage), what
   * fills it (estimated), and how it grew. Categories are estimated from the text in the transcript (about 3.6
   * characters a token); the system prompt and tool definitions from the request shape Claude Code records. At
   * every request the message categories are scaled so that, with the system prompt and tools, they add up to the
   * real size, so the picture always matches the total. A compaction starts the count again from its summary.
   */
  const CONTEXT_CATEGORIES = ["system", "tools", "instructions", "prompts", "replies", "thinking", "toolCalls", "toolResults", "files", "reminders", "summary", "images"];
  const estimateTokens = (characters) => Math.ceil(characters / 3.6);
  function oneLineOf(text, max = 100) {
    let line = String(text ?? "").replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  function toolLabelOf(name, input) {
    let detail = input?.file_path ?? input?.notebook_path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.path ?? input?.prompt ?? "";
    detail = String(detail);
    // A path's end says the most.
    if (/[\\/]/.test(detail) && detail.length > 70 && !/\s/.test(detail)) {
      detail = `…${detail.slice(-69)}`;
    }
    return `${name}${detail ? `: ${oneLineOf(detail, 90)}` : ""}`;
  }
  function textOfContent(content) {
    if (typeof content === "string") {
      return { characters: content.length, images: 0 };
    }
    let characters = 0;
    let images = 0;
    for (let block of Array.isArray(content) ? content : []) {
      if (block?.type === "text" && typeof block.text === "string") {
        characters += block.text.length;
      } else if (block?.type === "image") {
        images++;
      }
    }
    return { characters, images };
  }
  // Attachments that are records for the app, not text Claude gets (the system prompt and tool schemas are
  // counted from the request shape).
  const RECORD_ATTACHMENTS = new Set(["prompt_snapshot", "deferred_tools_record", "thinking_drop", "credential_org", "command_permissions"]);
  /** The characters of an attachment's text: its string values, without type names and ids. */
  function attachmentCharacters(value, key = "") {
    if (typeof value === "string") {
      return key === "type" || /(^|_)(uuid|id)$|Id$|Uuid$/.test(key) ? 0 : value.length;
    }
    if (Array.isArray(value)) {
      return value.reduce((sum, each) => sum + attachmentCharacters(each, key), 0);
    }
    if (value && typeof value === "object") {
      return Object.entries(value).reduce((sum, [name, each]) => sum + attachmentCharacters(each, name), 0);
    }
    return 0;
  }
  /** The kind an item adds up under: "Call: Write", "Result of Read", "Your messages", "Reminder: skill listing", … */
  function groupOf(category, label) {
    let tool = /^(?:Call: |Result of )([^:]+)/.exec(label);
    if (tool && (category === "toolCalls" || category === "toolResults")) {
      return category === "toolCalls" ? `Call: ${tool[1]}` : `Result of ${tool[1]}`;
    }
    let names = { prompts: "Your messages", replies: "Claude's text", thinking: "Thinking", images: "Images", summary: "Compaction summaries", instructions: "Instructions (CLAUDE.md, memory)", files: "Attached files" };
    return names[category] ?? label;
  }
  async function contextMap(root, cliSessionId) {
    let file = findTranscript(root, cliSessionId);
    if (!file) {
      return null;
    }
    let lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    let fixed = { system: 0, tools: 0 };
    let toolGroups = [];
    let tools = new Map(); // tool_use_id -> label
    let items = []; // every item: { category, tokens, label, at, keys, text }; a compaction drops those before it
    let segmentStart = 0;
    let totals = Object.fromEntries(CONTEXT_CATEGORIES.map((key) => [key, 0]));
    let points = [];
    let turns = [];
    let compactions = [];
    let seenMessages = new Set();
    let model = "";
    let add = (category, characters, label, at, keys, text, group = groupOf(category, label)) => {
      if (characters <= 0) {
        return;
      }
      let tokens = category === "images" ? 1600 * characters : estimateTokens(characters);
      totals[category] += tokens;
      items.push({ category, tokens, label, at, keys, text: oneLineOf(text, 160), group });
    };
    for await (let line of lines) {
      if (!line) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.isSidechain === true) {
        continue;
      }
      let at = timestampOf(entry);
      let keys = [entry.uuid, entry.message?.id].filter(Boolean);
      if (entry.type === "api-request-shape" && entry.shape) {
        fixed.system = estimateTokens((entry.shape.system ?? []).reduce((sum, block) => sum + String(block?.text ?? "").length, 0));
        let groups = new Map();
        for (let tool of entry.shape.tools ?? []) {
          let mcp = /^mcp__(.+?)__/.exec(tool?.name ?? "");
          let group = mcp ? `MCP: ${mcp[1]}` : "Built-in tools";
          let known = groups.get(group) ?? { group, count: 0, tokens: 0 };
          known.count++;
          known.tokens += estimateTokens(JSON.stringify(tool).length);
          groups.set(group, known);
        }
        toolGroups = [...groups.values()].sort((left, right) => right.tokens - left.tokens);
        fixed.tools = toolGroups.reduce((sum, group) => sum + group.tokens, 0);
        continue;
      }
      if (entry.type === "system" && entry.subtype === "compact_boundary") {
        let meta = entry.compactMetadata ?? {};
        compactions.push({ at, pre: meta.preTokens ?? 0, post: meta.postTokens ?? 0, trigger: meta.trigger ?? "", point: points.length });
        segmentStart = items.length;
        totals = Object.fromEntries(CONTEXT_CATEGORIES.map((key) => [key, 0]));
        continue;
      }
      if (entry.type === "attachment") {
        let attachment = entry.attachment ?? {};
        if (RECORD_ATTACHMENTS.has(attachment.type)) {
          continue;
        }
        if (attachment.type === "queued_command") {
          let text = String(attachment.prompt ?? "");
          add("prompts", text.length, `You: ${oneLineOf(text, 90)}`, at, keys, text);
          turns.push({ at, text: oneLineOf(text, 160), keys, point: points.length });
        } else if (attachment.type === "instructions" || attachment.type === "nested_memory") {
          let paths = (attachment.files ?? []).map((each) => each?.path).filter(Boolean);
          add("instructions", attachmentCharacters(attachment), `Instructions: ${oneLineOf(paths.join(", "), 90) || "CLAUDE.md, memory"}`, at, keys, "");
        } else if (attachment.type === "file" || attachment.type === "edited_text_file" || attachment.type === "compact_file_reference") {
          let name = attachment.filename ?? attachment.path ?? attachment.content?.file?.filePath ?? "";
          add("files", attachmentCharacters(attachment), `File: ${oneLineOf(name, 90) || attachment.type}`, at, keys, "");
        } else {
          add("reminders", attachmentCharacters(attachment), `Reminder: ${String(attachment.type ?? "attachment").replace(/_/g, " ")}`, at, keys, "");
        }
        continue;
      }
      if (entry.type === "user") {
        let content = entry.message?.content;
        if (entry.isCompactSummary === true) {
          add("summary", textOfContent(content).characters, "Compaction summary", at, keys, "");
          continue;
        }
        let blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
        for (let block of blocks) {
          if (block?.type === "tool_result") {
            let { characters, images } = textOfContent(block.content);
            add("toolResults", characters, `Result of ${tools.get(block.tool_use_id) ?? "a tool"}`, at, keys, "");
            add("images", images, "Image", at, keys, "");
          } else if (block?.type === "text" && typeof block.text === "string") {
            let injected = entry.isMeta === true || /^\s*</.test(block.text);
            // Injected text adds up by its opening tag (<system-reminder>, <command-name>, …).
            let tag = injected ? (/^s*<([w-]+)/.exec(block.text)?.[1] ?? "injected text") : "";
            add(injected ? "reminders" : "prompts", block.text.length, injected ? `Reminder: ${oneLineOf(block.text.replace(/<[^>]+>/g, " "), 60)}` : `You: ${oneLineOf(block.text, 90)}`, at, keys, block.text, injected ? `Reminder: <${tag}>` : undefined);
            if (!injected) {
              turns.push({ at, text: oneLineOf(block.text, 160), keys, point: points.length });
            }
          } else if (block?.type === "image") {
            add("images", 1, "Image", at, keys, "");
          }
        }
        continue;
      }
      if (entry.type === "assistant") {
        let message = entry.message ?? {};
        let usage = message.usage;
        // One request per message id; its context is everything before this response.
        if (usage && message.id && !seenMessages.has(message.id)) {
          seenMessages.add(message.id);
          model = message.model ?? model;
          let context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
          if (context > 0) {
            points.push({ at, context, totals: { ...totals }, fixed: { ...fixed }, items: items.length, turn: turns.length - 1, keys });
          }
        }
        for (let block of Array.isArray(message.content) ? message.content : []) {
          if (block?.type === "text") {
            add("replies", String(block.text ?? "").length, `Claude: ${oneLineOf(block.text, 90)}`, at, keys, block.text);
          } else if (block?.type === "thinking") {
            add("thinking", String(block.thinking ?? "").length, "Thinking", at, keys, "");
          } else if (block?.type === "tool_use") {
            let label = toolLabelOf(block.name, block.input);
            tools.set(block.id, label);
            add("toolCalls", JSON.stringify(block.input ?? {}).length, `Call: ${label}`, at, keys, "");
          }
        }
      }
    }
    if (points.length === 0) {
      return { model, points: [], turns: [], compactions, categories: CONTEXT_CATEGORIES };
    }
    // Each point's categories, scaled to its real size: the system prompt and tools as measured, messages scaled.
    let scaled = (point) => {
      let messages = CONTEXT_CATEGORIES.filter((key) => key !== "system" && key !== "tools").reduce((sum, key) => sum + point.totals[key], 0);
      let room = Math.max(0, point.context - point.fixed.system - point.fixed.tools);
      let factor = messages > 0 ? room / messages : 0;
      let result = { system: point.fixed.system, tools: point.fixed.tools };
      for (let key of CONTEXT_CATEGORIES) {
        if (key !== "system" && key !== "tools") {
          result[key] = Math.round(point.totals[key] * factor);
        }
      }
      // When the measured system prompt and tools are more than the whole (an early request), they share it.
      let sum = Object.values(result).reduce((total, value) => total + value, 0);
      if (sum > point.context && sum > 0) {
        for (let key of CONTEXT_CATEGORIES) {
          result[key] = Math.round((result[key] * point.context) / sum);
        }
      }
      return { result, factor };
    };
    let last = points.at(-1);
    let { result: nowCategories, factor: nowFactor } = scaled(last);
    // What is in the context now: this segment's items up to the last request, biggest first.
    let inContext = items
      .slice(segmentStart, last.items)
      .map((item) => ({ ...item, tokens: Math.round(item.tokens * (item.category === "images" ? 1 : nowFactor)) }))
      .sort((left, right) => right.tokens - left.tokens);
    let nowItems = inContext.slice(0, 30);
    // The same, added up by kind (each kind with its own biggest items, to drill into).
    let byGroup = new Map();
    for (let item of inContext) {
      let group = byGroup.get(item.group) ?? { group: item.group, category: item.category, tokens: 0, count: 0, latest: 0, items: [] };
      group.tokens += item.tokens;
      group.count++;
      group.latest = Math.max(group.latest, item.at);
      if (group.items.length < 25) {
        group.items.push(item);
      }
      byGroup.set(item.group, group);
    }
    let nowGroups = [...byGroup.values()].sort((left, right) => right.tokens - left.tokens).slice(0, 40);
    // The biggest jumps between one request and the next, with what came in between.
    let jumps = [];
    for (let index = 1; index < points.length; index++) {
      let before = points[index - 1];
      let point = points[index];
      let delta = point.context - before.context;
      if (delta <= 0 || compactions.some((compaction) => compaction.point === index)) {
        continue;
      }
      jumps.push({ index, delta });
    }
    jumps.sort((left, right) => right.delta - left.delta);
    // A jump's cause is the biggest item added between its two requests.
    let topJumps = jumps.slice(0, 15).map(({ index, delta }) => {
      let point = points[index];
      let before = points[index - 1];
      let cause = items.slice(before.items, point.items).sort((left, right) => right.tokens - left.tokens)[0] ?? null;
      // Tools loaded in between (ToolSearch, a new MCP server) grow the tool definitions, which are not items.
      let toolGrowth = point.fixed.tools - before.fixed.tools;
      if (toolGrowth > (cause?.tokens ?? 0)) {
        cause = { label: `Tool definitions loaded (+${Math.round(toolGrowth / 1000)}k)`, category: "tools", keys: point.keys };
      }
      return { at: point.at, delta, from: before.context, to: point.context, cause: cause && { label: cause.label, category: cause.category }, keys: cause?.keys ?? point.keys, turn: point.turn };
    });
    // Turns: what each of your messages cost, from its first request to the last one before the next message.
    let turnRows = turns.map((turn, index) => {
      let first = points.findIndex((point) => point.turn >= index);
      let next = index + 1 < turns.length ? points.findIndex((point) => point.turn >= index + 1) : points.length;
      let start = first >= 0 ? points[first].context : 0;
      let end = first >= 0 && next > first ? points[next - 1].context : start;
      let requests = first >= 0 ? Math.max(0, next - first) : 0;
      return { ...turn, start, end, requests };
    });
    // At most 900 points for the chart, keeping the last and those around compactions.
    let keep = new Set([0, points.length - 1]);
    let step = Math.max(1, Math.ceil(points.length / 900));
    for (let index = 0; index < points.length; index += step) {
      keep.add(index);
    }
    for (let compaction of compactions) {
      keep.add(Math.max(0, compaction.point - 1));
      keep.add(Math.min(points.length - 1, compaction.point));
    }
    let chartIndexes = [...keep].sort((left, right) => left - right);
    return {
      model,
      categories: CONTEXT_CATEGORIES,
      now: { at: last.at, context: last.context, categories: nowCategories, items: nowItems, groups: nowGroups, toolGroups, estimateFactor: nowFactor },
      points: chartIndexes.map((index) => ({ index, at: points[index].at, context: points[index].context, categories: scaled(points[index]).result, turn: points[index].turn })),
      requests: points.length,
      turns: turnRows,
      compactions,
      jumps: topJumps,
    };
  }

  const methods = {
    /** Where the session's context went, and how it grew (see contextMap). */
    contextMap: ({ root, cliSessionId }) => contextMap(root, cliSessionId),
    /** The session's task list with its items' times (see trackTodos); null without a transcript. */
    todos({ root, cliSessionId }) {
      let file = findTranscript(root, cliSessionId);
      if (!file) {
        return null;
      }
      let todos = statsOf(file).todos;
      return { startedAt: todos?.startedAt ?? 0, items: todos ? [...todos.items.values()] : [] };
    },
    /** Per session: usage by day and model, edited files (newest first), and activity after `since`. */
    stats({ root, cliSessionIds, since = 0 }) {
      let result = {};
      for (let id of cliSessionIds) {
        let file = findTranscript(root, id);
        if (!file) {
          continue;
        }
        let state = statsOf(file);
        let recent = state.activity.filter((item) => item.at >= since);
        result[id] = {
          byDay: state.byDay,
          files: [...state.files].sort((left, right) => right[1] - left[1]).slice(0, 200).map(([path, at]) => ({ path, at })),
          since: since
            ? {
                prompts: recent.filter((item) => item.kind === "prompt").length,
                tools: recent.filter((item) => item.kind === "tool").length,
                edited: [...new Set(recent.filter((item) => item.file).map((item) => item.file))],
                lastAnswer: state.lastAnswer && state.lastAnswer.at >= since ? state.lastAnswer : null,
              }
            : null,
        };
      }
      return result;
    },
    timeline: (args) => timeline(args.root, args),
    async conversation({ root, cliSessionId }) {
      let file = findTranscript(root, cliSessionId);
      return file ? { parts: await partsOf(file) } : null;
    },
    async lastAnswer({ root, cliSessionId }) {
      let file = findTranscript(root, cliSessionId);
      return file ? lastAnswer(await partsOf(file)) : null;
    },
    async markdown({ root, cliSessionId, title }) {
      let file = findTranscript(root, cliSessionId);
      return file ? markdown(await partsOf(file), title) : null;
    },
    history: ({ root, days, max }) => history(root, days, max),
    search: ({ root, query, sessions, max }) => search(root, query, sessions, max),
    tails({ root, cliSessionIds }) {
      let result = {};
      for (let id of cliSessionIds) {
        let file = findTranscript(root, id);
        if (file) {
          let { contextTokens, turnStartedAt } = tail(file);
          result[id] = { contextTokens, turnStartedAt };
        }
      }
      return result;
    },
    async warm({ root, sessions }) {
      for (let session of sessions) {
        let file = session.cliSessionId && findTranscript(root, session.cliSessionId);
        if (file) {
          await partsOf(file);
        }
      }
      return true;
    },
  };
  parentPort.on("message", async ({ id, method, args }) => {
    try {
      parentPort.postMessage({ id, result: await methods[method](args) });
    } catch (caught) {
      parentPort.postMessage({ id, error: String(caught?.stack ?? caught) });
    }
  });
}

var powertoysWorkerInstance = null;
var powertoysWorkerNextId = 1;
const powertoysWorkerPending = new Map();
function powertoysWorker() {
  if (powertoysWorkerInstance) {
    return powertoysWorkerInstance;
  }
  let { Worker } = require("node:worker_threads");
  let worker = new Worker(`(${powertoysTranscriptWorkerMain.toString()})()`, { eval: true, name: "powertoys-transcripts" });
  worker.unref();
  worker.on("message", ({ id, result, error }) => {
    let pending = powertoysWorkerPending.get(id);
    if (!pending) {
      return;
    }
    powertoysWorkerPending.delete(id);
    error ? pending.reject(Error(error)) : pending.resolve(result);
  });
  let fail = (reason) => {
    powertoysWarn(`transcript worker stopped: ${reason}`);
    powertoysWorkerInstance = null;
    for (let pending of powertoysWorkerPending.values()) {
      pending.reject(Error(`transcript worker stopped: ${reason}`));
    }
    powertoysWorkerPending.clear();
  };
  worker.on("error", (caught) => fail(caught?.message ?? String(caught)));
  worker.on("exit", (code) => code !== 0 && fail(`exit ${code}`));
  powertoysWorkerInstance = worker;
  return worker;
}
function powertoysTranscripts(method, args = {}) {
  let id = powertoysWorkerNextId++;
  let root = process.env.CLAUDE_CONFIG_DIR
    ? powertoysPath.join(process.env.CLAUDE_CONFIG_DIR, "projects")
    : powertoysPath.join(powertoysOs.homedir(), ".claude", "projects");
  return new Promise((resolve, reject) => {
    powertoysWorkerPending.set(id, { resolve, reject });
    powertoysWorker().postMessage({ id, method, args: { root, ...args } });
  });
}
