// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): notification inbox, per-session mute, and answering waiting
// permission requests from the tray.
//
// Inbox: every notification the Electron provider (platform/0196) shows is recorded here with its
// buttons and its interaction callback, so a dismissed permission or question can still be answered
// from the inbox: the press is replayed through the same callback the notification's own button
// uses. Callbacks live only in this run; the list is not saved to disk.
// ---------------------------------------------------------------------------------------------
const POWERTOYS_INBOX_LIMIT = 200;
const powertoysInbox = [];
const powertoysInboxCallbacks = new Map();
var powertoysInboxNextId = 1;

/** The session a notification belongs to: its data, else its group ("session-<id>"). */
function powertoysNotificationSessionId(options) {
  if (typeof options?.data?.sessionId === "string") {
    return options.data.sessionId;
  }
  let match = /^session-(.+)$/.exec(options?.groupId ?? "");
  return match ? match[1] : null;
}
/**
 * Records a notification about to be shown and returns the interaction callback to use instead of
 * `onInteraction`: it notes what happened to the notification, then calls the original.
 */
function powertoysInboxRecord(options, notificationId, onInteraction) {
  let entry = {
    id: powertoysInboxNextId++,
    at: Date.now(),
    tag: notificationId,
    title: String(options?.title ?? ""),
    body: String(options?.body ?? ""),
    type: options?.data?.type ?? "generic",
    sessionId: powertoysNotificationSessionId(options),
    requestId: typeof options?.data?.requestId === "string" ? options.data.requestId : null,
    // A drop-down's items are offered as one button each ("<type>:<item index>").
    actions: (options?.actions ?? []).flatMap((action) =>
      Array.isArray(action.selection)
        ? action.selection.map((item, index) => ({ type: `${action.type}:${index}`, text: item }))
        : [{ type: action.type, text: action.text }],
    ),
    reply: options?.reply ? { placeholder: options.reply.placeholder ?? "" } : null,
    state: "shown",
  };
  // A notification shown again under the same tag (the next question, a re-alert) replaces the old one.
  for (let other of powertoysInbox) {
    if (other.tag === entry.tag && other.state === "shown") {
      other.state = "replaced";
      powertoysInboxCallbacks.delete(other.id);
    }
  }
  powertoysInbox.unshift(entry);
  for (let dropped of powertoysInbox.splice(POWERTOYS_INBOX_LIMIT)) {
    powertoysInboxCallbacks.delete(dropped.id);
  }
  let wrapped = (interaction) => {
    if (interaction?.action === "action" || interaction?.action === "reply") {
      entry.state = "answered";
      let pressed = typeof interaction.selectionIndex === "number" ? `${interaction.actionType}:${interaction.selectionIndex}` : interaction.actionType;
      entry.answer = interaction.action === "reply" ? interaction.reply : entry.actions.find((action) => action.type === pressed)?.text ?? pressed;
    } else if (interaction?.action === "click") {
      entry.state = entry.state === "shown" ? "opened" : entry.state;
    } else if (interaction?.action === "close") {
      entry.state = entry.state === "shown" ? "dismissed" : entry.state;
    }
    powertoysEvents.emit("inbox");
    return onInteraction?.(interaction);
  };
  powertoysInboxCallbacks.set(entry.id, { callback: wrapped, options });
  powertoysEvents.emit("inbox");
  return wrapped;
}
/** Whether the request behind an entry still waits for an answer. */
function powertoysInboxAnswerable(entry) {
  if (!powertoysInboxCallbacks.has(entry.id) || entry.state === "answered" || entry.state === "replaced") {
    return false;
  }
  if (entry.actions.length === 0 && !entry.reply) {
    return false;
  }
  if (entry.requestId) {
    return (
      notificationService.blockingRequestIds.has(entry.requestId) ||
      notificationService.activeAskUserQuestionNotifications.has(entry.requestId)
    );
  }
  return entry.state === "shown" || entry.state === "dismissed";
}
function powertoysInboxList() {
  return powertoysInbox.map((entry) => ({ ...entry, answerable: powertoysInboxAnswerable(entry), muted: powertoysSessionMuted(entry.sessionId) }));
}
/** Replays a button press, a typed answer or a click on the body through the notification's own callback. */
function powertoysInboxAnswer(entryId, kind, value) {
  let entry = powertoysInbox.find((other) => other.id === entryId);
  let registered = entry && powertoysInboxCallbacks.get(entry.id);
  if (!registered) {
    throw Error("That notification is no longer available");
  }
  let data = registered.options.data;
  if (kind === "open") {
    registered.callback({ action: "click", data });
  } else {
    if (!powertoysInboxAnswerable(entry)) {
      throw Error("Already answered");
    }
    if (kind === "action") {
      if (!entry.actions.some((action) => action.type === value)) {
        throw Error("Unknown button");
      }
      let item = /^(.*):(\d+)$/.exec(value);
      let isItem = item && (registered.options.actions ?? []).some((action) => action.type === item[1] && Array.isArray(action.selection));
      registered.callback(isItem ? { action: "action", actionType: item[1], selectionIndex: Number(item[2]), data } : { action: "action", actionType: value, data });
    } else if (kind === "reply") {
      registered.callback({ action: "reply", reply: String(value ?? ""), data });
    } else {
      throw Error(`unknown answer kind ${kind}`);
    }
  }
  // The pop-up, if Windows still shows it, is answered now.
  notificationService.backend?.close?.(entry.tag);
  powertoysLog(`inbox: ${kind} on '${entry.title}'${kind === "action" ? ` (${value})` : ""}`);
  powertoysEvents.emit("inbox");
  return powertoysInboxList();
}
function powertoysInboxClear() {
  for (let index = powertoysInbox.length - 1; index >= 0; index--) {
    if (!powertoysInboxAnswerable(powertoysInbox[index])) {
      powertoysInboxCallbacks.delete(powertoysInbox[index].id);
      powertoysInbox.splice(index, 1);
    }
  }
  powertoysEvents.emit("inbox");
  return powertoysInboxList();
}

// --- Per-session mute: the settings key mutedSessions lists session ids ---------------------------
function powertoysSessionMuted(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) {
    return false;
  }
  try {
    let muted = powertoysSetting("mutedSessions");
    return Array.isArray(muted) && muted.includes(sessionId);
  } catch {
    return false;
  }
}
function powertoysSetSessionMuted(sessionId, muted) {
  if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) {
    throw Error("bad session id");
  }
  let list = (powertoysSetting("mutedSessions") ?? []).filter((other) => other !== sessionId);
  if (muted) {
    list.push(sessionId);
  }
  powertoysSetSetting("mutedSessions", list);
  powertoysLog(`notifications ${muted ? "muted" : "unmuted"} for ${sessionId}`);
  return list;
}

// --- Waiting permission requests, answered from the tray ------------------------------------------
/** Pending permission requests that a plain Allow once / Deny can answer, as the notification would. */
function powertoysPendingPermissions() {
  let manager = powertoysSessionManager();
  if (!manager) {
    return [];
  }
  let pending = [];
  for (let record of manager.sessions.values()) {
    for (let request of manager.getPendingRequestsForSession?.(record.sessionId) ?? []) {
      let allowable =
        request.toolName !== "AskUserQuestion" &&
        request.defaultToNo !== true &&
        request.onlyOnCard !== true &&
        !requiresSessionToolApproval(request.toolName, request.input) &&
        !requiresUserInteractionPrompt(request);
      pending.push({
        requestId: request.requestId,
        sessionId: record.sessionId,
        title: powertoysSessionTitle(record),
        toolName: request.toolName,
        description: request.description ?? "",
        allowable,
      });
    }
  }
  return pending;
}
function powertoysAnswerPermission(requestId, decision) {
  notificationService.handlePermissionResponse("ccd", requestId, decision);
  powertoysLog(`tray: permission ${decision} for ${requestId}`);
}
function powertoysPendingPermissionMenuItems() {
  let pending = powertoysPendingPermissions();
  if (pending.length === 0) {
    return [];
  }
  let allowable = pending.filter((request) => request.allowable);
  let label = (request) => `${request.title} · ${formatNotificationToolName(request.toolName)}${request.description ? `: ${request.description}` : ""}`.replace(/\s+/g, " ").replace(/&/g, "&&").slice(0, 110);
  return [
    { label: `Permission requests (${pending.length})`, enabled: false },
    ...pending.slice(0, 10).map((request) => ({
      label: label(request),
      submenu: [
        ...(request.allowable
          ? [
              { label: "Allow once", click: () => powertoysAnswerPermission(request.requestId, "once") },
              { label: "Deny", click: () => powertoysAnswerPermission(request.requestId, "deny") },
              { type: "separator" },
            ]
          : [{ label: "Needs the in-app card", enabled: false }]),
        { label: "Open the session", click: () => powertoysOpenSession(request.sessionId) },
      ],
    })),
    ...(allowable.length > 1
      ? [{ label: `Allow all ${allowable.length} once`, click: () => allowable.forEach((request) => powertoysAnswerPermission(request.requestId, "once")) }]
      : []),
    { type: "separator" },
  ];
}

try {
  powertoysHandle("inbox", (event, operation, ...args) => {
    if (operation === "list") {
      return powertoysInboxList();
    }
    if (operation === "answer") {
      return powertoysInboxAnswer(...args);
    }
    if (operation === "clear") {
      return powertoysInboxClear();
    }
    throw Error(`unknown inbox operation ${operation}`);
  });
  powertoysHandle("muteSession", (event, sessionId, muted) => powertoysSetSessionMuted(sessionId, muted === true));
} catch (caught) {
  logger.error("[powertoys] registering the notification IPC failed: %o", caught);
}

// The page's inbox panel follows changes; the tray menu is rebuilt with the status (sessions/0342).
powertoysEvents.on("inbox", () => powertoysBroadcast("powertoys:inbox", null));
