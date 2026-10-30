// ---------------------------------------------------------------------------------------------
// Powertoys (local addition): the in-page half, in the claude.ai page of the main view.
//
// Runs in the preload's isolated world: it reads and drives the page through the DOM, keeps its
// own UI in a shadow root (styled with the page's colour variables), and reaches the page's
// React state (each pane's entry list and its scrollToEntry) through executeInMainWorld. Settings,
// bookmarks, snippets, transcripts and session status come from the main process
// (main/powertoys/, IPC "powertoys:*"). Every DOM hook is found by test id or English label; when
// one is missing the feature does nothing and says so in main.log ("[powertoys] page: ...").
// ---------------------------------------------------------------------------------------------
/** Large pastes saved by the page module: "<name>|<size>" -> the file on disk. */
const powertoysPastedFiles = new Map();
function powertoysPastedFilePath(file) {
  return powertoysPastedFiles.get(`${file?.name}|${file?.size}`) ?? "";
}
function powertoysPageMain() {
  const ipc = electron.ipcRenderer;
  const call = (name, ...args) => ipc.invoke(`powertoys:${name}`, ...args);
  const log = (message) => {
    call("log", message).catch(() => undefined);
  };
  try {
    electron.contextBridge.executeInMainWorld({ func: powertoysBackslashCopiedPathsInMainWorld, args: [] });
  } catch (caught) {
    log(`copy path: the clipboard hook failed: ${caught?.message ?? caught}`);
  }
  // Folder trust off (disableFolderTrust): before the page's own scripts run, so its first bootstrap is covered.
  if (ipc.sendSync("powertoys:folderTrustDisabled") === true) {
    try {
      electron.contextBridge.executeInMainWorld({ func: powertoysSkipTrustedFolderPromptInMainWorld, args: [] });
    } catch (caught) {
      log(`folder trust: the bootstrap hook failed: ${caught?.message ?? caught}`);
    }
  }
  let settings = null;
  let snippets = [];
  let bookmarkData = { folders: [], bookmarks: [] };
  let pinnedTabs = [];
  let settingsSections = [];
  let openTabs = null; // null until seeded
  let sessionNotes = {}; // sessionId -> one-line note (notes.json)
  let pointer = { x: -1, y: -1 };

  // --- The page's React state, from the main world --------------------------------------------
  // A pane is marked with an attribute (DOM is shared between worlds), and the function finds
  // React's fiber on it. Entry ids are the transcript row ids (data-epitaxy-entry).
  function mainWorld(operation, element, argument) {
    let marker = Math.random().toString(36).slice(2);
    element?.setAttribute("data-powertoys-target", marker);
    try {
      return electron.contextBridge.executeInMainWorld({
        func: powertoysMainWorldOperation,
        args: [operation, element ? marker : null, argument ?? null],
      });
    } catch (caught) {
      log(`main-world ${operation} failed: ${caught?.message ?? caught}`);
      return null;
    } finally {
      element?.removeAttribute("data-powertoys-target");
    }
  }

  // --- Panes (split view shows several sessions side by side) ----------------------------------
  const TRANSCRIPT = '[data-testid="epitaxy-virtual-transcript"]';
  const isShown = (element) => {
    let rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  function panes() {
    return [...document.querySelectorAll(TRANSCRIPT)].filter(isShown).map((transcript) => ({
      transcript,
      root: transcript.closest("[data-tile-host]") ?? transcript.parentElement?.parentElement ?? document.body,
    }));
  }
  function paneOf(element) {
    return panes().find((pane) => pane.root.contains(element)) ?? null;
  }
  /** The pane keyboard actions apply to: the one with focus, else the one under the pointer, else the first. */
  function activePane() {
    let all = panes();
    let focused = all.find((pane) => pane.root.contains(document.activeElement));
    if (focused) {
      return focused;
    }
    let under = pointer.x >= 0 ? document.elementFromPoint(pointer.x, pointer.y) : null;
    return all.find((pane) => under && pane.root.contains(under)) ?? all[0] ?? null;
  }
  function paneEditor(pane) {
    return pane?.root.querySelector('.ProseMirror[contenteditable="true"]') ?? null;
  }
  function paneSessionId(pane) {
    let info = pane ? mainWorld("pane", pane.transcript) : null;
    if (info?.sessionId) {
      return info.sessionId;
    }
    let match = /^\/epitaxy\/([^/?#]+)/.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  }
  function paneEntries(pane) {
    return (pane && mainWorld("entries", pane.transcript)) ?? [];
  }
  function loadButton(pane, which) {
    let label = which === "earlier" ? "Load earlier messages" : "Load later messages";
    return [...pane.root.querySelectorAll("button")].find((button) => button.textContent.trim() === label) ?? null;
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Presses Load earlier / later once and waits for the entry list to grow; false when there is nothing more. */
  async function loadMore(pane, which) {
    let button = loadButton(pane, which);
    if (!button) {
      return false;
    }
    // The page keeps a sliding window of entries: loading earlier ones can drop later ones, so
    // the window's ends tell that something loaded, not its length.
    let ends = () => {
      let entries = paneEntries(pane);
      return `${entries.length}:${entries[0]?.id}:${entries.at(-1)?.id}`;
    };
    let before = ends();
    button.click();
    for (let waited = 0; waited < 4000; waited += 100) {
      await sleep(100);
      if (ends() !== before) {
        return true;
      }
    }
    log(`load ${which}: nothing loaded within 4 s`);
    return false;
  }
  /** Scrolls the pane to an entry, loading earlier / later messages until it is in the list. */
  async function revealEntry(pane, keys, { direction = "earlier", maxLoads = 40 } = {}) {
    keys = keys.filter(Boolean);
    for (let loads = 0; loads <= maxLoads; loads++) {
      let entries = paneEntries(pane);
      let key = keys.find((candidate) => entries.some((entry) => entry.id === candidate));
      if (key) {
        return !!mainWorld("scrollTo", pane.transcript, key) || scrollRowIntoView(pane, key);
      }
      if (!(await loadMore(pane, direction))) {
        if (direction === "earlier" && loadButton(pane, "later")) {
          direction = "later";
          continue;
        }
        return false;
      }
    }
    return false;
  }
  function scrollRowIntoView(pane, key) {
    let row = [...pane.transcript.querySelectorAll("[data-epitaxy-entry]")].find((element) => element.getAttribute("data-epitaxy-entry") === key);
    row?.scrollIntoView({ block: "start", behavior: "smooth" });
    return !!row;
  }
  const normalize = (text) =>
    String(text ?? "")
      .replace(/^\s*(\d+[.)]|[-*+]|#{1,6}|>)\s+/gm, "")
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  // --- Focus -----------------------------------------------------------------------------------
  function deepActiveElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) {
      element = element.shadowRoot.activeElement;
    }
    return element;
  }
  function inPromptBox() {
    let element = deepActiveElement();
    return !!element?.closest?.('.ProseMirror[contenteditable="true"]') && !!element.closest('[data-cds="ChatComposerEditor"], [data-testid="code-prompt-input"]');
  }
  /** A text field other than the prompt box (terminal, Files editor, a dialog's input) has focus. */
  function inOtherTextField() {
    let element = deepActiveElement();
    if (!element || element === document.body || inPromptBox()) {
      return false;
    }
    return (
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT" ||
      element.tagName === "IFRAME" ||
      element.isContentEditable ||
      !!element.closest?.(".xterm, .cm-editor, .monaco-editor, [role='dialog'] input")
    );
  }
  function inDialog() {
    return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]');
  }

  // --- Typing into the prompt box --------------------------------------------------------------
  /** Inserts text at the cursor of a prompt box; line breaks are Shift+Enter, so nothing is sent. */
  function insertIntoEditor(editor, text) {
    if (!editor) {
      log("insert: no prompt box on screen");
      return false;
    }
    editor.focus();
    text.split(/\r?\n/).forEach((line, index) => {
      if (index > 0) {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
      }
      if (line !== "") {
        document.execCommand("insertText", false, line);
      }
    });
    return true;
  }

  // --- UI root ----------------------------------------------------------------------------------
  let shadow = null;
  let uiHost = null;
  let inlineEditing = null; // { onKey(event) } while a rename field is open
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: var(--font-anthropic-sans, "Segoe UI", system-ui, sans-serif); }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
    .panel { pointer-events: auto; position: fixed; background: hsl(var(--bg-000, 60 2% 12%)); color: hsl(var(--text-100, 60 14% 97%));
      border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.15); border-radius: 12px; box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
      font-size: 13px; line-height: 1.35; overflow: hidden; }
    .list { max-height: 60vh; overflow-y: auto; padding: 4px; }
    .row { display: flex; gap: 10px; align-items: baseline; padding: 7px 10px; border-radius: 7px; cursor: default; white-space: nowrap; }
    .row.sel { background: hsl(var(--bg-300, 0 0% 5%)); outline: 1px solid hsl(var(--accent-100, 212 75% 62%) / 0.6); }
    .row:hover:not(.sel) { background: hsl(var(--bg-200, 0 0% 7%)); }
    .row .main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .row .two { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .row .two > * { overflow: hidden; text-overflow: ellipsis; }
    .row .two.colored { border-inline-start: 3px solid var(--pt-project); padding-inline-start: 8px; }
    .dim { color: hsl(var(--text-400, 48 5% 57%)); font-size: 12px; }
    .num { color: hsl(var(--text-400, 48 5% 57%)); width: 1.2em; text-align: right; flex: none; }
    .state-needsYou { color: hsl(var(--danger-100, 0 72% 65%)); }
    .state-newReply { color: hsl(var(--accent-100, 212 75% 62%)); }
    .state-working { color: hsl(var(--brand-100, 15 63% 60%)); }
    .title { padding: 9px 12px 5px; font-weight: 600; font-size: 12px; color: hsl(var(--text-300, 55 9% 74%)); }
    .empty { padding: 12px; color: hsl(var(--text-400, 48 5% 57%)); }
    mark { background: hsl(var(--accent-100, 212 75% 62%) / 0.35); color: inherit; border-radius: 3px; }
    input.search { width: 100%; border: 0; outline: 0; background: transparent; color: inherit; font-size: 15px; padding: 12px 14px;
      border-bottom: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.12); }
    .flash { pointer-events: none; position: fixed; padding: 6px 10px; border-radius: 8px; background: hsl(var(--bg-000, 60 2% 12%));
      border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); color: hsl(var(--text-100, 60 14% 97%)); font-size: 13px; box-shadow: 0 6px 20px rgb(0 0 0 / .4); }
    .outline-button { pointer-events: auto; position: fixed; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
      background: hsl(var(--bg-000, 60 2% 12%)); color: hsl(var(--text-200, 55 9% 74%)); border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.18);
      cursor: pointer; font-size: 15px; box-shadow: 0 2px 8px rgb(0 0 0 / .3); }
    .outline-button:hover { color: hsl(var(--text-000, 60 14% 97%)); background: hsl(var(--bg-200, 0 0% 7%)); }
    .menu { min-width: 220px; padding: 4px; }
    .menu .item { padding: 6px 10px; border-radius: 6px; white-space: nowrap; display: flex; justify-content: space-between; gap: 16px; }
    .menu .item:hover, .menu .item.sel { background: hsl(var(--bg-300, 0 0% 5%)); }
    .menu .item.disabled { color: hsl(var(--text-500, 48 5% 57%)); }
    .menu .sep { height: 1px; margin: 4px 6px; background: hsl(var(--border-300, 52 12% 87%) / 0.12); }
    .backdrop { pointer-events: auto; position: fixed; inset: 0; background: rgb(0 0 0 / 0.45); }
    .manager { inset: 6vh 8vw; display: grid; grid-template-columns: 240px 1fr; grid-template-rows: auto 1fr; }
    .manager .head { grid-column: 1 / 3; display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
      border-bottom: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.12); font-weight: 600; }
    .manager .side { border-right: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.12); padding: 8px; overflow-y: auto; }
    .manager .side input { width: 100%; margin-bottom: 8px; padding: 7px 9px; border-radius: 7px; border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.18);
      background: hsl(var(--bg-100, 0 0% 8%)); color: inherit; outline: 0; }
    .manager .folder { padding: 6px 10px; border-radius: 7px; display: flex; justify-content: space-between; cursor: default; }
    .manager .folder.sel { background: hsl(var(--bg-300, 0 0% 5%)); }
    .manager .folder.drop { outline: 2px dashed hsl(var(--accent-100, 212 75% 62%) / 0.8); }
    .manager .content { display: flex; flex-direction: column; min-height: 0; }
    .manager .bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; }
    .chip { padding: 3px 10px; border-radius: 999px; border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); cursor: pointer; font-size: 12px;
      background: transparent; color: inherit; }
    .manager .list { max-height: none; flex: 1; }
    .manager .row { white-space: normal; }
    .manager .row .two > :first-child { white-space: nowrap; }
    .manager .row .two > .dim { white-space: nowrap; }
    .iconbtn { background: transparent; border: 0; color: inherit; cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 6px; }
    .iconbtn:hover { background: hsl(var(--bg-300, 0 0% 5%)); }
    .tabs { pointer-events: none; position: fixed; display: flex; align-items: center; gap: 4px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tabs > .tab { flex-shrink: 0; }
    .tab { pointer-events: auto; -webkit-app-region: no-drag; app-region: no-drag; display: flex; align-items: center; gap: 6px; height: 26px;
      padding: 0 10px; border-radius: 7px; min-width: 44px; max-width: 190px; flex: 0 1 auto; cursor: pointer; font-size: 12.5px;
      color: hsl(var(--text-300, 55 9% 74%)); background: transparent; border: 1px solid transparent; white-space: nowrap; }
    .tab:hover { background: hsl(var(--bg-300, 0 0% 5%)); color: hsl(var(--text-100, 60 14% 97%)); }
    /* The tab on screen: raised, bold, framed all round in its project's color (the brand color for a
       tab without one; 2px, padding and height give back the extra pixel, so the bar does not move);
       the others step back a little. */
    .tabs .tab.current { background: hsl(var(--bg-000, 60 2% 12%)); color: hsl(var(--text-000, 0 0% 100%)); font-weight: 600;
      border: 2px solid var(--pt-project, hsl(var(--brand-100, 15 63% 60%))); padding: 0 9px; height: 24px; box-shadow: 0 1px 4px rgb(0 0 0 / 0.35); }
    .tabs:has(.tab.current) .tab:not(.current):not(:hover):not(.more) { opacity: 0.72; }
    .tab.view .label { font-style: italic; }
    /* Side by side: the other sessions on screen. */
    .tab.onscreen { opacity: 1 !important; color: hsl(var(--text-100, 60 14% 97%)); border-color: color-mix(in srgb, var(--pt-project, hsl(var(--brand-100, 15 63% 60%))) 45%, transparent); }
    /* While a tab is dragged: where dropping it opens it side by side with the conversation on screen. */
    .split-drop { position: fixed; pointer-events: auto; display: grid; place-items: center; border-radius: 12px;
      border: 2px dashed hsl(var(--brand-100, 15 63% 60%) / 0.8); background: hsl(var(--brand-100, 15 63% 60%) / 0.10);
      color: hsl(var(--text-100, 60 14% 97%)); font-size: 14px; font-weight: 600; }
    .split-drop.over { background: hsl(var(--brand-100, 15 63% 60%) / 0.24); }
    .tab .label { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .tab .pin { font-size: 10px; opacity: .7; flex: none; }
    .tab .dot { width: 13px; height: 13px; border-radius: 50%; flex: none; display: grid; place-items: center; font-size: 9px; font-weight: 700; line-height: 1; color: #fff; }
    .tab .dot.needsYou { background: hsl(var(--danger-100, 0 72% 65%)); }
    .tab .dot.working { width: 7px; height: 7px; margin: 0 3px; background: hsl(var(--brand-100, 15 63% 60%)); animation: pt-pulse 1.2s ease-in-out infinite; }
    .tab .dot.done { background: hsl(var(--accent-100, 212 75% 62%)); }
    .tab .dot.error { background: hsl(var(--danger-100, 0 72% 65%)); border-radius: 3px; }
    .tab .muted { flex: none; font-size: 11px; opacity: .7; }
    .tab.colored { border-bottom: 2px solid var(--pt-project); }
    /* Tabs grouped by project: a gap before each project's first tab. */
    .tab.group-start { margin-inline-start: 10px; }
    .tab .split-badge { flex: none; font-size: 11px; padding: 0 4px; border-radius: 4px; background: hsl(var(--bg-300, 0 0% 5%)); color: hsl(var(--text-200, 50 9% 87%)); cursor: pointer; }
    .tab .split-badge:hover { background: hsl(var(--bg-400, 0 0% 4%)); }
    /* Hovering a conversation's tab: its last answer (see showTabPreview). */
    .tab-preview { position: fixed; z-index: 2147483000; pointer-events: none; width: min(480px, calc(100vw - 32px)); max-height: 55vh; overflow: hidden;
      padding: 10px 12px; border-radius: 10px; border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.25); background: hsl(var(--bg-000, 60 2% 12%));
      color: hsl(var(--text-100, 60 14% 97%)); box-shadow: 0 6px 24px rgb(0 0 0 / 0.45); font-size: 12.5px; line-height: 1.45; }
    .tab-preview .head { font-weight: 600; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tab-preview .meta { color: hsl(var(--text-300, 55 9% 74%)); font-size: 11.5px; margin-bottom: 8px; }
    .tab-preview .note { color: hsl(var(--accent-100, 212 75% 62%)); font-size: 12px; margin-bottom: 2px; }
    .tab-preview .body { overflow-wrap: anywhere; }
    .tab-preview .body > :first-child { margin-top: 0; }
    .tab-preview .body p, .tab-preview .body ul, .tab-preview .body ol, .tab-preview .body pre, .tab-preview .body table, .tab-preview .body blockquote { margin: 0 0 6px; }
    .tab-preview .body ul, .tab-preview .body ol { padding-inline-start: 18px; }
    .tab-preview .body li { margin: 1px 0; }
    .tab-preview .body .h { font-weight: 650; margin: 8px 0 3px; }
    .tab-preview .body .h1, .tab-preview .body .h2 { font-size: 13.5px; }
    .tab-preview .body code { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; background: hsl(var(--bg-300, 0 0% 5%)); border-radius: 4px; padding: 0 3px; }
    .tab-preview .body pre { background: hsl(var(--bg-300, 0 0% 5%)); border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; }
    .tab-preview .body pre code { background: none; padding: 0; }
    .tab-preview .body table { border-collapse: collapse; font-size: 11.5px; }
    .tab-preview .body th, .tab-preview .body td { border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); padding: 2px 6px; text-align: start; }
    .tab-preview .body blockquote { border-inline-start: 3px solid hsl(var(--border-300, 52 12% 87%) / 0.35); padding-inline-start: 8px; color: hsl(var(--text-300, 55 9% 74%)); }
    .tab-preview .body hr { border: 0; border-top: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); margin: 6px 0; }
    .tab-preview .body .link { text-decoration: underline; }
    .tab-preview .body.empty { color: hsl(var(--text-400, 48 5% 57%)); font-style: italic; }
    .menu .item .swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; margin-right: 8px; display: inline-grid; place-items: center; font-size: 8px; color: hsl(var(--text-400, 48 5% 57%)); border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.25); }
    .tab .sched { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: hsl(var(--text-300, 55 9% 74%)); }
    /* A PR's checks on its session's tab, and the session's queued prompts. */
    .tab .ci { flex: none; font-size: 11px; font-weight: 700; cursor: pointer; }
    .tab .ci.passed { color: #3fb950; }
    .tab .ci.failed { color: #f85149; }
    .tab .ci.pending { color: #d29922; }
    .tab .queued { flex: none; font-size: 11px; cursor: pointer; color: hsl(var(--text-300, 55 9% 74%)); }
    /* The context map window. */
    .history.ctxmap { inset: 4vh 5vw; }
    .ctxmap .body { flex: 1; overflow: auto; padding: 12px 18px 20px; display: flex; flex-direction: column; gap: 18px; font-size: 13px; }
    .ctxmap .summary { font-size: 13.5px; color: hsl(var(--text-200, 50 9% 87%)); }
    .ctxmap h3 { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; color: hsl(var(--text-300, 55 9% 74%)); }
    .ctxmap .bar { display: flex; height: 22px; border-radius: 6px; overflow: hidden; margin-bottom: 8px; }
    .ctxmap .bar > span { height: 100%; min-width: 1px; }
    .ctxmap .bar .free { background: hsl(var(--text-500, 40 3% 50%) / 0.15); }
    .ctxmap .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; margin-bottom: 6px; }
    .ctxmap .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; flex: none; }
    .ctxmap .note { font-size: 11.5px; color: hsl(var(--text-400, 48 5% 57%)); margin-top: 4px; }
    .ctxmap .chart { position: relative; color: hsl(var(--text-300, 55 9% 74%)); }
    .ctxmap .chart svg { display: block; width: 100%; height: auto; }
    .ctxmap .tip { position: absolute; pointer-events: none; max-width: 380px; padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 1.45;
      background: hsl(var(--bg-000, 0 0% 12%)); color: hsl(var(--text-100, 60 14% 97%)); border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); box-shadow: 0 6px 24px rgb(0 0 0 / 0.35); }
    .ctxmap .tip .dim { color: hsl(var(--text-300, 55 9% 74%)); }
    .ctxmap .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; }
    .history.topic { inset: 8vh 18vw; }
    .ctxmap a.link { color: hsl(var(--accent-100, 212 75% 62%)); text-decoration: none; cursor: pointer; }
    .ctxmap a.link:hover { text-decoration: underline; }
    .ctxmap .h3row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .ctxmap .h3row h3 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctxmap .seg { display: inline-flex; flex: none; border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); border-radius: 6px; overflow: hidden; }
    .ctxmap .seg button { padding: 2px 9px; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 11.5px; }
    .ctxmap .seg button.on { background: hsl(var(--accent-100, 212 75% 62%) / 0.85); color: #fff; }
    .ctxmap .rows .r { display: grid; grid-template-columns: 4.4em minmax(0, 1fr) auto; column-gap: 10px; align-items: center; padding: 4px 6px; border-radius: 6px; font-size: 12.5px; }
    .ctxmap .rows .r[title] { cursor: pointer; }
    .ctxmap .rows .r:hover { background: hsl(var(--bg-300, 0 0% 5%)); }
    .ctxmap .rows .size { text-align: right; font-variant-numeric: tabular-nums; color: hsl(var(--text-200, 50 9% 87%)); }
    .ctxmap .rows .label { display: flex; align-items: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .ctxmap .rows .when { font-size: 11.5px; color: hsl(var(--text-400, 48 5% 57%)); font-variant-numeric: tabular-nums; }
    .tab.more { flex: none; max-width: none; }
    .tab.dragging { opacity: .45; }
    .tab.drop-before { box-shadow: inset 2px 0 0 hsl(var(--accent-100, 212 75% 62%)); }
    .tab.drop-after { box-shadow: inset -2px 0 0 hsl(var(--accent-100, 212 75% 62%)); }
    .tab .close { flex: none; width: 16px; height: 16px; margin-inline-end: -4px; border-radius: 4px; display: grid; place-items: center;
      font-size: 13px; line-height: 1; color: hsl(var(--text-400, 48 5% 57%)); visibility: hidden; }
    .tab:hover .close, .tab.current .close { visibility: visible; }
    .tab .close:hover { background: hsl(var(--bg-400, 0 0% 4%)); color: hsl(var(--text-100, 60 14% 97%)); }
    @keyframes pt-pulse { 50% { opacity: .35; } }
    .history { inset: 5vh 10vw; display: flex; flex-direction: column; }
    .history .head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.12); }
    .history .head input { flex: 1; padding: 8px 11px; border-radius: 8px; border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.18);
      background: hsl(var(--bg-100, 0 0% 8%)); color: inherit; outline: 0; font-size: 14px; }
    .history .list { max-height: none; flex: 1; padding: 4px 12px 16px; }
    .history .day { position: sticky; top: 0; padding: 12px 6px 6px; font-weight: 600; font-size: 12.5px; color: hsl(var(--text-300, 55 9% 74%));
      background: hsl(var(--bg-000, 60 2% 12%)); z-index: 1; }
    /* Fixed columns: time, author icon, text, conversation; each cell clips on its own. */
    .history .row { display: grid; grid-template-columns: 5.4em 18px minmax(0, 1fr) minmax(120px, 26%); column-gap: 12px; white-space: nowrap; align-items: center; }
    .history .time { overflow: hidden; color: hsl(var(--text-400, 48 5% 57%)); font-size: 12px; font-variant-numeric: tabular-nums; }
    .history .who { width: 18px; height: 18px; display: grid; place-items: center; }
    .history .who svg { width: 15px; height: 15px; }
    .history .who.you { color: hsl(var(--text-300, 55 9% 74%)); }
    .history .who.claude { color: hsl(var(--brand-100, 15 63% 60%)); }
    .history .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .history .where { min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: end; color: hsl(var(--text-400, 48 5% 57%)); font-size: 12px; }
    .history .row.offline { opacity: .65; }
    .settings { inset: 5vh 18vw; display: flex; flex-direction: column; }
    .settings .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; font-weight: 600;
      border-bottom: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.12); }
    .settings .body { overflow-y: auto; padding: 4px 18px 18px; }
    .settings h3 { margin: 16px 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: hsl(var(--text-400, 48 5% 57%)); }
    .settings .item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 7px 0;
      border-bottom: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.06); }
    .settings .item label { flex: 1; }
    .settings input[type=text], .settings input[type=number] { width: 220px; padding: 5px 8px; border-radius: 6px; color: inherit;
      border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.18); background: hsl(var(--bg-100, 0 0% 8%)); outline: 0; font: inherit; }
    .settings input[type=number] { width: 80px; }
    .settings .toggle { width: 34px; height: 20px; border-radius: 10px; background: hsl(var(--bg-400, 0 0% 4%)); position: relative; cursor: pointer; flex: none;
      border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); }
    .settings .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
      background: hsl(var(--text-400, 48 5% 57%)); transition: left .12s; }
    .settings .toggle.on { background: hsl(var(--accent-100, 212 75% 62%) / 0.85); }
    .settings .toggle.on::after { left: 16px; background: #fff; }
    .settings .langs { width: 260px; max-height: 140px; overflow-y: auto; padding: 4px 8px; border-radius: 6px;
      border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.18); background: hsl(var(--bg-100, 0 0% 8%)); }
    .settings .langs label { display: flex; gap: 6px; align-items: center; padding: 2px 0; font-size: 12.5px; }
    button.action { padding: 5px 12px; border-radius: 6px; cursor: pointer; color: inherit; font: inherit;
      border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.2); background: hsl(var(--bg-200, 0 0% 7%)); }
    .inbox .row { display: grid; grid-template-columns: 4.8em minmax(0, 1fr) auto; column-gap: 12px; white-space: normal; align-items: start; }
    .inbox .row .body { color: hsl(var(--text-300, 55 9% 74%)); font-size: 12.5px; max-height: 3.4em; overflow: hidden; }
    .inbox .row .acts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; max-width: 340px; }
    .inbox .row .acts input { width: 150px; padding: 4px 7px; border-radius: 6px; color: inherit; font: inherit; border: 1px solid hsl(var(--border-300, 52 12% 87%) / 0.18); background: hsl(var(--bg-100, 0 0% 8%)); outline: 0; }
    .inbox .chip { font-size: 11px; padding: 1px 7px; border-radius: 9px; background: hsl(var(--bg-300, 0 0% 5%)); color: hsl(var(--text-400, 48 5% 57%)); }
    .inbox .chip.waiting { background: hsl(var(--danger-100, 0 72% 65%) / 0.2); color: hsl(var(--danger-100, 0 72% 65%)); }
    .away .row { display: flex; white-space: normal; align-items: start; padding: 9px 10px; cursor: pointer; }
    .away .row .two { flex: 1; min-width: 0; gap: 3px; }
    .away .row .two > * { white-space: normal; overflow: visible; }
    .palette .row .key { margin-left: auto; color: hsl(var(--text-400, 48 5% 57%)); font-size: 11.5px; }
    .rename { width: 100%; padding: 2px 4px; background: hsl(var(--bg-100, 0 0% 8%)); color: inherit; border: 1px solid hsl(var(--accent-100, 212 75% 62%)); border-radius: 4px; font: inherit; }
    .timeline-row { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
    .timeline-name { width: 230px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; font-size: 12px; }
    .timeline-bar { position: relative; flex: 1; height: 12px; border-radius: 3px; background: hsl(var(--bg-300, 0 0% 5%) / 0.7); }
    .timeline-working, .timeline-waiting { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
    .timeline-working { background: hsl(var(--accent-100, 212 75% 62%)); }
    .timeline-waiting { background: hsl(30 90% 55%); }
    .panel textarea.search { width: 100%; min-height: 96px; resize: vertical; font: inherit; }
    .panel .check { display: flex; gap: 6px; align-items: center; padding: 2px 4px; cursor: pointer; }
    .message-time { position: fixed; pointer-events: none; padding: 1px 7px; border-radius: 7px; font-size: 11px; line-height: 16px; white-space: nowrap; background: hsl(var(--bg-300, 0 0% 5%) / 0.92); color: hsl(var(--text-300, 48 5% 70%)); border: 0.5px solid hsl(var(--border-300, 0 0% 50%) / 0.25); }
  `;
  let layer = null;
  function ui() {
    if (!shadow) {
      let host = document.createElement("div");
      host.id = "claude-powertoys";
      document.documentElement.appendChild(host);
      uiHost = host;
      shadow = host.attachShadow({ mode: "open" });
      let style = document.createElement("style");
      style.textContent = STYLE;
      shadow.appendChild(style);
      layer = document.createElement("div");
      layer.className = "layer";
      shadow.appendChild(layer);
    }
    return layer;
  }
  function element(tag, className, text) {
    let node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }
  /** Text with every query word wrapped in <mark>. */
  function highlighted(text, terms) {
    let span = element("span");
    let lower = text.toLowerCase();
    let marks = [];
    for (let term of terms) {
      for (let at = lower.indexOf(term); at >= 0 && term; at = lower.indexOf(term, at + term.length)) {
        marks.push([at, at + term.length]);
      }
    }
    marks.sort((left, right) => left[0] - right[0]);
    let position = 0;
    for (let [start, end] of marks) {
      if (start < position) {
        continue;
      }
      span.append(text.slice(position, start), element("mark", "", text.slice(start, end)));
      position = end;
    }
    span.append(text.slice(position));
    return span;
  }
  function flash(text, x = pointer.x, y = pointer.y) {
    let note = element("div", "flash", text);
    ui().appendChild(note);
    note.style.left = `${Math.max(8, Math.min(innerWidth - 200, x + 12))}px`;
    note.style.top = `${Math.max(8, y - 36)}px`;
    setTimeout(() => note.remove(), 1400);
  }
  /**
   * Keeps keyboard focus in a Powertoys window's field while it is open: the page moves focus to a
   * prompt box when you type, which would send the keystrokes there. Returns the release function.
   */
  function holdFocus(input, stillOpen) {
    let onFocusIn = (event) => {
      if (stillOpen() && event.target !== uiHost) {
        setTimeout(() => stillOpen() && input.isConnected && input.focus(), 0);
      }
    };
    document.addEventListener("focusin", onFocusIn, true);
    for (let delay of [0, 50, 250]) {
      setTimeout(() => stillOpen() && input.isConnected && input.focus(), delay);
    }
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }
  const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();
  function ago(ms) {
    let minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    if (minutes < 24 * 60) {
      return `${Math.round(minutes / 60)} h ago`;
    }
    return new Date(ms).toLocaleDateString();
  }

  // --- Popups: one transient popup at a time, closed by Esc, a click outside, or the window losing focus.
  let popup = null; // { node, onKey(event) -> handled, close() }
  function closePopup() {
    let current = popup;
    popup = null;
    current?.node.remove();
    current?.onClose?.();
  }
  function openPopup(node, { onKey, onClose } = {}) {
    closePopup();
    ui().appendChild(node);
    popup = { node, onKey, onClose };
    return popup;
  }
  /**
   * A keyboard-driven list. items: [{ label | render(), detail?, value }]. Returns controls for
   * moving the selection from outside (the Ctrl+Tab and Alt+Up lists move while a modifier is held).
   */
  function listPopup({ title, items, place, selected = 0, onPick, numbered = false, emptyText = "Nothing to show", width = 520, reverse = false }) {
    let panel = element("div", "panel");
    panel.style.width = `${Math.min(width, innerWidth - 32)}px`;
    if (title) {
      panel.appendChild(element("div", "title", title));
    }
    let list = element("div", "list");
    panel.appendChild(list);
    let rows = [];
    let draw = () =>
      rows.forEach((row, index) => {
        row.classList.toggle("sel", index === selected);
        if (index === selected) {
          row.scrollIntoView({ block: "nearest" });
        }
      });
    let order = reverse ? [...items.keys()].reverse() : [...items.keys()];
    for (let index of order) {
      let item = items[index];
      let row = element("div", "row");
      if (numbered && index < 9) {
        row.appendChild(element("span", "num", String(index + 1)));
      }
      if (item.render) {
        row.appendChild(item.render());
      } else {
        row.appendChild(element("span", "main", item.label));
        if (item.detail) {
          row.appendChild(element("span", "dim", item.detail));
        }
      }
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        controls.pick(index);
      });
      row.addEventListener("mousemove", () => {
        if (selected !== index) {
          selected = index;
          draw();
        }
      });
      rows[index] = row;
      list.appendChild(row);
    }
    if (items.length === 0) {
      list.appendChild(element("div", "empty", emptyText));
    }
    let controls = {
      move(delta) {
        if (items.length) {
          selected = (selected + delta + items.length) % items.length;
          draw();
        }
      },
      get selected() {
        return selected;
      },
      pick(index = selected) {
        let item = items[index];
        closePopup();
        if (item) {
          onPick(item.value, index);
        }
      },
    };
    let state = openPopup(panel, {
      onKey(event) {
        if (event.type !== "keydown") {
          return false;
        }
        if (event.code === "Escape") {
          closePopup();
          return true;
        }
        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
          controls.move((event.code === "ArrowDown") !== reverse ? 1 : -1);
          return true;
        }
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          controls.pick();
          return true;
        }
        if (numbered && /^Digit[1-9]$/.test(event.code) && !event.ctrlKey && !event.altKey) {
          let index = Number(event.code.slice(5)) - 1;
          if (index < items.length) {
            controls.pick(index);
          }
          return true;
        }
        return false;
      },
    });
    place(panel);
    draw();
    controls.state = state;
    return controls;
  }
  /** Places a panel just above a rectangle (the prompt box), else centred. */
  function placeAbove(rect) {
    return (panel) => {
      let height = panel.getBoundingClientRect().height;
      let width = panel.getBoundingClientRect().width;
      panel.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect ? rect.left : (innerWidth - width) / 2))}px`;
      panel.style.top = `${Math.max(8, rect ? rect.top - height - 10 : innerHeight / 4)}px`;
    };
  }
  function placeCentred(top = 0.18) {
    return (panel) => {
      let width = panel.getBoundingClientRect().width;
      panel.style.left = `${(innerWidth - width) / 2}px`;
      panel.style.top = `${Math.round(innerHeight * top)}px`;
    };
  }
  function placeAt(x, y) {
    return (panel) => {
      let rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, x))}px`;
      panel.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, y))}px`;
    };
  }
  /** A context menu. items: [{ label, onClick, disabled, submenu: items } | "-"]. */
  function contextMenu(items, x, y, parent = null) {
    let panel = element("div", "panel menu");
    for (let item of items) {
      if (item === "-") {
        panel.appendChild(element("div", "sep"));
        continue;
      }
      let row = element("div", `item${item.disabled ? " disabled" : ""}`);
      if (item.swatch !== undefined) {
        let swatch = element("span", "swatch", item.swatch ? "" : "A");
        if (item.swatch) {
          swatch.style.background = item.swatch;
        }
        row.appendChild(swatch);
      }
      row.appendChild(element("span", "", `${item.checked ? "✓ " : ""}${item.label}`));
      if (item.submenu) {
        row.appendChild(element("span", "dim", "›"));
      }
      row.addEventListener("mouseenter", () => {
        panel.querySelectorAll(".panel").forEach((child) => child.remove());
        if (item.submenu) {
          let rect = row.getBoundingClientRect();
          contextMenu(item.submenu, rect.right - 4, rect.top - 4, panel);
        }
      });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (item.disabled || item.submenu) {
          return;
        }
        closePopup();
        item.onClick?.();
      });
      panel.appendChild(row);
    }
    if (parent) {
      parent.appendChild(panel);
    } else {
      openPopup(panel, {
        onKey: (event) => {
          if (event.type === "keydown" && event.code === "Escape") {
            closePopup();
            return true;
          }
          return false;
        },
      });
    }
    placeAt(x, y)(panel);
    return panel;
  }

  // --- Sidebar: resize handle and auto-hide ------------------------------------------------------
  let resizeHandleCss = null;
  function applySidebarCss() {
    let want = !!settings?.removeResizeHandle;
    if (want && !resizeHandleCss) {
      resizeHandleCss = electron.webFrame.insertCSS(
        '[data-cds="ResizeHandle"][aria-label="Resize sidebar"], .dframe-sidebar-edge { pointer-events: none !important; cursor: auto !important; }',
        { cssOrigin: "author" },
      );
    } else if (!want && resizeHandleCss) {
      electron.webFrame.removeInsertedCSS(resizeHandleCss);
      resizeHandleCss = null;
    }
  }
  const EDGE_PX = 12;
  let peekArmed = true;
  // Only a maximized (or full-screen) window's left edge is the screen's: elsewhere the pointer crosses it on its way
  // to other windows (powertoys:window from the main process).
  let windowMaximized = true;
  /** The collapsed sidebar's "Show sidebar" button; absent while the sidebar is docked. */
  function showSidebarButton() {
    return [...document.querySelectorAll('button[aria-label="Show sidebar"]')].find(isShown) ?? null;
  }
  function onPointerMoveForSidebar(event) {
    if (!settings?.autoHideSidebar || !windowMaximized || event.pointerType !== "mouse" || !event.isTrusted) {
      return;
    }
    if (event.clientX > EDGE_PX + 30) {
      peekArmed = true;
    }
    if (event.clientX > EDGE_PX || !peekArmed || event.buttons !== 0) {
      return;
    }
    let button = showSidebarButton();
    if (!button || button.getAttribute("aria-expanded") === "true") {
      return;
    }
    peekArmed = false;
    // The page opens its floating sidebar from the Show sidebar button's hover handler; calling that
    // handler (after its leave handler, which clears "suppressed until the pointer leaves") opens it
    // at once. The sidebar then closes by itself when the pointer leaves it.
    if (!mainWorld("openPeek", button)) {
      log("auto-hide: the floating sidebar trigger was not found");
    }
  }

  // --- Ctrl+Tab session switcher -------------------------------------------------------------
  let switcher = null; // { controls | null, wantDelta, released, list }
  function switcherRow(item) {
    return () => {
      let wrap = element("span", "two");
      // The project's color, as on its tab.
      let project = tabRows.find((row) => (item.tab ? row.kind === item.tab.kind && row.id === item.tab.id : row.kind === "code" && row.id === item.sessionId))?.project;
      if (settings?.colorProjects && project) {
        wrap.classList.add("colored");
        wrap.style.setProperty("--pt-project", projectColor(project.key));
      }
      wrap.appendChild(element("span", "", item.title));
      let note = item.sessionId ? sessionNotes[item.sessionId] : "";
      let stateText = item.stateLabel && item.stateLabel + (item.turnAge ? ` ${item.turnAge}` : "");
      let extra = item.sessionId ? tabExtras[item.sessionId] : null;
      let ci = ciOf(extra);
      let details = [
        note && `✎ ${note}`,
        item.folder,
        stateText,
        extra?.topic?.ticket ? `🎫 ${extra.topic.ticket.id}` : "",
        item.sessionId ? taskShort(item.sessionId) : "",
        ci?.checks ? `${CI_GLYPHS[ci.checks]} ${ciText(ci)}` : "",
        extra?.queued ? `⏭ ${extra.queued} queued` : "",
        item.contextTokens ? `${Math.round(item.contextTokens / 1000)}k context` : "",
      ].filter(Boolean);
      let detail = element("span", "dim");
      details.forEach((text, index) => {
        if (index) {
          detail.append("  ·  ");
        }
        detail.appendChild(element("span", text === stateText && item.state ? `state-${item.state}` : "", text));
      });
      wrap.appendChild(detail);
      return wrap;
    };
  }
  async function startSwitcher(delta) {
    switcher = { controls: null, wantDelta: delta, released: false };
    let current = switcher;
    let list;
    try {
      // The panes on screen know their sessions' titles; cloud sessions have no other source.
      list = await call("switcherSessions", mainWorld("titles", panes()[0]?.transcript ?? null) ?? {});
    } catch (caught) {
      log(`switcher: listing sessions failed: ${caught.message}`);
      switcher = null;
      return;
    }
    if (switcher !== current) {
      return;
    }
    if (settings.topTabs) {
      list = switcherOverOpenTabs(list);
    }
    if (list.length < 2) {
      switcher = null;
      flash(list.length ? "No other open tabs" : "No open tabs", innerWidth / 2 - 80, innerHeight / 3);
      return;
    }
    let start = (current.wantDelta + list.length) % list.length;
    let openItem = (item) => (item.sessionId ? openSessionNow(item.sessionId) : item.tab && openConversation(item.tab));
    if (current.released) {
      switcher = null;
      openItem(list[start]);
      return;
    }
    current.controls = listPopup({
      title: "Switch session",
      items: list.map((item) => ({ value: item, render: switcherRow(item) })),
      place: placeCentred(0.2),
      selected: start,
      width: 620,
      onPick: openItem,
    });
    current.controls.state.onClose = () => {
      if (switcher === current) {
        switcher = null;
      }
    };
  }
  /**
   * With tabs on, Ctrl+Tab goes through the open tabs only: the main process's list (most recently
   * used first, with states) narrowed to them, then the open tabs it doesn't know (chats, cloud
   * sessions not used lately), in tab order.
   */
  function switcherOverOpenTabs(list) {
    let { list: tabs, current, key } = tabsWanted();
    let openKeys = new Set(tabs.map(key));
    let byCode = new Map(list.map((item) => [`code:${item.sessionId}`, item]));
    let ordered = list.filter((item) => openKeys.has(`code:${item.sessionId}`));
    for (let tab of tabs) {
      if (!byCode.has(key(tab))) {
        ordered.push({ sessionId: tab.kind === "code" ? tab.id : null, tab, title: tab.title || "Untitled", folder: tab.kind === "code" ? "" : tab.kind, state: "", stateLabel: "", turnAge: "", contextTokens: 0 });
      }
    }
    let currentIndex = ordered.findIndex((item) => (item.tab ? key(item.tab) : `code:${item.sessionId}`) === current);
    if (currentIndex > 0) {
      ordered.unshift(...ordered.splice(currentIndex, 1));
    }
    return ordered;
  }
  /** Opens a session in this window: through the app's navigation, else through the page's router. */
  async function openSessionNow(sessionId) {
    let opened = await call("openSession", sessionId).catch((caught) => {
      log(`opening a session failed: ${caught.message}`);
      return false;
    });
    if (!opened) {
      history.pushState(history.state, "", `/epitaxy/${encodeURIComponent(sessionId)}`);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }
  }

  // --- Ctrl+Enter: send now ------------------------------------------------------------------
  let sendNowWatch = 0;
  function sendNowButton(pane) {
    return [...(pane?.root ?? document).querySelectorAll('button, [role="menuitem"]')].find(
      (node) => isShown(node) && (node.getAttribute("aria-label") === "Send now" || node.textContent.trim() === "Send now"),
    );
  }
  /** After Ctrl+Enter queues the message, presses the app's own "Send now" on it (also on one already queued). */
  function watchForSendNow(pane, editor) {
    let watch = ++sendNowWatch;
    let started = performance.now();
    let poll = () => {
      if (watch !== sendNowWatch) {
        return;
      }
      let button = sendNowButton(pane);
      if (button) {
        button.click();
        log(`Ctrl+Enter: pressed Send now after ${Math.round(performance.now() - started)} ms`);
        setTimeout(() => editor?.focus(), 50);
        return;
      }
      if (performance.now() - started < 2000) {
        setTimeout(poll, 100);
      }
    };
    setTimeout(poll, 60);
  }

  // --- Ctrl+Up in the prompt box: edit the unsent message ---------------------------------------
  /**
   * Takes the last message waiting to be sent back into the prompt box: the app's queued one (its own "Edit in
   * composer"), else this session's last Powertoys-queued prompt. False when nothing waits.
   */
  function editLastQueued() {
    let pane = activePane();
    let label = (node) => node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent.trim();
    let button = [...(pane?.root ?? document).querySelectorAll('button, [role="menuitem"]')].filter((node) => isShown(node) && label(node) === "Edit in composer").at(-1);
    if (button) {
      button.click();
      log("Ctrl+Up: pressed Edit in composer");
      return true;
    }
    let sessionId = paneSessionId(pane);
    let item = sessionId ? (promptQueue[sessionId] ?? []).at(-1) : null;
    if (item) {
      editQueued(sessionId, item);
      return true;
    }
    return false;
  }

  // --- Prompt jumps (Ctrl+Up/Down) and conversation ends (Ctrl+Home/End) ---------------------
  // The page has its own prompt jump (Alt+Up), but it is switched off by a flag; this one steps
  // through the user entries of the loaded window, loading earlier / later messages at its ends.
  // A press soon after the last jump steps from that prompt rather than from the top of the view.
  let lastJump = null; // { pane, entryId, at }
  let jumpBusy = false;
  /** The entry at the top of the pane's view (its index in the entry list), or -1. */
  function topEntryIndex(pane, entries) {
    let viewTop = pane.transcript.getBoundingClientRect().top;
    let rows = [...pane.transcript.querySelectorAll("[data-epitaxy-entry]")]
      .map((row) => ({ id: row.getAttribute("data-epitaxy-entry"), rect: row.getBoundingClientRect() }))
      .filter((row) => row.rect.height > 0 && row.rect.bottom > viewTop + 4)
      .sort((left, right) => left.rect.top - right.rect.top);
    for (let row of rows) {
      let index = entries.findIndex((entry) => entry.id === row.id);
      if (index >= 0) {
        // A row that starts above the view counts as being there only if most of the view is it.
        return row.rect.top < viewTop - 4 ? index + 0.5 : index;
      }
    }
    return -1;
  }
  async function jumpPrompt(direction) {
    let pane = activePane();
    if (!pane || jumpBusy) {
      return;
    }
    jumpBusy = true;
    try {
      for (let loads = 0; loads <= 5; loads++) {
        let entries = paneEntries(pane);
        let from = lastJump && lastJump.pane.transcript === pane.transcript && Date.now() - lastJump.at < 15000 ? entries.findIndex((entry) => entry.id === lastJump.entryId) : -1;
        if (from < 0) {
          from = topEntryIndex(pane, entries);
        }
        if (from < 0) {
          from = direction < 0 ? entries.length : -1;
        }
        let candidates = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.fromUser);
        let target = direction < 0 ? candidates.filter(({ index }) => index < from).at(-1) : candidates.find(({ index }) => index > from);
        if (target) {
          lastJump = { pane, entryId: target.entry.id, at: Date.now() };
          if (!mainWorld("scrollTo", pane.transcript, target.entry.id)) {
            scrollRowIntoView(pane, target.entry.id);
          }
          return;
        }
        // Past the oldest / newest loaded prompt: load more that way, keeping the position.
        lastJump = { pane, entryId: entries[direction < 0 ? 0 : entries.length - 1]?.id, at: Date.now() };
        if (!(await loadMore(pane, direction < 0 ? "earlier" : "later"))) {
          return;
        }
      }
    } finally {
      jumpBusy = false;
    }
  }
  let endsBusy = false;
  function jumpToLatestButton(pane) {
    let marker = pane.root.querySelector('[data-testid="jump-to-latest"]');
    return marker?.tagName === "BUTTON" ? marker : (marker?.querySelector("button") ?? null);
  }
  /** Ctrl+Home / Ctrl+End: the page keeps part of a long conversation loaded, so load the rest that way first. */
  async function goToEnd(toStart) {
    let pane = activePane();
    if (!pane || endsBusy) {
      return;
    }
    endsBusy = true;
    try {
      if (!toStart && loadButton(pane, "later")) {
        // The page's own "Scroll to bottom" reloads the newest part directly; it only acts away
        // from the bottom of what is loaded.
        pane.transcript.scrollTop = Math.max(0, pane.transcript.scrollTop - pane.transcript.clientHeight);
        await sleep(400);
        let latest = jumpToLatestButton(pane);
        if (latest) {
          latest.click();
          await sleep(800);
        }
      }
      for (let presses = 0; presses < 200 && (await loadMore(pane, toStart ? "earlier" : "later")); presses++) {}
      // The page re-anchors the scroll position as rows measure, so settle there over a few tries.
      for (let tries = 0; tries < 10; tries++) {
        let scroller = pane.transcript;
        let target = toStart ? 0 : scroller.scrollHeight - scroller.clientHeight;
        if (Math.abs(scroller.scrollTop - target) < 4) {
          break;
        }
        scroller.scrollTop = target;
        await sleep(250);
      }
    } finally {
      endsBusy = false;
    }
  }

  // --- Outline button ----------------------------------------------------------------------------
  const outlineButtons = new Map(); // transcript element -> button
  function layoutOutlineButtons() {
    let want = settings?.outlineButton ? panes() : [];
    for (let [transcript, button] of outlineButtons) {
      if (!want.some((pane) => pane.transcript === transcript)) {
        button.remove();
        outlineButtons.delete(transcript);
      }
    }
    for (let pane of want) {
      let button = outlineButtons.get(pane.transcript);
      if (!button) {
        button = element("div", "outline-button", "☰");
        button.title = "Conversation outline (right-click: copy, export, bookmarks)";
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          let current = panes().find((candidate) => candidate.transcript === pane.transcript) ?? pane;
          if (event.button === 2) {
            outlineMenu(current, event.clientX, event.clientY);
          } else if (event.button === 0) {
            showOutline(current, button);
          }
        });
        button.addEventListener("contextmenu", (event) => event.preventDefault());
        ui().appendChild(button);
        outlineButtons.set(pane.transcript, button);
      }
      let area = pane.transcript.getBoundingClientRect();
      let column = pane.transcript.querySelector("[data-transcript-column-row] > *")?.getBoundingClientRect();
      let left = column && column.width > 0 ? Math.min(column.right + 10, area.right - 44) : area.right - 44;
      button.style.left = `${Math.round(left)}px`;
      button.style.top = `${Math.round(area.top + 10)}px`;
    }
  }
  /** The prompts of the pane's session: the whole transcript for a local session, else what the page has loaded. */
  async function conversationOf(pane) {
    let sessionId = paneSessionId(pane);
    let local = sessionId ? await call("conversation", sessionId).catch(() => null) : null;
    if (local?.parts) {
      return {
        sessionId,
        title: local.title,
        local: true,
        parts: local.parts.map((part) => ({ fromUser: part.fromUser, text: part.text, keys: [part.uuid, part.messageId].filter(Boolean), endsTurn: part.endsTurn })),
      };
    }
    let entries = paneEntries(pane);
    return {
      sessionId,
      title: document.title.replace(/\s+[-–]\s+Claude(?: Code)?$/, ""),
      local: false,
      parts: entries.filter((entry) => entry.text.trim() !== "").map((entry) => ({ fromUser: entry.fromUser, text: entry.text, keys: [entry.id], endsTurn: entry.turnEnded })),
      partial: !!loadButton(pane, "earlier"),
    };
  }
  async function showOutline(pane, anchor) {
    let conversation = await conversationOf(pane);
    let prompts = conversation.parts.filter((part) => part.fromUser);
    let rect = anchor.getBoundingClientRect();
    listPopup({
      title: `Your prompts${conversation.partial ? " (loaded part)" : ""}`,
      items: prompts.map((part, index) => ({ value: part, label: oneLine(part.text).slice(0, 160), detail: String(index + 1) })),
      selected: Math.max(0, prompts.length - 1),
      emptyText: "No prompts yet",
      width: 560,
      place: (panel) => {
        let width = panel.getBoundingClientRect().width;
        panel.style.left = `${Math.max(8, rect.right - width)}px`;
        panel.style.top = `${rect.bottom + 6}px`;
      },
      onPick: async (part) => {
        if (!(await revealEntry(pane, part.keys))) {
          log(`outline: prompt not found in the conversation ('${oneLine(part.text).slice(0, 60)}')`);
          flash("Couldn't find that prompt", rect.left - 120, rect.bottom + 20);
        }
      },
    });
  }
  function bookmarkMenuItems() {
    let { folders, bookmarks } = bookmarkData;
    let item = (bookmark) => ({ label: `★  ${bookmark.name.slice(0, 70)}  ·  ${bookmark.sessionTitle.slice(0, 40)}`, onClick: () => openBookmark(bookmark) });
    let items = folders.map((folder) => {
      let inFolder = bookmarks.filter((bookmark) => bookmark.folder === folder);
      return { label: `📁  ${folder}`, submenu: inFolder.length ? inFolder.slice(0, 40).map(item) : [{ label: "(empty)", disabled: true }] };
    });
    items.push(...bookmarks.filter((bookmark) => bookmark.folder === "").slice(0, 25).map(item));
    if (bookmarks.length === 0) {
      items.push({ label: "No bookmarks: right-click a message and choose Bookmark message", disabled: true });
    }
    items.push("-", { label: "Manage bookmarks…", onClick: openBookmarkManager });
    return items;
  }
  async function outlineMenu(pane, x, y) {
    let items = [
      { label: "Copy Claude's last answer as Markdown", onClick: () => copyLastAnswer(pane) },
      { label: "Export as", submenu: exportMenuItems(paneSessionId(pane), pane) },
      { label: "Open edited files in IntelliJ", onClick: () => openEditedInIdea(paneSessionId(pane)) },
      { label: "Rebuild Claude, restart and continue here", onClick: () => restartAndContinue(paneSessionId(pane)) },
    ];
    if (settings?.bookmarks) {
      items.push("-", { label: "Bookmarks", submenu: bookmarkMenuItems() });
    }
    contextMenu(items, x - 240, y + 12);
  }
  async function copyLastAnswer(pane) {
    let sessionId = paneSessionId(pane);
    let entries = paneEntries(pane);
    let last = [...entries].reverse().find((entry) => !entry.fromUser && entry.turnEnded && entry.text.trim() !== "");
    let ok = await call("copyLastAnswer", sessionId, last?.text ?? "").catch(() => false);
    flash(ok ? "Copied Claude's last answer" : "No finished answer to copy");
  }
  function exportMenuItems(sessionId, pane) {
    return [
      ["Markdown", "markdown"],
      ["Web page (HTML)", "html"],
      ["PDF", "pdf"],
    ].map(([label, format]) => ({ label, onClick: () => exportConversation(pane, format, sessionId) }));
  }
  async function openEditedInIdea(sessionId) {
    let count = await call("openEditedInIdea", sessionId).catch((caught) => {
      flash(caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      return null;
    });
    if (count !== null) {
      flash(count ? `Opening ${count} file${count === 1 ? "" : "s"} in IntelliJ` : "This session hasn't edited any files");
    }
  }
  async function restartAndContinue(sessionId) {
    flash("Rebuilding Claude…");
    let result = await call("restartAndContinue", sessionId ?? null, "").catch((caught) => ({ ok: false, summary: caught.message }));
    if (result && !result.ok) {
      flash("Rebuild failed: the app keeps running (details sent to the conversation)");
    }
  }
  async function exportConversation(pane, format = "markdown", sessionId = null) {
    if (!pane) {
      let saved = await call("exportAs", sessionId, format, "", "").catch((caught) => {
        log(`export failed: ${caught.message}`);
        return undefined;
      });
      flash(saved ? `Exported to ${saved}` : saved === null ? "Open the conversation to export it (only sessions on this computer export from a tab)" : "Export failed");
      return;
    }
    let conversation = await conversationOf(pane);
    let markdown = `# ${conversation.title}\n`;
    let lastFromUser = null;
    for (let part of conversation.parts) {
      markdown += part.fromUser !== lastFromUser ? (part.fromUser ? "\n## You\n\n" : "\n## Claude\n\n") : "\n";
      markdown += `${part.text.trim()}\n`;
      lastFromUser = part.fromUser;
    }
    let saved = await call("exportAs", conversation.sessionId, format, markdown, conversation.title).catch((caught) => {
      log(`export failed: ${caught.message}`);
      return null;
    });
    if (saved) {
      flash(`Exported to ${saved}`);
    }
  }

  // --- Snippets (Ctrl+Shift+Space) and earlier prompts (Alt+Up) ------------------------------------
  // --- Large pastes as a file ---------------------------------------------------------------------
  // Text pasted into the prompt box longer than settings.pasteAsFileChars goes in as a file the prompt
  // mentions (@"<userData>/powertoys/pastes/pasted-….txt") instead of the message itself (a huge
  // message takes the whole conversation's height). If saving fails the text is pasted as usual, so
  // nothing is lost. Ctrl+Shift+V always pastes the text itself.
  let pastePlainUntil = 0;

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey && event.shiftKey && event.code === "KeyV") {
        pastePlainUntil = Date.now() + 1500;
      }
    },
    true,
  );
  document.addEventListener(
    "paste",
    (event) => {
      let limit = Number(settings?.pasteAsFileChars) || 0;
      if (limit <= 0 || Date.now() < pastePlainUntil || !inPromptBox()) {
        return;
      }
      let data = event.clipboardData;
      let text = data?.files?.length ? "" : (data?.getData("text/plain") ?? "");
      if (text.length < limit) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // The text is saved to a real file, then pasted again as that file: the composer shows it as one of its
      // attachments and sends @"<path>". It asks the preload for the file's path, and an in-memory File has
      // none, so powertoysPastedFilePath answers for it (see filePickers.getPathForFile).
      let target = deepActiveElement();
      call("savePaste", text).then(
        (file) => {
          let pasted = new File([text], file.split(/[\\/]/).pop(), { type: "text/plain" });
          powertoysPastedFiles.set(`${pasted.name}|${pasted.size}`, file);
          let transfer = new DataTransfer();
          transfer.items.add(pasted);
          target.focus();
          target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
          flash(`Pasted as a file (${Math.round(text.length / 1000)}k characters; Ctrl+Shift+V pastes the text itself)`);
        },
        (caught) => {
          log(`paste: saving failed (${caught.message}); pasted ${text.length} characters as text`);
          target.focus();
          document.execCommand("insertText", false, text);
        },
      );
    },
    true,
  );
  // --- Task lists: progress, time left, when done and the total ----------------------------------------
  // The page draws its plan and TodoWrite / Task lists without times; the transcript has them (todoProgress). The list
  // on screen is found by its items' text, and a bar with the estimate goes under it. The time left is Claude's own:
  // the plan tool takes an estimate per step (agentEstimates), and a step without one counts as the average of
  // those with one. The time left counts down to the finish time; it is worked out again when a step's status or
  // estimate changes, and the bar's button asks Claude for new estimates.
  const taskLists = new Map(); // sessionId -> { at, data }
  const taskEstimates = new Map(); // sessionId -> the estimate shown (see estimateTasks)
  const REESTIMATE_PROMPT =
    'Re-estimate your task list: send the whole plan again with update_plan (scope "continuation"), the steps as they are, with an estimate in minutes for every step not done yet, from what you know now about the work left. Only update the plan: this message is not a request for other work.';
  function fetchTaskList(sessionId) {
    return call("todoProgress", sessionId).then(
      (data) => taskLists.set(sessionId, { at: Date.now(), data }),
      (caught) => log(`task progress for ${sessionId} failed: ${caught.message}`),
    );
  }
  function refreshTaskLists() {
    for (let pane of panes()) {
      let sessionId = paneSessionId(pane);
      let known = sessionId && taskLists.get(sessionId);
      if (!sessionId || (known && Date.now() - known.at < 4000)) {
        continue;
      }
      taskLists.set(sessionId, { at: Date.now(), data: known?.data ?? null });
      fetchTaskList(sessionId);
    }
  }
  function minutes(ms) {
    let total = Math.round(ms / 60000);
    return total < 1 ? "<1 min" : total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${total % 60} min`;
  }
  const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const estimateSignature = (data) => data.items.map((item) => `${item.status}:${item.estimate ?? ""}`).join("|");
  function estimateTasks(data, now) {
    let items = data.items;
    let current = items.find((item) => item.status === "in_progress");
    let began = data.startedAt || Math.min(...items.map((item) => item.createdAt || now));
    let estimate = {
      at: now,
      signature: estimateSignature(data),
      working: data.state === "working",
      began,
      left: 0,
      estimated: false,
      missing: 0,
      planned: 0,
      after: 0, // the steps after the current one
    };
    let open = items.filter((item) => item.status !== "completed");
    let known = items.filter((item) => item.estimate > 0);
    estimate.planned = known.reduce((sum, item) => sum + item.estimate * 60000, 0);
    estimate.average = known.length ? estimate.planned / known.length : 0;
    if (open.length === 0 || !open.some((item) => item.estimate > 0)) {
      return estimate;
    }
    let average = estimate.average;
    estimate.estimated = true;
    for (let item of open) {
      let planned = item.estimate > 0 ? item.estimate * 60000 : average;
      if (!(item.estimate > 0)) {
        estimate.missing++;
      }
      if (item === current) {
        let spent = now - (item.startedAt || now);
        estimate.left += Math.max(planned - spent, 0);
      } else {
        estimate.left += planned;
        estimate.after += planned;
      }
    }
    return estimate;
  }
  /** The estimate to show: the last one, or a new one when a step's status or estimate changed. */
  function currentEstimate(sessionId, data, now) {
    let last = taskEstimates.get(sessionId);
    if (!last || last.signature !== estimateSignature(data) || last.working !== (data.state === "working")) {
      last = estimateTasks(data, now);
      taskEstimates.set(sessionId, last);
    }
    return last;
  }
  function taskSummary(data, estimate, now) {
    let items = data.items;
    let done = items.filter((item) => item.status === "completed");
    let current = items.find((item) => item.status === "in_progress");
    let summary = { total: items.length, done: done.length, fraction: done.length / items.length, text: "" };
    if (done.length === items.length) {
      summary.fraction = 1;
      let finished = Math.max(...done.map((item) => item.doneAt || estimate.began));
      summary.text = `All ${items.length} done in ${minutes(finished - estimate.began)}${estimate.planned ? ` (Claude estimated ${minutes(estimate.planned)})` : ""}`;
      return summary;
    }
    if (!estimate.estimated) {
      summary.text = `${done.length} of ${items.length} done · no estimate from Claude yet`;
      return summary;
    }
    // A step running past its estimate pushes the finish back: the steps after it still take their time.
    let finish = estimate.working ? Math.max(estimate.at + estimate.left, now + estimate.after) : estimate.at + estimate.left;
    // The bar is time: what the steps took so far (a done step's real time, else its estimate) against that plus
    // the time left; short of full until the last step is done.
    let spent = done.reduce((sum, item) => sum + (item.startedAt && item.doneAt ? item.doneAt - item.startedAt : item.estimate > 0 ? item.estimate * 60000 : estimate.average), 0);
    if (current?.startedAt) {
      spent += Math.max((estimate.working ? now : estimate.at) - current.startedAt, 0);
    }
    let left = estimate.working ? Math.max(finish - now, 0) : estimate.left;
    summary.fraction = spent + left > 0 ? Math.min(spent / (spent + left), 0.97) : summary.fraction;
    let parts = [`${done.length} of ${items.length} done`];
    if (!estimate.working) {
      parts.push(`~${minutes(estimate.left)} left`, "paused");
    } else if (finish > now) {
      parts.push(`~${minutes(finish - now)} left`, `done ≈ ${clock(finish)}`);
    } else {
      parts.push("finishing the last step, past its estimate");
    }
    let over = current?.estimate > 0 ? now - (current.startedAt || now) - current.estimate * 60000 : 0;
    if (over > 60000) {
      parts.push(`this step ${minutes(over)} over its estimate`);
    }
    if (estimate.missing) {
      parts.push(`${estimate.missing} step${estimate.missing === 1 ? "" : "s"} not estimated`);
    }
    parts.push(`~${minutes(Math.max(finish, now) - estimate.began)} in all`);
    summary.text = parts.join(" · ");
    return summary;
  }
  /** The element holding one row per item (a row shows the item's text or its active form), or null. */
  function taskListElement(root, labels) {
    let rows = new Map();
    let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let text = node.data.trim();
      let index = text ? labels.findIndex((pair) => pair.includes(text)) : -1;
      if (index >= 0 && !rows.has(index) && !node.parentElement.closest("[data-pt-task-progress]")) {
        rows.set(index, node.parentElement);
      }
    }
    if (rows.size !== labels.length) {
      return null;
    }
    let [first, ...rest] = rows.values();
    let list = first;
    while (list && !rest.every((row) => list.contains(row))) {
      list = list.parentElement;
    }
    return list ? { list, rows } : null;
  }
  /** A step's time: a done step's real time, the current one's time so far, else the estimate. */
  function stepTime(item, estimate, now) {
    let planned = item.estimate > 0 ? minutes(item.estimate * 60000) : "";
    if (item.status === "completed" && item.startedAt && item.doneAt) {
      return `${minutes(item.doneAt - item.startedAt)}${planned ? ` (est. ${planned})` : ""}`;
    }
    if (item.status === "in_progress" && item.startedAt) {
      return `${minutes((estimate.working ? now : estimate.at) - item.startedAt)}${planned ? ` of ~${planned}` : ""}`;
    }
    return planned ? `~${planned}` : "";
  }
  let stepTimes = [];
  function taskBar(sessionId) {
    let bar = document.createElement("div");
    bar.setAttribute("data-pt-task-progress", "");
    bar.style.cssText = "margin: 6px 0 4px; font-size: 12px; color: hsl(var(--text-300, 50 9% 73%));";
    let track = document.createElement("div");
    track.style.cssText = "height: 4px; border-radius: 2px; background: hsl(var(--text-500, 40 3% 50%) / 0.25); overflow: hidden; margin-bottom: 4px;";
    let fill = document.createElement("div");
    fill.style.cssText = "height: 100%; border-radius: 2px; background: hsl(var(--brand-100, 15 63% 60%)); transition: width .4s;";
    track.appendChild(fill);
    let line = document.createElement("div");
    line.style.cssText = "display: flex; align-items: center; gap: 6px;";
    let text = document.createElement("span");
    let update = document.createElement("button");
    update.textContent = "↻ re-estimate";
    update.title = "Ask Claude to estimate the steps left again (sent now when the session is idle, else when its turn ends)";
    update.style.cssText = "border: none; background: none; color: inherit; cursor: pointer; padding: 0 4px; font-size: 12px; border-radius: 4px; opacity: 0.8;";
    update.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      let sessionId = bar.dataset.session;
      update.disabled = true;
      call("queue", sessionId, "add", REESTIMATE_PROMPT).then(
        (queue) => {
          update.disabled = false;
          flash((queue[sessionId]?.length ?? 0) ? "Asked: Claude re-estimates when its turn ends" : "Asked: Claude is re-estimating now");
          log(`task estimate: asked ${sessionId} to re-estimate`);
        },
        (caught) => {
          update.disabled = false;
          flash(caught.message);
        },
      );
    });
    line.append(text, update);
    bar.append(track, line);
    bar.dataset.session = sessionId;
    return bar;
  }
  let taskBars = [];
  function decorateTaskLists() {
    let keep = new Set();
    if (settings?.taskProgress !== false) {
      refreshTaskLists();
      let now = Date.now();
      for (let pane of panes()) {
        let sessionId = paneSessionId(pane);
        let data = taskLists.get(sessionId)?.data;
        if (!data || data.items.length < 2) {
          continue;
        }
        let labels = data.items.map((item) => [item.content, item.activeForm].filter(Boolean));
        // The list is in the conversation or in the session's side panel.
        let found = taskListElement(pane.root, labels) ?? taskListElement(document.body, labels);
        if (!found) {
          continue;
        }
        let list = found.list;
        let bar = list.nextElementSibling?.hasAttribute("data-pt-task-progress") ? list.nextElementSibling : null;
        if (!bar) {
          bar = taskBar(sessionId);
          list.after(bar);
        }
        bar.dataset.session = sessionId;
        let estimate = currentEstimate(sessionId, data, now);
        let summary = taskSummary(data, estimate, now);
        bar.firstChild.firstChild.style.width = `${100 * summary.fraction}%`;
        // Each step's time beside it.
        for (let [index, row] of found.rows) {
          let time = stepTime(data.items[index], estimate, now);
          let span = row.querySelector(":scope > [data-pt-step-time]");
          if (!time) {
            continue;
          }
          if (!span) {
            span = document.createElement("span");
            span.setAttribute("data-pt-step-time", "");
            span.style.cssText = "margin-left: 8px; font-size: 11px; opacity: 0.65; white-space: nowrap; font-variant-numeric: tabular-nums;";
            row.appendChild(span);
          }
          if (span.textContent !== time) {
            span.textContent = time;
          }
          keep.add(span);
        }
        let text = bar.lastChild.firstChild;
        if (text.textContent !== summary.text) {
          text.textContent = summary.text;
        }
        // Asking for new estimates needs the plan tool (a TodoWrite list has no estimates).
        bar.lastChild.lastChild.hidden = summary.done === summary.total || data.source !== "plan";
        keep.add(bar);
      }
    }
    for (let node of [...taskBars, ...stepTimes]) {
      if (!keep.has(node)) {
        node.remove();
      }
    }
    taskBars = [...keep].filter((node) => node.hasAttribute("data-pt-task-progress"));
    stepTimes = [...keep].filter((node) => node.hasAttribute("data-pt-step-time"));
  }
  // --- Tab extras: a PR's checks, why a session waits, its task list, its queued prompts ------------------
  let tabExtras = {}; // sessionId -> { prs, reason, queued, todos } (tabExtras, every 5 s for the open tabs)
  let tabExtrasKey = "";
  let promptQueue = {}; // sessionId -> [{ id, text, at }] (queue.json, broadcast by the main process)
  async function refreshTabExtras() {
    let ids = new Set(tabsWanted().list.filter((row) => row.kind === "code").map((row) => row.id));
    for (let pane of panes()) {
      let id = paneSessionId(pane);
      id && ids.add(id);
    }
    if (ids.size === 0) {
      return;
    }
    let next = await call("tabExtras", [...ids]).catch((caught) => {
      log(`tab extras failed: ${caught.message}`);
      return null;
    });
    if (!next) {
      return;
    }
    tabExtras = next;
    if (Date.now() - tabLimitsAt > 60000) {
      tabLimitsAt = Date.now();
      call("sessionLimits", [...ids]).then(
        (limits) => {
          let changed = JSON.stringify(Object.entries(limits).map(([id, limit]) => [id, limit.over])) !== JSON.stringify(Object.entries(tabLimits).map(([id, limit]) => [id, limit.over]));
          tabLimits = limits;
          if (changed) {
            tabsKey = "";
          }
        },
        (caught) => log(`session limits failed: ${caught.message}`),
      );
    }
    for (let [sessionId, extra] of Object.entries(next)) {
      if (extra.todos) {
        taskLists.set(sessionId, { at: Date.now(), data: extra.todos });
      }
    }
    let key = JSON.stringify(Object.entries(next).map(([id, extra]) => [id, ciOf(extra)?.checks, extra.queued, extra.reason]));
    if (key !== tabExtrasKey) {
      tabExtrasKey = key;
      tabsKey = "";
    }
  }
  /** The PR whose checks matter most: a failed one, else a pending one, else any. */
  function ciOf(extra) {
    let prs = extra?.prs ?? [];
    return prs.find((pr) => pr.checks === "failed") ?? prs.find((pr) => pr.checks === "pending") ?? prs.find((pr) => pr.checks) ?? null;
  }
  const CI_GLYPHS = { passed: "✓", failed: "✗", pending: "●" };
  const CI_NAMES = { passed: "checks passed", failed: "checks failed", pending: "checks running" };
  function ciText(pr) {
    return pr ? `PR #${pr.number}: ${CI_NAMES[pr.checks] ?? "no checks yet"}` : "";
  }
  /** "☑ 3/7 · done ≈ 21:10" for a session's task list, from the same estimate as the bar under it. */
  function taskShort(sessionId) {
    let data = taskLists.get(sessionId)?.data;
    if (!data || data.items.length < 2) {
      return "";
    }
    let now = Date.now();
    let estimate = currentEstimate(sessionId, data, now);
    let summary = taskSummary(data, estimate, now);
    let text = `☑ ${summary.done}/${summary.total}`;
    if (summary.done === summary.total || !estimate.left) {
      return text;
    }
    let finish = estimate.at + estimate.left;
    return estimate.working ? `${text} · done ≈ ${clock(finish)}` : `${text} · paused`;
  }
  function queueFromPromptBox() {
    let pane = activePane();
    let editor = paneEditor(pane);
    let sessionId = paneSessionId(pane);
    let text = editor?.innerText.trim() ?? "";
    if (!sessionId || !text) {
      flash(sessionId ? "Nothing to queue" : "No session here to queue for");
      return;
    }
    call("queue", sessionId, "add", text).then(
      (queue) => {
        editor.focus();
        document.execCommand("selectAll");
        document.execCommand("delete");
        let count = queue[sessionId]?.length ?? 0;
        flash(count ? `Queued: ${count} prompt${count === 1 ? "" : "s"} wait for this turn to end` : "Sent: the session was not working");
      },
      (caught) => flash(caught.message),
    );
  }
  /** The session's queued prompts: Enter takes one back into the prompt box, × removes it. */
  function showPromptQueue(sessionId, title) {
    let list = promptQueue[sessionId] ?? [];
    listPopup({
      title: `Queued prompts for “${title || "this session"}”: Enter takes one back to edit, × removes it`,
      items: list.map((item, index) => ({
        value: item,
        render: () => {
          let wrap = element("span", "two");
          wrap.appendChild(element("span", "", `${index + 1}. ${item.text.replace(/\s+/g, " ").slice(0, 160)}`));
          let remove = element("span", "dim", "  ×  remove");
          remove.style.cursor = "pointer";
          remove.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            call("queue", sessionId, "remove", item.id).then(
              (queue) => {
                promptQueue = queue;
                closePopup();
                showPromptQueue(sessionId, title);
              },
              (caught) => flash(caught.message),
            );
          });
          wrap.appendChild(remove);
          return wrap;
        },
      })),
      emptyText: settings?.promptQueueKey ? "Nothing queued. Alt+Enter in the prompt box queues a prompt." : "Nothing queued.",
      place: placeCentred(0.2),
      width: 680,
      onPick: (item) => editQueued(sessionId, item),
    });
  }
  /** Takes a queued prompt out of the queue and puts it in the session's prompt box. */
  async function editQueued(sessionId, item) {
    let pane = panes().find((each) => paneSessionId(each) === sessionId);
    if (!pane) {
      openSessionNow(sessionId);
      for (let tries = 0; tries < 30 && !pane; tries++) {
        await sleep(100);
        pane = panes().find((each) => paneSessionId(each) === sessionId);
      }
    }
    let editor = paneEditor(pane);
    if (!editor) {
      flash("That session's prompt box was not found");
      return;
    }
    try {
      await call("queue", sessionId, "remove", item.id);
    } catch (caught) {
      flash(caught.message);
      return;
    }
    editor.focus();
    document.execCommand("insertText", false, item.text);
  }
  // --- Context map: what fills a session's context, and how it got there --------------------------------
  // From the transcript (contextMap in the main process): the size at every request is exact; what each kind of
  // content takes is estimated from its text and scaled to that size. Every row and the chart jump to the message.
  const CONTEXT_KINDS = {
    system: ["System prompt", "#8f8a80"],
    tools: ["Tool definitions", "#6f8fb0"],
    instructions: ["Instructions (CLAUDE.md, memory)", "#d8bf8a"],
    summary: ["Compaction summary", "#f06aa8"],
    prompts: ["Your messages", "#3fa85a"],
    replies: ["Claude's text", "#4fc3f7"],
    thinking: ["Thinking", "#8a6cf0"],
    toolCalls: ["Tool calls", "#f0883e"],
    toolResults: ["Tool results", "#e5534b"],
    files: ["Attached files", "#e8c547"],
    reminders: ["Reminders and tool lists", "#a8693c"],
    images: ["Images", "#2bb5a5"],
  };
  const CONTEXT_ORDER = Object.keys(CONTEXT_KINDS);
  const kTokens = (count) => (count >= 1e6 ? `${(count / 1e6).toFixed(2)}M` : count >= 10000 ? `${Math.round(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));
  function whenText(at) {
    let date = new Date(at);
    return date.toDateString() === new Date().toDateString() ? clock(at) : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function svgNode(tag, attributes = {}) {
    let node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (let [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, String(value));
    }
    return node;
  }
  let contextWindowOpen = null;
  let contextNowMode = "kinds"; // "Biggest things in it now": "kinds" (added up) or "items"
  async function openContextMap(sessionId, title) {
    closePopup();
    if (!sessionId) {
      flash("No session here");
      return;
    }
    contextWindowOpen?.shut();
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel history ctxmap");
    let head = element("div", "head");
    let heading = element("span", "", `Context map · ${title || "this session"}`);
    heading.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    let refresh = element("button", "iconbtn", "↻");
    refresh.title = "Read the transcript again";
    let close = element("button", "iconbtn", "✕");
    head.append(heading, refresh, close);
    let body = element("div", "body");
    panel.append(head, body);
    ui().append(backdrop, panel);
    let shut = () => {
      backdrop.remove();
      panel.remove();
      keyWindows.delete(windowState);
      contextWindowOpen = null;
    };
    let windowState = {
      shut,
      onKey(event) {
        if (event.type === "keydown" && event.code === "Escape" && !popup) {
          shut();
          return true;
        }
        return false;
      },
    };
    keyWindows.add(windowState);
    contextWindowOpen = windowState;
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    let jump = (keys, text) => {
      shut();
      if (!panes().some((pane) => paneSessionId(pane) === sessionId)) {
        openSessionNow(sessionId);
      }
      revealWhenOnScreen(sessionId, keys ?? [], text ?? "");
    };
    let load = async () => {
      body.textContent = "";
      body.appendChild(element("div", "empty", "Reading the transcript…"));
      let map = await call("contextMap", sessionId).catch((caught) => ({ error: caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
      if (contextWindowOpen !== windowState) {
        return;
      }
      body.textContent = "";
      if (map.error || !map.points?.length) {
        body.appendChild(element("div", "empty", map.error || "No responses yet, so nothing to show"));
        return;
      }
      renderContextMap(body, map, jump);
    };
    refresh.addEventListener("click", load);
    await load();
  }
  function renderContextMap(body, map, jump) {
    let now = map.now;
    let windowSize = map.contextWindow;
    let percent = Math.round((100 * now.context) / windowSize);
    let summary = element("div", "summary");
    summary.append(
      element("strong", "", `${kTokens(now.context)} of ${kTokens(windowSize)}`),
      ` (${percent}%) at ${whenText(now.at)} · ${map.requests} requests · ${map.turns.length} messages from you · ${
        map.compactions.length ? `compacted ${map.compactions.length}×` : "never compacted"
      }`,
    );
    body.appendChild(summary);

    // Now: what fills it, as one bar.
    let nowSection = element("div", "section");
    nowSection.appendChild(element("h3", "", "What fills it now"));
    let bar = element("div", "bar");
    for (let kind of CONTEXT_ORDER) {
      let tokens = now.categories[kind] ?? 0;
      if (tokens <= 0) {
        continue;
      }
      let piece = element("span");
      piece.style.cssText = `width: ${(100 * tokens) / windowSize}%; background: ${CONTEXT_KINDS[kind][1]};`;
      piece.title = `${CONTEXT_KINDS[kind][0]}: ${kTokens(tokens)} (${Math.round((100 * tokens) / now.context)}% of the context)`;
      bar.appendChild(piece);
    }
    let free = element("span", "free");
    free.style.flex = "1";
    free.title = `Free: ${kTokens(Math.max(0, windowSize - now.context))}`;
    bar.appendChild(free);
    nowSection.appendChild(bar);
    let legend = element("div", "legend");
    for (let kind of [...CONTEXT_ORDER].sort((left, right) => (now.categories[right] ?? 0) - (now.categories[left] ?? 0))) {
      let tokens = now.categories[kind] ?? 0;
      if (tokens <= 0) {
        continue;
      }
      let entry = element("span");
      let swatch = element("span", "swatch");
      swatch.style.background = CONTEXT_KINDS[kind][1];
      entry.append(swatch, `${CONTEXT_KINDS[kind][0]} `, element("b", "", kTokens(tokens)));
      legend.appendChild(entry);
    }
    nowSection.appendChild(legend);
    if (now.toolGroups?.length) {
      nowSection.appendChild(
        element("div", "note", `Tool definitions: ${now.toolGroups.map((group) => `${group.group} ${kTokens(group.tokens)} (${group.count})`).join(" · ")}`),
      );
    }
    nowSection.appendChild(
      element("div", "note", "The total and the curve are exact (from each response's usage). Each kind's share is estimated from the transcript's text and scaled to the total."),
    );
    body.appendChild(nowSection);

    // How it grew: stacked areas over the requests, compactions, your messages.
    let chartSection = element("div", "section");
    chartSection.appendChild(element("h3", "", "How it grew (every request; ticks are your messages, dashed lines compactions)"));
    let chart = element("div", "chart");
    chartSection.appendChild(chart);
    body.appendChild(chartSection);
    drawContextChart(chart, map, jump);

    // Lists: what is in it now, the biggest jumps, what each message added.
    let columns = element("div", "cols");
    let fillRows = (container, rows) => {
      container.textContent = "";
      for (let row of rows) {
        let line = element("div", "r");
        let dot = element("span", "swatch");
        dot.style.background = CONTEXT_KINDS[row.kind]?.[1] ?? "transparent";
        let label = element("span", "label", row.label);
        label.prepend(dot);
        label.title = row.label;
        line.append(element("span", "size", row.size), label, element("span", "when", row.when));
        if (row.onClick) {
          line.addEventListener("click", row.onClick);
          line.title = row.hint ?? "";
        } else if (row.keys?.length || row.text) {
          line.addEventListener("click", () => jump(row.keys, row.text));
          line.title = "Go to this message";
        }
        container.appendChild(line);
      }
      if (rows.length === 0) {
        container.appendChild(element("div", "note", "Nothing"));
      }
    };
    let list = (titleText, rows) => {
      let section = element("div", "section");
      section.appendChild(element("h3", "", titleText));
      let container = element("div", "rows");
      fillRows(container, rows);
      section.appendChild(container);
      return section;
    };
    // What is in it now: added up by kind (click one to see its biggest items), or one by one.
    let itemRow = (item) => ({ size: kTokens(item.tokens), label: item.label, kind: item.category, when: whenText(item.at), keys: item.keys, text: item.text });
    let nowList = element("div", "section");
    let nowHead = element("div", "h3row");
    let nowTitle = element("h3");
    let modes = element("div", "seg");
    let byKind = element("button", "", "By kind");
    let single = element("button", "", "Individual");
    modes.append(byKind, single);
    nowHead.append(nowTitle, modes);
    let nowRows = element("div", "rows");
    nowList.append(nowHead, nowRows);
    let drill = null;
    let drawNow = () => {
      let grouped = contextNowMode === "kinds";
      byKind.classList.toggle("on", grouped);
      single.classList.toggle("on", !grouped);
      let group = grouped && drill ? now.groups?.find((each) => each.group === drill) : null;
      if (group) {
        nowTitle.textContent = `${group.group}: ${kTokens(group.tokens)} in ${group.count} item${group.count === 1 ? "" : "s"}`;
        fillRows(nowRows, [
          { size: "", label: "← All kinds", when: "", onClick: () => ((drill = null), drawNow()), hint: "Back to the kinds" },
          ...group.items.map(itemRow),
        ]);
        if (group.count > group.items.length) {
          nowRows.appendChild(element("div", "note", `The biggest ${group.items.length} of ${group.count}`));
        }
      } else if (grouped) {
        nowTitle.textContent = "Biggest things in it now, by kind";
        fillRows(
          nowRows,
          (now.groups ?? []).map((each) => ({
            size: kTokens(each.tokens),
            label: `${each.group}${each.count > 1 ? ` ×${each.count}` : ""}`,
            kind: each.category,
            when: `${Math.round((100 * each.tokens) / now.context)}%`,
            onClick: () => ((drill = each.group), drawNow()),
            hint: "Show its biggest items",
          })),
        );
      } else {
        nowTitle.textContent = "Biggest things in it now";
        fillRows(nowRows, now.items.map(itemRow));
      }
    };
    byKind.addEventListener("click", () => ((contextNowMode = "kinds"), drawNow()));
    single.addEventListener("click", () => ((contextNowMode = "items"), (drill = null), drawNow()));
    drawNow();
    columns.appendChild(nowList);
    columns.appendChild(
      list(
        "Biggest jumps (from one request to the next)",
        map.jumps.map((jumpRow) => ({
          size: `+${kTokens(jumpRow.delta)}`,
          label: jumpRow.cause?.label ?? "Several smaller things",
          kind: jumpRow.cause?.category,
          when: whenText(jumpRow.at),
          keys: jumpRow.keys,
        })),
      ),
    );
    columns.appendChild(
      list(
        "What each of your messages added (latest first)",
        [...map.turns]
          .reverse()
          .slice(0, 60)
          .map((turn) => ({
            size: `${turn.end >= turn.start ? "+" : "−"}${kTokens(Math.abs(turn.end - turn.start))}`,
            label: `${turn.text} (${kTokens(turn.start)} → ${kTokens(turn.end)}, ${turn.requests} request${turn.requests === 1 ? "" : "s"})`,
            kind: "prompts",
            when: whenText(turn.at),
            keys: turn.keys,
            text: turn.text,
          })),
      ),
    );
    body.appendChild(columns);
  }
  function drawContextChart(container, map, jump) {
    let width = Math.max(480, container.clientWidth || 900);
    let height = 240;
    let pad = { left: 46, right: 12, top: 12, bottom: 22 };
    let points = map.points;
    let lastIndex = Math.max(1, map.requests - 1);
    let peak = Math.max(...points.map((point) => point.context));
    let top = Math.max(map.contextWindow, peak);
    let x = (index) => pad.left + (index / lastIndex) * (width - pad.left - pad.right);
    let y = (value) => height - pad.bottom - (value / top) * (height - pad.top - pad.bottom);
    let svg = svgNode("svg", { width, height, viewBox: `0 0 ${width} ${height}` });
    // Grid: quarters of the window.
    for (let quarter = 0; quarter <= 4; quarter++) {
      let value = (top * quarter) / 4;
      svg.appendChild(svgNode("line", { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), stroke: "currentColor", "stroke-opacity": 0.12 }));
      let label = svgNode("text", { x: pad.left - 6, y: y(value) + 4, "text-anchor": "end", "font-size": 10, fill: "currentColor", "fill-opacity": 0.6 });
      label.textContent = kTokens(Math.round(value));
      svg.appendChild(label);
    }
    // The stacked areas, bottom to top in CONTEXT_ORDER.
    let lower = points.map(() => 0);
    for (let kind of CONTEXT_ORDER) {
      let upper = points.map((point, index) => lower[index] + (point.categories[kind] ?? 0));
      if (upper.every((value, index) => value === lower[index])) {
        continue;
      }
      let forward = points.map((point, index) => `${x(point.index).toFixed(1)},${y(upper[index]).toFixed(1)}`);
      let back = points.map((point, index) => `${x(point.index).toFixed(1)},${y(lower[index]).toFixed(1)}`).reverse();
      svg.appendChild(svgNode("polygon", { points: [...forward, ...back].join(" "), fill: CONTEXT_KINDS[kind][1], "fill-opacity": 0.85 }));
      lower = upper;
    }
    // The exact total on top.
    svg.appendChild(
      svgNode("polyline", { points: points.map((point) => `${x(point.index).toFixed(1)},${y(point.context).toFixed(1)}`).join(" "), fill: "none", stroke: "currentColor", "stroke-width": 1.2 }),
    );
    if (map.contextWindow <= top) {
      svg.appendChild(svgNode("line", { x1: pad.left, x2: width - pad.right, y1: y(map.contextWindow), y2: y(map.contextWindow), stroke: "#f85149", "stroke-dasharray": "4 3" }));
    }
    for (let compaction of map.compactions) {
      let at = x(Math.min(compaction.point, lastIndex));
      svg.appendChild(svgNode("line", { x1: at, x2: at, y1: pad.top, y2: height - pad.bottom, stroke: "currentColor", "stroke-opacity": 0.6, "stroke-dasharray": "3 3" }));
      let label = svgNode("text", { x: at + 4, y: pad.top + 10, "font-size": 10, fill: "currentColor", "fill-opacity": 0.8 });
      label.textContent = `compacted ${kTokens(compaction.pre)} → ${kTokens(compaction.post)}`;
      svg.appendChild(label);
    }
    for (let turn of map.turns) {
      let at = x(Math.min(turn.point, lastIndex));
      svg.appendChild(svgNode("line", { x1: at, x2: at, y1: height - pad.bottom, y2: height - pad.bottom + 5, stroke: "#3fa85a" }));
    }
    let cursor = svgNode("line", { y1: pad.top, y2: height - pad.bottom, stroke: "currentColor", "stroke-opacity": 0.7, visibility: "hidden" });
    svg.appendChild(cursor);
    container.appendChild(svg);
    let tip = element("div", "tip");
    tip.hidden = true;
    container.appendChild(tip);
    let nearest = (event) => {
      let rect = svg.getBoundingClientRect();
      let index = ((event.clientX - rect.left - pad.left) / (width - pad.left - pad.right)) * lastIndex;
      return points.reduce((best, point) => (Math.abs(point.index - index) < Math.abs(best.index - index) ? point : best), points[0]);
    };
    svg.addEventListener("mousemove", (event) => {
      let point = nearest(event);
      let turn = map.turns[point.turn];
      cursor.setAttribute("x1", x(point.index));
      cursor.setAttribute("x2", x(point.index));
      cursor.setAttribute("visibility", "visible");
      let kinds = CONTEXT_ORDER.filter((kind) => point.categories[kind] > 0)
        .sort((left, right) => point.categories[right] - point.categories[left])
        .slice(0, 4)
        .map((kind) => `${CONTEXT_KINDS[kind][0]} ${kTokens(point.categories[kind])}`);
      tip.textContent = "";
      tip.append(
        element("b", "", `${kTokens(point.context)} (${Math.round((100 * point.context) / map.contextWindow)}%) · ${whenText(point.at)}`),
        element("div", "", turn ? `After: ${turn.text}` : "Before your first message"),
        element("div", "dim", kinds.join(" · ")),
      );
      tip.hidden = false;
      let rect = container.getBoundingClientRect();
      let left = event.clientX - rect.left + 14;
      tip.style.left = `${Math.min(left, rect.width - 380)}px`;
      tip.style.top = `${event.clientY - rect.top + 12}px`;
    });
    svg.addEventListener("mouseleave", () => {
      cursor.setAttribute("visibility", "hidden");
      tip.hidden = true;
    });
    svg.addEventListener("click", (event) => {
      let turn = map.turns[nearest(event).turn];
      if (turn) {
        jump(turn.keys, turn.text);
      }
    });
    svg.style.cursor = "pointer";
  }
  /** The app's task list for a session that started without it (forceTaskList covers new sessions). */
  function addTaskList(sessionId) {
    call("addTaskList", sessionId).then(
      (outcome) => {
        flash(outcome === "already" ? "This session already has the task list" : "The task list comes with the next message (Claude reads the conversation again once)");
        refreshTabExtras();
      },
      (caught) => flash(caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")),
    );
  }
  // --- Conversation topic: its Notion ticket, implementation and testing progress, its PR --------------------
  // The ticket comes from the Notion pages the conversation fetched (and the status changes it made); progress from
  // its task list (steps about testing count as testing) and its last end-of-turn recap; the PR from the app's
  // tracker (tabExtras). A chip in the status row sums it up; it opens the whole topic.
  const TEST_STEP = /\b(test|tests|tested|testing|verify|verified|verification|QA|repro|reproduce|e2e|smoke)\b/i;
  const PR_REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };
  function topicParts(sessionId) {
    let extra = tabExtras[sessionId];
    let ticket = extra?.topic?.ticket;
    let parts = [];
    if (ticket) {
      parts.push(ticket.status ? `🎫 ${ticket.id} · ${ticket.status}` : `🎫 ${ticket.id}`);
    }
    let items = taskLists.get(sessionId)?.data?.items ?? [];
    if (items.length >= 2) {
      let done = items.filter((item) => item.status === "completed").length;
      parts.push(`☑ ${done}/${items.length}`);
      let tests = items.filter((item) => TEST_STEP.test(item.content));
      if (tests.length) {
        parts.push(`🧪 ${tests.filter((item) => item.status === "completed").length}/${tests.length}`);
      }
    }
    for (let pr of extra?.prs ?? []) {
      parts.push(`PR #${pr.number}${pr.draft ? " (draft)" : ""}${pr.checks ? ` ${CI_GLYPHS[pr.checks] ?? ""}` : ""}`);
    }
    return parts;
  }
  let topicWindowOpen = null;
  async function openTopic(sessionId, title) {
    closePopup();
    if (!sessionId) {
      flash("No session here");
      return;
    }
    topicWindowOpen?.shut();
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel history ctxmap topic");
    let head = element("div", "head");
    let heading = element("span", "", `Topic · ${title || "this session"}`);
    heading.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    let refresh = element("button", "iconbtn", "↻");
    refresh.title = "Read the conversation again";
    let close = element("button", "iconbtn", "✕");
    head.append(heading, refresh, close);
    let body = element("div", "body");
    panel.append(head, body);
    ui().append(backdrop, panel);
    let shut = () => {
      backdrop.remove();
      panel.remove();
      keyWindows.delete(windowState);
      topicWindowOpen = null;
    };
    let windowState = {
      shut,
      onKey(event) {
        if (event.type === "keydown" && event.code === "Escape" && !popup) {
          shut();
          return true;
        }
        return false;
      },
    };
    keyWindows.add(windowState);
    topicWindowOpen = windowState;
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    let load = async () => {
      let fresh = await call("tabExtras", [sessionId]).catch(() => null);
      if (topicWindowOpen !== windowState) {
        return;
      }
      if (fresh?.[sessionId]) {
        tabExtras[sessionId] = fresh[sessionId];
        if (fresh[sessionId].todos) {
          taskLists.set(sessionId, { at: Date.now(), data: fresh[sessionId].todos });
        }
      }
      renderTopic(body, sessionId, shut);
    };
    refresh.addEventListener("click", load);
    body.appendChild(element("div", "empty", "Reading the conversation…"));
    await load();
  }
  function renderTopic(body, sessionId, shut) {
    body.textContent = "";
    let extra = tabExtras[sessionId] ?? {};
    let section = (titleText) => {
      let node = element("div", "section");
      node.appendChild(element("h3", "", titleText));
      body.appendChild(node);
      return node;
    };
    let link = (text, url) => {
      let node = element("a", "link", text);
      node.href = "#";
      node.addEventListener("click", (event) => {
        event.preventDefault();
        call("openUrl", url).catch((caught) => flash(caught.message));
      });
      return node;
    };
    // The ticket.
    let ticket = extra.topic?.ticket;
    let ticketSection = section("Ticket");
    if (!ticket) {
      ticketSection.appendChild(element("div", "note", "No Notion ticket in this conversation (none was fetched, and the title names none)."));
    } else {
      let line = element("div", "summary");
      let label = `${ticket.id}${ticket.title ? ` · ${ticket.title}` : ""}`;
      line.appendChild(ticket.url && /^https:/.test(ticket.url) ? link(label, ticket.url) : element("strong", "", label));
      ticketSection.appendChild(line);
      let facts = [ticket.status && `Status: ${ticket.status}`, ticket.priority && `Priority: ${ticket.priority}`, ticket.type && `Type: ${ticket.type}`].filter(Boolean);
      if (facts.length) {
        ticketSection.appendChild(element("div", "", facts.join(" · ")));
      }
      if (ticket.description) {
        ticketSection.appendChild(element("div", "note", ticket.description));
      }
      if (!ticket.read) {
        ticketSection.appendChild(element("div", "note", "Its Notion page was not read in this conversation, so only its ID is known."));
      } else if (ticket.at) {
        ticketSection.appendChild(element("div", "note", `As of ${whenText(ticket.at)} in this conversation`));
      }
    }
    // Implementation and testing, from the task list.
    let data = taskLists.get(sessionId)?.data;
    let items = data?.items ?? [];
    let steps = (rows) => {
      let container = element("div", "rows");
      for (let item of rows) {
        let line = element("div", "r");
        let glyph = item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○";
        let label = element("span", "label", item.status === "in_progress" && item.activeForm ? item.activeForm : item.content);
        label.title = item.content;
        if (item.status === "completed") {
          label.style.opacity = "0.65";
        }
        let estimated = item.estimate > 0 ? minutes(item.estimate * 60000) : "";
        let when =
          item.status === "completed"
            ? item.startedAt && item.doneAt
              ? `took ${minutes(item.doneAt - item.startedAt)}${estimated ? ` (est. ${estimated})` : ""}`
              : estimated && `est. ${estimated}`
            : item.status === "in_progress"
              ? [item.startedAt && `since ${whenText(item.startedAt)}`, estimated && `est. ${estimated}`].filter(Boolean).join(" · ")
              : estimated && `~${estimated}`;
        line.append(element("span", "size", glyph), label, element("span", "when", when || ""));
        container.appendChild(line);
      }
      return container;
    };
    let implementation = section("Implementation");
    if (items.length === 0) {
      implementation.appendChild(element("div", "note", "No task list in this conversation."));
      if (extra.taskList === false) {
        let add = element("a", "link", "Add the task list to this session");
        add.href = "#";
        add.addEventListener("click", (event) => {
          event.preventDefault();
          shut();
          addTaskList(sessionId);
        });
        implementation.appendChild(add);
      }
    } else {
      let now = Date.now();
      implementation.appendChild(element("div", "summary", taskSummary(data, currentEstimate(sessionId, data, now), now).text));
      implementation.appendChild(steps(items));
    }
    let tests = items.filter((item) => TEST_STEP.test(item.content));
    let testing = section("Testing");
    if (tests.length === 0) {
      testing.appendChild(element("div", "note", items.length ? "No testing steps in the task list." : "No task list to read testing from."));
    } else {
      testing.appendChild(element("div", "summary", `${tests.filter((item) => item.status === "completed").length} of ${tests.length} testing steps done`));
      testing.appendChild(steps(tests));
    }
    // The last end-of-turn recap.
    let recap = extra.topic?.recap;
    let recapSection = section("Where it stands (the last turn's recap)");
    if (recap) {
      recapSection.appendChild(element("div", "", recap.text));
      recapSection.appendChild(element("div", "note", whenText(recap.at)));
    } else {
      recapSection.appendChild(element("div", "note", "No recap yet (the app writes one at the end of a turn when the session has its task list)."));
    }
    // The PR.
    let prSection = section("Pull request");
    if (!(extra.prs ?? []).length) {
      prSection.appendChild(element("div", "note", "No open PR for this session."));
    }
    for (let pr of extra.prs ?? []) {
      let line = element("div", "summary");
      line.appendChild(pr.url && /^https:/.test(pr.url) ? link(`#${pr.number} · ${pr.repo}`, pr.url) : element("strong", "", `#${pr.number} · ${pr.repo}`));
      prSection.appendChild(line);
      let facts = [
        pr.draft ? "draft" : "open",
        pr.checks ? `checks ${CI_NAMES[pr.checks]?.replace(/^checks /, "") ?? pr.checks}` : "no checks yet",
        pr.review ? `review: ${PR_REVIEW[pr.review] ?? pr.review.toLowerCase()}` : "",
        pr.mergeable === "CONFLICTING" ? "merge conflicts" : pr.mergeable === "MERGEABLE" ? "mergeable" : "",
        typeof pr.comments === "number" && pr.comments > 0 ? `${pr.comments} open review comment${pr.comments === 1 ? "" : "s"}` : "",
        pr.additions != null ? `+${pr.additions} −${pr.deletions ?? 0}` : "",
      ].filter(Boolean);
      prSection.appendChild(element("div", "", facts.join(" · ")));
    }
  }
  /** Whether a snippet belongs here: no "project", or one naming this conversation's project. */
  function snippetFits(snippet, project) {
    if (!snippet.projects?.length) {
      return true;
    }
    if (!project) {
      return false;
    }
    let folder = (project.folder ?? "").replace(/[\\/]+$/, "").toLowerCase();
    return snippet.projects.some((wanted) => wanted === project.key || wanted === project.name.toLowerCase() || (folder && (folder === wanted || folder.startsWith(`${wanted}\\`) || folder.startsWith(`${wanted}/`))));
  }
  function showSnippets() {
    let pane = activePane();
    let editor = paneEditor(pane);
    let sessionId = paneSessionId(pane);
    let project = tabRows.find((row) => row.kind === "code" && row.id === sessionId)?.project ?? null;
    let fitting = snippets.filter((snippet) => snippetFits(snippet, project));
    listPopup({
      title: project && fitting.some((snippet) => snippet.projects?.length) ? `Snippets (with ${project.name}'s)` : "Snippets",
      items: [...fitting.map((snippet) => ({ value: snippet, label: snippet.name, detail: oneLine(snippet.text).slice(0, 60) })), { value: null, label: "Edit snippets…" }],
      numbered: true,
      width: 560,
      place: placeAbove(editor?.closest('[data-cds="ChatComposerEditor"]')?.getBoundingClientRect() ?? editor?.getBoundingClientRect()),
      onPick: async (snippet) => {
        if (snippet) {
          insertIntoEditor(editor, await expandSnippet(snippet.text, paneSessionId(pane)));
        } else {
          call("openSnippetsFile");
        }
      },
    });
  }
  /** {{folder}} {{branch}} {{file}} {{selection}} {{clipboard}} {{date}} {{time}} {{session}} in a snippet. */
  async function expandSnippet(text, sessionId) {
    if (!/\{\{\s*\w+\s*\}\}/.test(text)) {
      return text;
    }
    let selection = String(getSelection() ?? "").trim();
    let context = await call("snippetContext", sessionId ?? null).catch(() => ({}));
    let now = new Date();
    let values = {
      folder: context.folder ?? "",
      branch: context.branch ?? "",
      file: context.file ?? "",
      clipboard: context.clipboard ?? "",
      selection,
      date: now.toLocaleDateString("sv"),
      time: now.toTimeString().slice(0, 5),
      session: tabRows.find((row) => row.id === sessionId)?.title ?? "",
    };
    return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in values ? values[name] : match));
  }
  let historyPicker = null; // { controls, released }
  async function startHistory(editor) {
    let current = { controls: null, editor };
    historyPicker = current;
    let prompts;
    try {
      prompts = await call("promptHistory");
    } catch (caught) {
      log(`prompt history failed: ${caught.message}`);
      historyPicker = null;
      return;
    }
    if (historyPicker !== current) {
      return;
    }
    if (prompts.length === 0) {
      historyPicker = null;
      flash("No earlier prompts in the last 30 days");
      return;
    }
    // Newest at the bottom, next to the prompt box, so Up goes to older ones.
    current.controls = listPopup({
      title: "Earlier prompts (release Alt to insert)",
      items: prompts.map((text) => ({ value: text, label: oneLine(text).slice(0, 200) })),
      selected: 0,
      reverse: true,
      width: 760,
      place: placeAbove(editor.closest('[data-cds="ChatComposerEditor"]')?.getBoundingClientRect() ?? editor.getBoundingClientRect()),
      onPick: (text) => insertIntoEditor(editor, text),
    });
    current.controls.state.onClose = () => {
      if (historyPicker === current) {
        historyPicker = null;
      }
    };
  }

  // --- Search (Ctrl+Shift+S) -----------------------------------------------------------------
  function openSearch() {
    let panel = element("div", "panel");
    panel.style.width = `${Math.min(760, innerWidth - 32)}px`;
    let input = element("input", "search");
    input.placeholder = "Search every session's prompts and Claude's replies";
    panel.appendChild(input);
    let list = element("div", "list");
    panel.appendChild(list);
    let hits = [];
    let selected = 0;
    let generation = 0;
    let timer = null;
    let draw = () => {
      [...list.children].forEach((row, index) => {
        row.classList.toggle("sel", index === selected);
        index === selected && row.scrollIntoView({ block: "nearest" });
      });
    };
    let render = (terms) => {
      list.textContent = "";
      if (input.value.trim() && hits.length === 0) {
        list.appendChild(element("div", "empty", "No matches"));
      }
      hits.forEach((hit, index) => {
        let row = element("div", "row");
        let wrap = element("span", "two");
        let snippet = hit.inTitle ? hit.title : snippetAround(hit.text, terms, 150);
        wrap.appendChild(highlighted(snippet, terms));
        wrap.appendChild(element("span", "dim", `${hit.inTitle ? "Session title" : hit.fromUser ? "You" : "Claude"}  ·  ${hit.title}${hit.isArchived ? "  ·  archived" : ""}`));
        row.appendChild(wrap);
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          openHit(index);
        });
        list.appendChild(row);
      });
      draw();
    };
    let run = async () => {
      let query = input.value.trim();
      let mine = ++generation;
      if (!query) {
        hits = [];
        render([]);
        return;
      }
      let found = await call("search", query).catch((caught) => {
        log(`search failed: ${caught.message}`);
        return [];
      });
      if (mine !== generation) {
        return;
      }
      hits = found;
      selected = 0;
      render(query.toLowerCase().split(/\s+/).filter(Boolean));
    };
    let openHit = (index) => {
      let hit = hits[index];
      closePopup();
      if (!hit) {
        return;
      }
      openSessionNow(hit.sessionId);
      if (!hit.inTitle) {
        revealWhenOnScreen(hit.sessionId, [...(hit.keys ?? []), ...(hit.promptKeys ?? [])], hit.text);
      }
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(run, 200);
    });
    openPopup(panel, {
      onKey(event) {
        if (event.type !== "keydown") {
          return false;
        }
        if (event.code === "Escape") {
          closePopup();
          return true;
        }
        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
          if (hits.length) {
            selected = (selected + (event.code === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
            draw();
          }
          return true;
        }
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          openHit(selected);
          return true;
        }
        return false;
      },
    });
    placeCentred(0.12)(panel);
    let release = holdFocus(input, () => popup?.node === panel);
    popup.onClose = release;
  }
  function snippetAround(text, terms, width) {
    let flat = oneLine(text);
    let at = terms.length ? Math.max(0, flat.toLowerCase().indexOf(terms[0])) : 0;
    let start = Math.max(0, at - Math.floor(width / 3));
    let end = Math.min(flat.length, start + width);
    return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  }
  /** Whether the entry's row is in the pane's view. */
  function entryInView(pane, keys) {
    let view = pane.transcript.getBoundingClientRect();
    return [...pane.transcript.querySelectorAll("[data-epitaxy-entry]")].some((row) => {
      if (!keys.includes(row.getAttribute("data-epitaxy-entry"))) {
        return false;
      }
      let rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > view.top + 8 && rect.top < view.bottom - 8;
    });
  }
  /** Waits until the pane's scroll position stops changing (the page settles a freshly opened conversation). */
  async function settle(pane, maxMs = 3000) {
    let last = "";
    let stableSince = performance.now();
    let started = performance.now();
    while (performance.now() - started < maxMs) {
      let now = `${Math.round(pane.transcript.scrollTop)}:${pane.transcript.scrollHeight}`;
      if (now !== last) {
        last = now;
        stableSince = performance.now();
      } else if (performance.now() - stableSince > 500) {
        return;
      }
      await sleep(100);
    }
  }
  /**
   * Once the session is on screen, scrolls to the message (by entry id, else by its text), checks
   * that it is in view, and tries again when the page moved the conversation afterwards.
   */
  async function revealWhenOnScreen(sessionId, keys, text) {
    let deadline = Date.now() + 15000;
    let pane = null;
    while (Date.now() < deadline) {
      pane = panes().find((candidate) => paneSessionId(candidate) === sessionId);
      if (pane && paneEntries(pane).length > 0) {
        break;
      }
      pane = null;
      await sleep(200);
    }
    if (!pane) {
      log(`reveal: session ${sessionId} did not come on screen`);
      return;
    }
    await settle(pane);
    let wanted = keys.filter(Boolean);
    for (let attempt = 0; attempt < 4; attempt++) {
      let found = await revealEntry(pane, wanted);
      if (!found && text && attempt === 0) {
        // Re-keyed since it was saved: find it by its opening words (revealEntry has loaded the history).
        let start = normalize(text).slice(0, 80);
        let entry = paneEntries(pane).find((candidate) => normalize(candidate.text).includes(start));
        if (entry) {
          wanted.push(entry.id);
          found = await revealEntry(pane, wanted, { maxLoads: 0 });
        }
      }
      if (!found) {
        log(`reveal: message not found in the conversation ('${oneLine(text).slice(0, 60)}')`);
        flash("Couldn't find that message", innerWidth / 2 - 90, innerHeight / 3);
        return;
      }
      await sleep(700);
      await settle(pane, 1500);
      if (entryInView(pane, wanted)) {
        log(`reveal: on screen after ${attempt + 1} attempt(s)`);
        return;
      }
    }
    log("reveal: the page kept moving away from the message");
  }

  // --- Ticket to PR, many sessions at once (main/powertoys/0352-powertoys-flow.js) -----------------------
  const ipcError = (caught) => String(caught?.message ?? caught).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const codeTitle = (sessionId) => tabRows.find((row) => row.kind === "code" && row.id === sessionId)?.title ?? "";
  function activeCodeRow() {
    let sessionId = paneSessionId(activePane());
    return tabRows.find((row) => row.kind === "code" && row.id === sessionId) ?? null;
  }
  function startFromTicket() {
    askLine({
      title: "Start a session from a Notion ticket: it fetches the ticket, branches and plans",
      placeholder: "ISS-1234, then Enter",
      onEnter(text) {
        call("startFromTicket", text, activeCodeRow()?.project?.folder ?? "").then(
          (started) => flash(started.prefilled ? `${started.id}: the prompt is in the box; send it` : `${started.id}: new session in ${started.folder}`),
          (caught) => flash(ipcError(caught)),
        );
        return true;
      },
    });
  }
  function fixCi(sessionId) {
    call("fixCi", sessionId).then(
      (number) => flash(`Asked it to fix CI on PR #${number}`),
      (caught) => flash(ipcError(caught)),
    );
  }
  /** "Compact now" is offered while a cost or context warning is set (costWarnUsd, contextWarnPercent). */
  const compactOffered = () => Number(settings?.costWarnUsd) > 0 || Number(settings?.contextWarnPercent) > 0;
  function compactNow(sessionId) {
    call("compactNow", sessionId).then(
      () => flash("Compacting (now, or when its turn ends)"),
      (caught) => flash(ipcError(caught)),
    );
  }
  function goToMostUrgent() {
    call("mostUrgent").then(
      (next) => (next ? openConversation({ kind: "code", id: next.sessionId }) : flash("Nothing waits for you")),
      (caught) => flash(ipcError(caught)),
    );
  }
  async function showReviewThreads() {
    flash("Reading the review comments…");
    let threads = await call("reviewThreads").catch((caught) => (flash(ipcError(caught)), null));
    if (!threads) {
      return;
    }
    listPopup({
      title: "Review comments to answer: Enter sends one to its session, ↗ opens it on GitHub",
      items: threads.map((thread) => ({
        value: thread,
        render: () => {
          let wrap = element("span", "two");
          let where = thread.path ? ` · ${thread.path}${thread.line ? `:${thread.line}` : ""}` : "";
          wrap.appendChild(element("span", "", `${thread.title} · PR #${thread.pr}${where}${thread.outdated ? " (outdated)" : ""}`));
          wrap.appendChild(element("span", "dim", `${thread.author}: ${thread.body.replace(/\s+/g, " ").slice(0, 170)}${thread.replies ? ` (+${thread.replies} replies)` : ""}`));
          let open = element("span", "dim", "  ↗ open");
          open.style.cursor = "pointer";
          open.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            call("openUrl", thread.url).catch((caught) => flash(ipcError(caught)));
          });
          wrap.appendChild(open);
          return wrap;
        },
      })),
      emptyText: "No unresolved review comments on your sessions' open PRs.",
      place: placeCentred(0.15),
      width: 780,
      onPick: (thread) => call("sendReviewThread", thread).then(() => flash(`Sent to “${thread.title}”`), (caught) => flash(ipcError(caught))),
    });
  }
  /** A text box panel; Ctrl+Enter runs onSave(text), Esc closes. */
  function askText({ title, value = "", placeholder = "", extra = null, onSave }) {
    closePopup();
    let panel = element("div", "panel");
    panel.style.width = "620px";
    panel.appendChild(element("div", "title", title));
    let input = element("textarea", "search");
    input.placeholder = placeholder;
    input.value = value;
    panel.appendChild(input);
    extra?.(panel);
    let save = element("button", "action", "Save (Ctrl+Enter)");
    let run = () => {
      if (onSave(input.value) !== false) {
        closePopup();
      }
    };
    save.addEventListener("click", run);
    panel.appendChild(save);
    openPopup(panel, {
      onKey(event) {
        if (event.type !== "keydown") {
          return false;
        }
        if (event.code === "Escape") {
          closePopup();
          return true;
        }
        if ((event.code === "Enter" || event.code === "NumpadEnter") && (event.ctrlKey || event.metaKey)) {
          run();
          return true;
        }
        return false;
      },
    });
    placeCentred(0.15)(panel);
    let release = holdFocus(input, () => popup?.node === panel);
    popup.onClose = release;
  }
  function broadcastPrompt() {
    let rows = tabsWanted().list.filter((row) => row.kind === "code");
    if (rows.length === 0) {
      flash("No session tabs are open");
      return;
    }
    let boxes = [];
    askText({
      title: "One prompt to several sessions: each gets it now, or when its turn ends (Ctrl+Enter sends)",
      placeholder: "The prompt",
      extra(panel) {
        for (let row of rows) {
          let label = element("label", "check");
          let box = element("input");
          box.type = "checkbox";
          label.append(box, row.title || row.id);
          panel.appendChild(label);
          boxes.push([row, box]);
        }
      },
      onSave(text) {
        let ids = boxes.filter(([, box]) => box.checked).map(([row]) => row.id);
        if (!text.trim() || ids.length === 0) {
          flash("Write a prompt and tick the sessions");
          return false;
        }
        call("broadcast", ids, text).then(
          (count) => flash(`Queued for ${count} session${count === 1 ? "" : "s"}`),
          (caught) => flash(ipcError(caught)),
        );
        return true;
      },
    });
  }
  function editProjectInstructions(row) {
    let project = row?.project;
    if (!project?.folder) {
      flash("This session has no project folder");
      return;
    }
    let current = projectSetting(settings?.projectInstructions, project.key);
    askText({
      title: `Instructions for every new session in ${project.name} (added to its system prompt; empty removes them)`,
      value: current?.text ?? "",
      placeholder: "For example: run the tests with …; tickets are ISS-…; never push to main",
      onSave(text) {
        call("projectInstructions", project.key, project.folder, text, true).then(
          () => flash(text.trim() ? `Saved: new sessions in ${project.name} get them` : "Removed"),
          (caught) => flash(ipcError(caught)),
        );
        return true;
      },
    });
  }
  async function showTimeline() {
    let data = await call("dayTimeline").catch((caught) => (flash(ipcError(caught)), null));
    if (!data) {
      return;
    }
    closePopup();
    let panel = element("div", "panel");
    panel.style.width = `${Math.min(980, innerWidth - 32)}px`;
    panel.appendChild(element("div", "title", "Today: when each session worked (blue) and waited for you (orange); click a name to open it"));
    let start = Math.min(data.now, ...data.sessions.flatMap((item) => item.spans.map((span) => span.from)));
    let length = Math.max(60000, data.now - start);
    if (data.sessions.length === 0) {
      panel.appendChild(element("div", "dim", "Nothing recorded yet today (recording started with this version)."));
    }
    for (let item of data.sessions) {
      let line = element("div", "timeline-row");
      let name = element("span", "timeline-name", item.title || item.sessionId);
      name.title = item.title;
      name.addEventListener("click", () => {
        closePopup();
        openConversation({ kind: "code", id: item.sessionId });
      });
      let bar = element("span", "timeline-bar");
      for (let span of item.spans) {
        let block = element("span", `timeline-${span.state}`);
        block.style.left = `${((span.from - start) / length) * 100}%`;
        block.style.width = `${Math.max(0.3, ((span.to - span.from) / length) * 100)}%`;
        block.title = `${span.state === "working" ? "Working" : "Waiting for you"} ${clock(span.from)}–${clock(span.to)} (${minutes(span.to - span.from)})`;
        bar.appendChild(block);
      }
      line.append(name, bar);
      panel.appendChild(line);
    }
    panel.appendChild(element("div", "dim", `${clock(start)} – ${clock(data.now)}`));
    openPopup(panel, {
      onKey(event) {
        if (event.type === "keydown" && event.code === "Escape") {
          closePopup();
          return true;
        }
        return false;
      },
    });
    placeCentred(0.12)(panel);
  }
  async function showWorktrees() {
    flash("Checking the worktrees…");
    let list = await call("worktrees").catch((caught) => (flash(ipcError(caught)), null));
    if (!list) {
      return;
    }
    let removable = list.filter((worktree) => worktree.dirty === false && worktree.pr?.state === "merged");
    let age = (at) => (at ? `${Math.max(0, Math.round((Date.now() - at) / 86400000))} d ago` : "?");
    listPopup({
      title: "The app's worktrees, least recently used first",
      items: [
        ...(removable.length ? [{ value: "remove", label: `Remove the ${removable.length} whose PR is merged and that have no uncommitted changes` }] : []),
        ...list.map((worktree) => ({
          value: worktree,
          label: `${worktree.branch || worktree.name}${worktree.session ? ` · ${worktree.session.title}` : ""}`,
          detail: `${worktree.pr ? `PR #${worktree.pr.number} ${worktree.pr.state}` : "no PR"} · ${worktree.dirty ? "uncommitted changes" : worktree.dirty === false ? "clean" : "?"} · used ${age(worktree.lastUsed)} · ${worktree.path}`,
        })),
      ],
      emptyText: "The app has no worktrees.",
      place: placeCentred(0.15),
      width: 820,
      onPick: (picked) =>
        picked === "remove"
          ? call("removeWorktrees", removable.map((worktree) => worktree.name)).then(
              (removed) => flash(`Removed ${removed.length} worktree${removed.length === 1 ? "" : "s"}`),
              (caught) => flash(ipcError(caught)),
            )
          : picked.session && openConversation({ kind: "code", id: picked.session.sessionId }),
    });
  }
  let tabLimits = {}; // sessionId -> { cost, contextPercent, over } (sessionLimits, every minute)
  let tabLimitsAt = 0;

  // --- The time a message was sent, above it while the pointer is on it (setting messageTimes) ---------
  let timedRow = null;
  let messageTimeNote = null;
  let messageTimeFrame = 0;
  function messageTimeText(at) {
    let date = new Date(at);
    let today = new Date();
    let time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (date.toDateString() === today.toDateString()) {
      return time;
    }
    let day = date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(date.getFullYear() !== today.getFullYear() && { year: "numeric" }) });
    return `${day}, ${time}`;
  }
  function hideMessageTime() {
    timedRow = null;
    messageTimeNote?.remove();
    messageTimeNote = null;
  }
  function showMessageTime() {
    messageTimeFrame = 0;
    let under = settings?.messageTimes !== false && pointer.x >= 0 ? document.elementFromPoint(pointer.x, pointer.y) : null;
    let row = under?.closest?.("[data-epitaxy-entry]") ?? null;
    if (row === timedRow) {
      return;
    }
    hideMessageTime();
    let pane = row && paneOf(row);
    let at = pane ? mainWorld("entryTime", pane.transcript, row.getAttribute("data-epitaxy-entry")) : 0;
    if (!at) {
      return;
    }
    timedRow = row;
    // Over the message's own bubble when it has one (yours, on the right), else over the row.
    let anchor = row.querySelector('[data-testid="user-message"]') ?? row;
    let rect = anchor.getBoundingClientRect();
    messageTimeNote = element("div", "message-time", messageTimeText(at));
    ui().appendChild(messageTimeNote);
    let left = anchor === row ? rect.left : rect.right - messageTimeNote.offsetWidth;
    messageTimeNote.style.left = `${Math.max(8, Math.min(innerWidth - messageTimeNote.offsetWidth - 8, left))}px`;
    messageTimeNote.style.top = `${Math.max(4, rect.top - messageTimeNote.offsetHeight - 3)}px`;
  }
  window.addEventListener("scroll", hideMessageTime, { capture: true, passive: true });

  // --- Bookmarks (right-click a message) ---------------------------------------------------------
  /** The message row under the pointer and the paragraph the pointer is on. */
  function messageAtPointer() {
    if (pointer.x < 0) {
      return null;
    }
    let under = document.elementFromPoint(pointer.x, pointer.y);
    let entryElement = under?.closest?.("[data-epitaxy-entry]");
    if (!entryElement) {
      return null;
    }
    let pane = paneOf(entryElement);
    if (!pane) {
      return null;
    }
    let entryId = entryElement.getAttribute("data-epitaxy-entry");
    let entry = paneEntries(pane).find((candidate) => candidate.id === entryId);
    let paragraph = under.closest("p, li, pre, blockquote, h1, h2, h3, h4, td")?.innerText?.trim() ?? "";
    let row = entryElement.closest('[data-testid="transcript-row"]');
    let fromUser = entry ? entry.fromUser : row?.dataset.perfRow === "human" || !!entryElement.querySelector('[data-testid="user-message"]');
    let text = (entry?.text ?? "").trim();
    // A long reply: keep the paragraph pointed at, so the bookmark says which part it is.
    if (!fromUser && paragraph.length >= 15 && text.length > 600 && text.includes(paragraph.slice(0, 40))) {
      text = paragraph;
    }
    if (!text) {
      text = paragraph || entryElement.innerText.replace(/^(You said|Claude responded): /, "").trim();
    }
    return { pane, entryId, fromUser, text };
  }
  /**
   * A right-click on a message opens the page's own message menu (Copy message, Fork from here, …);
   * "Bookmark message" / "Remove bookmark" is added to it, styled like its items.
   */
  function onMessageContextMenu(event) {
    if (!event.isTrusted || !settings?.bookmarks) {
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    let message = messageAtPointer();
    let sessionId = message && paneSessionId(message.pane);
    if (!message || !sessionId || !message.text) {
      return;
    }
    let titles = mainWorld("titles", message.pane.transcript) ?? {};
    let target = {
      sessionId,
      sessionTitle: titles[sessionId] || document.title.replace(/\s+[-–]\s+Claude(?: Code)?$/, ""),
      entryId: message.entryId,
      fromUser: message.fromUser,
      text: message.text,
    };
    let started = performance.now();
    let look = () => {
      let menu = [...document.querySelectorAll('[role="menu"]')].find(
        (candidate) =>
          isShown(candidate) &&
          !candidate.hasAttribute("data-closed") &&
          [...candidate.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.trim() === "Copy message"),
      );
      if (menu) {
        addBookmarkItem(menu, target);
      } else if (performance.now() - started < 1500) {
        setTimeout(look, 30);
      } else {
        log("bookmark: the message menu did not open");
      }
    };
    setTimeout(look, 0);
  }
  let menuTargetRow = null;
  function addBookmarkItem(menu, target) {
    menuTargetRow = [...document.querySelectorAll("[data-epitaxy-entry]")].find((row) => row.getAttribute("data-epitaxy-entry") === target.entryId) ?? null;
    if (menu.querySelector("[data-powertoys-item]")) {
      return;
    }
    let template = [...menu.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === "Copy message");
    let existing = bookmarkData.bookmarks.find((bookmark) => bookmark.sessionId === target.sessionId && bookmark.entryId === target.entryId);
    let item = template.cloneNode(false);
    item.removeAttribute("id");
    item.removeAttribute("data-highlighted");
    item.setAttribute("data-powertoys-item", "");
    let label = template.querySelector("span")?.cloneNode(false) ?? document.createElement("span");
    label.textContent = existing ? "Remove bookmark" : "Bookmark message";
    item.appendChild(label);
    // The page highlights its items through data-highlighted; this one is not React's, so do it here.
    item.addEventListener("pointerenter", () => {
      menu.querySelectorAll("[data-highlighted]").forEach((other) => other.removeAttribute("data-highlighted"));
      item.setAttribute("data-highlighted", "");
    });
    item.addEventListener("pointerleave", () => item.removeAttribute("data-highlighted"));
    item.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Close the page's menu the way Escape does.
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      try {
        if (existing) {
          await call("bookmark", "remove", [existing.id]);
          flash("Bookmark removed");
        } else {
          await call("bookmark", "toggle", target);
          flash("★ Bookmarked");
        }
      } catch (caught) {
        flash("Couldn't bookmark");
        log(`bookmark failed: ${caught.message}`);
      }
    });
    let rewindItem = [...menu.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent.trim().startsWith("Rewind to here"));
    if (rewindItem && !menu.querySelector("[data-powertoys-edit-item]")) {
      let editItem = template.cloneNode(false);
      editItem.removeAttribute("id");
      editItem.removeAttribute("data-highlighted");
      editItem.setAttribute("data-powertoys-item", "");
      editItem.setAttribute("data-powertoys-edit-item", "");
      let editLabel = template.querySelector("span")?.cloneNode(false) ?? document.createElement("span");
      editLabel.textContent = "Edit message";
      editItem.appendChild(editLabel);
      editItem.addEventListener("pointerenter", () => {
        menu.querySelectorAll("[data-highlighted]").forEach((other) => other.removeAttribute("data-highlighted"));
        editItem.setAttribute("data-highlighted", "");
      });
      editItem.addEventListener("pointerleave", () => editItem.removeAttribute("data-highlighted"));
      editItem.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        let pane = paneOf(menuTargetRow) ?? activePane();
        rewindItem.click();
        focusRestoredPrompt(pane);
      });
      rewindItem.before(editItem);
    }
    let separator = menu.querySelector('[role="separator"]')?.cloneNode(false);
    template.before(item);
    if (separator) {
      separator.setAttribute("data-powertoys-item", "");
      template.before(separator);
    }
  }
  function openBookmark(bookmark) {
    openSessionNow(bookmark.sessionId);
    revealWhenOnScreen(bookmark.sessionId, [bookmark.entryId], bookmark.text);
  }

  // --- Bookmark manager ------------------------------------------------------------------------
  let manager = null; // { render() }
  function openBookmarkManager() {
    closePopup();
    if (manager) {
      return;
    }
    let state = { folder: "*", query: "", sort: "newest", selected: new Set(), anchor: null, renaming: null };
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel manager");
    let head = element("div", "head");
    head.appendChild(element("span", "", "Bookmarks"));
    let close = element("button", "iconbtn", "✕");
    head.appendChild(close);
    let side = element("div", "side");
    let search = element("input");
    search.placeholder = "Search bookmarks";
    let folderList = element("div");
    side.append(search, folderList);
    let content = element("div", "content");
    let bar = element("div", "bar");
    let sortChip = element("button", "chip");
    bar.appendChild(sortChip);
    let count = element("span", "dim");
    bar.appendChild(count);
    let list = element("div", "list");
    content.append(bar, list);
    panel.append(head, side, content);
    ui().append(backdrop, panel);
    let releaseFocus = () => {};
    let shut = () => {
      releaseFocus();
      backdrop.remove();
      panel.remove();
      manager = null;
    };
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    search.addEventListener("input", () => {
      state.query = search.value.trim().toLowerCase();
      render();
    });
    sortChip.addEventListener("click", () => {
      state.sort = { newest: "oldest", oldest: "name", name: "newest" }[state.sort];
      render();
    });
    let visible = () => {
      let all = bookmarkData.bookmarks.filter((bookmark) =>
        state.query
          ? `${bookmark.name} ${bookmark.text} ${bookmark.sessionTitle}`.toLowerCase().includes(state.query)
          : state.folder === "*" || bookmark.folder === state.folder,
      );
      if (state.sort === "oldest") {
        all = [...all].reverse();
      } else if (state.sort === "name") {
        all = [...all].sort((left, right) => left.name.localeCompare(right.name));
      }
      return all;
    };
    let folderRow = (key, label, countOf) => {
      let row = element("div", `folder${state.folder === key && !state.query ? " sel" : ""}`);
      row.append(element("span", "", label), element("span", "dim", String(countOf)));
      row.addEventListener("click", () => {
        state.folder = key;
        state.query = "";
        search.value = "";
        state.selected.clear();
        render();
      });
      if (key !== "*") {
        row.addEventListener("dragover", (event) => {
          event.preventDefault();
          row.classList.add("drop");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop"));
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          row.classList.remove("drop");
          let ids = JSON.parse(event.dataTransfer.getData("text/x-powertoys-bookmarks") || "[]");
          if (ids.length) {
            call("bookmark", "move", ids, key);
          }
        });
      }
      if (key !== "*" && key !== "") {
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          contextMenu(
            [
              { label: "Rename folder…", onClick: () => renameFolder(key) },
              { label: "Delete folder (bookmarks move to Unsorted)", onClick: () => call("bookmark", "deleteFolder", key).then(() => state.folder === key && (state.folder = "*")) },
            ],
            event.clientX,
            event.clientY,
          );
        });
      }
      return row;
    };
    let renameFolder = (folder) => {
      let row = [...folderList.children].find((child) => child.dataset.folder === folder);
      inlineEdit(row?.firstChild ?? null, folder, (name) =>
        call("bookmark", "renameFolder", folder, name).then((ok) => {
          if (ok && state.folder === folder) {
            state.folder = name.trim();
          }
          if (!ok) {
            flash("That name is empty or taken");
          }
        }),
      );
    };
    let inlineEdit = (target, value, done) => {
      if (!target) {
        return;
      }
      let input = element("input", "rename");
      input.value = value;
      target.replaceWith(input);
      input.focus();
      input.select();
      let finished = false;
      let finish = (commit) => {
        if (finished) {
          return;
        }
        finished = true;
        state.renaming = null;
        inlineEditing = null;
        commit && input.value.trim() !== value ? done(input.value) : render();
      };
      inlineEditing = {
        onKey(event) {
          if (event.type === "keydown" && (event.code === "Enter" || event.code === "NumpadEnter")) {
            finish(true);
            return true;
          }
          if (event.type === "keydown" && event.code === "Escape") {
            finish(false);
            return true;
          }
          return false;
        },
      };
      input.addEventListener("blur", () => finish(true));
      state.renaming = input;
    };
    let openSelected = () => {
      let bookmark = bookmarkData.bookmarks.find((candidate) => state.selected.has(candidate.id));
      if (bookmark) {
        shut();
        openBookmark(bookmark);
      }
    };
    let render = () => {
      let { folders, bookmarks } = bookmarkData;
      folderList.textContent = "";
      folderList.appendChild(folderRow("*", "All bookmarks", bookmarks.length));
      folderList.appendChild(folderRow("", "Unsorted", bookmarks.filter((bookmark) => bookmark.folder === "").length));
      for (let folder of folders) {
        let row = folderRow(folder, `📁  ${folder}`, bookmarks.filter((bookmark) => bookmark.folder === folder).length);
        row.dataset.folder = folder;
        folderList.appendChild(row);
      }
      let add = element("div", "folder dim", "+  New folder");
      add.addEventListener("click", () => call("bookmark", "addFolder", "New folder").then((name) => setTimeout(() => renameFolder(name), 50)));
      folderList.appendChild(add);
      sortChip.textContent = `Sort: ${state.sort}`;
      let shown = visible();
      count.textContent = `${shown.length} bookmark${shown.length === 1 ? "" : "s"}`;
      list.textContent = "";
      if (shown.length === 0) {
        list.appendChild(element("div", "empty", bookmarks.length ? "No bookmarks here" : "No bookmarks yet: right-click a message in a conversation and choose Bookmark message"));
      }
      shown.forEach((bookmark, index) => {
        let row = element("div", `row${state.selected.has(bookmark.id) ? " sel" : ""}`);
        row.draggable = true;
        let wrap = element("span", "two");
        let name = element("span", "", bookmark.name);
        wrap.append(name, element("span", "dim", `${bookmark.fromUser ? "You" : "Claude"}  ·  ${bookmark.sessionTitle}  ·  ${ago(bookmark.addedAt)}${bookmark.folder && state.folder === "*" ? `  ·  📁 ${bookmark.folder}` : ""}`));
        row.title = bookmark.text;
        row.appendChild(wrap);
        row.addEventListener("mousedown", (event) => {
          if (event.button === 2 && state.selected.has(bookmark.id)) {
            return;
          }
          if (event.shiftKey && state.anchor !== null) {
            let from = Math.min(state.anchor, index);
            let to = Math.max(state.anchor, index);
            if (!event.ctrlKey) {
              state.selected.clear();
            }
            shown.slice(from, to + 1).forEach((other) => state.selected.add(other.id));
          } else if (event.ctrlKey) {
            state.selected.has(bookmark.id) ? state.selected.delete(bookmark.id) : state.selected.add(bookmark.id);
            state.anchor = index;
          } else {
            state.selected = new Set([bookmark.id]);
            state.anchor = index;
          }
          render();
        });
        row.addEventListener("dblclick", openSelected);
        row.addEventListener("dragstart", (event) => {
          if (!state.selected.has(bookmark.id)) {
            state.selected = new Set([bookmark.id]);
          }
          event.dataTransfer.setData("text/x-powertoys-bookmarks", JSON.stringify([...state.selected]));
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          let ids = [...state.selected];
          contextMenu(
            [
              { label: "Open", onClick: openSelected, disabled: ids.length !== 1 },
              { label: "Rename", onClick: () => inlineEdit(name, bookmark.name, (value) => call("bookmark", "rename", bookmark.id, value)), disabled: ids.length !== 1 },
              {
                label: "Move to",
                submenu: [
                  { label: "Unsorted", onClick: () => call("bookmark", "move", ids, "") },
                  ...bookmarkData.folders.map((folder) => ({ label: `📁  ${folder}`, onClick: () => call("bookmark", "move", ids, folder) })),
                ],
              },
              { label: "Copy message text", onClick: () => navigator.clipboard.writeText(bookmarkData.bookmarks.filter((other) => state.selected.has(other.id)).map((other) => other.text).join("\n\n")) },
              "-",
              { label: ids.length > 1 ? `Delete ${ids.length} bookmarks` : "Delete", onClick: () => call("bookmark", "remove", ids) },
            ],
            event.clientX,
            event.clientY,
          );
        });
        list.appendChild(row);
      });
    };
    manager = {
      render,
      onKey(event) {
        if (event.type !== "keydown" || state.renaming) {
          return false;
        }
        if (popup) {
          return false;
        }
        if (event.code === "Escape") {
          shut();
          return true;
        }
        if (shadow?.activeElement === search && !["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.code)) {
          return false;
        }
        let shown = visible();
        let index = shown.findIndex((bookmark) => state.selected.has(bookmark.id));
        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
          let next = Math.max(0, Math.min(shown.length - 1, index + (event.code === "ArrowDown" ? 1 : -1)));
          if (shown[next]) {
            state.selected = new Set([shown[next].id]);
            state.anchor = next;
            render();
          }
          return true;
        }
        if (event.code === "Enter") {
          openSelected();
          return true;
        }
        if (event.code === "Delete" && state.selected.size) {
          call("bookmark", "remove", [...state.selected]);
          state.selected.clear();
          return true;
        }
        if (event.code === "F2" && state.selected.size === 1) {
          let id = [...state.selected][0];
          let row = list.children[shown.findIndex((bookmark) => bookmark.id === id)];
          let bookmark = shown.find((candidate) => candidate.id === id);
          inlineEdit(row?.querySelector(".two > span"), bookmark.name, (value) => call("bookmark", "rename", id, value));
          return true;
        }
        return false;
      },
    };
    render();
    releaseFocus = holdFocus(search, () => manager !== null && !state.renaming);
  }

  // --- "Open in" your own apps ---------------------------------------------------------------------
  // The page's Open-in menu (Open in VS Code / Cursor / …, Show in Explorer) lists a fixed set of
  // editors; the apps in openin.json are added to it, with the file's path from the menu's props.
  let openInApps = null;
  async function decorateOpenInMenus() {
    for (let menu of document.querySelectorAll('[role="menu"]')) {
      if (menu.hasAttribute("data-closed") || menu.hasAttribute("data-powertoys-openin-checked")) {
        continue;
      }
      let reveal = [...menu.querySelectorAll('[role="menuitem"]')].find((item) => /^Show in (Explorer|Finder|file manager)$/.test(item.textContent.trim()));
      if (!reveal) {
        continue;
      }
      menu.setAttribute("data-powertoys-openin-checked", "");
      openInApps ??= await call("openInApps").catch(() => []);
      let filePath = mainWorld("menuFilePath", reveal);
      if (!openInApps.length || typeof filePath !== "string" || !reveal.isConnected) {
        continue;
      }
      for (let name of openInApps) {
        let item = reveal.cloneNode(true);
        item.removeAttribute("id");
        item.removeAttribute("data-highlighted");
        item.setAttribute("data-powertoys-openin", "");
        let label = [...item.querySelectorAll("span, div")].reverse().find((node) => node.textContent.trim() === reveal.textContent.trim() && node.children.length === 0);
        (label ?? item).textContent = `Open in ${name}`;
        item.addEventListener("pointerenter", () => {
          menu.querySelectorAll("[data-highlighted]").forEach((other) => other.removeAttribute("data-highlighted"));
          item.setAttribute("data-highlighted", "");
        });
        item.addEventListener("pointerleave", () => item.removeAttribute("data-highlighted"));
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
          call("openIn", name, filePath).catch((caught) => flash(caught.message));
        });
        reveal.before(item);
      }
    }
  }

  // --- Archived sessions -------------------------------------------------------------------------
  let archivedWindow = null;
  async function openArchived() {
    closePopup();
    if (archivedWindow) {
      return;
    }
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel history");
    let head = element("div", "head");
    head.appendChild(element("span", "", "Archived sessions"));
    let search = element("input");
    search.placeholder = "Filter";
    head.appendChild(search);
    let close = element("button", "iconbtn", "✕");
    head.appendChild(close);
    let list = element("div", "list");
    panel.append(head, list);
    ui().append(backdrop, panel);
    let sessions = [];
    let shut = () => {
      releaseFocus();
      backdrop.remove();
      panel.remove();
      archivedWindow = null;
    };
    let render = () => {
      let query = search.value.trim().toLowerCase();
      list.textContent = "";
      let shown = sessions.filter((session) => !query || `${session.title} ${session.folder}`.toLowerCase().includes(query));
      if (shown.length === 0) {
        list.appendChild(element("div", "empty", sessions.length ? "Nothing matches" : "No archived sessions"));
      }
      for (let session of shown) {
        let row = element("div", "row");
        row.style.gridTemplateColumns = "minmax(0, 1fr) minmax(100px, 22%) auto auto";
        let open = element("button", "action", "Open");
        let restore = element("button", "action", "Unarchive");
        row.append(element("span", "text", session.title), element("span", "where", `${session.folder}  ·  ${ago(session.lastActivityAt)}`), open, restore);
        open.addEventListener("click", () => {
          shut();
          openSessionNow(session.sessionId);
        });
        restore.addEventListener("click", async () => {
          if (await call("unarchive", session.sessionId).catch(() => false)) {
            sessions = sessions.filter((other) => other !== session);
            render();
            flash("Unarchived");
          }
        });
        list.appendChild(row);
      }
    };
    search.addEventListener("input", render);
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    let releaseFocus = holdFocus(search, () => archivedWindow !== null && !popup);
    archivedWindow = {
      onKey(event) {
        if (event.type === "keydown" && event.code === "Escape" && !popup) {
          shut();
          return true;
        }
        return false;
      },
    };
    list.appendChild(element("div", "empty", "Loading…"));
    sessions = await call("archivedSessions").catch(() => []);
    if (archivedWindow) {
      render();
    }
  }

  // --- New profile -------------------------------------------------------------------------------
  function askNewProfile() {
    let panel = element("div", "panel");
    panel.style.width = "420px";
    panel.appendChild(element("div", "title", "New profile: its own sign-in, sessions and settings"));
    let input = element("input", "search");
    input.placeholder = "Profile name (letters, digits, spaces, - or _)";
    panel.appendChild(input);
    let state = openPopup(panel, {
      onKey(event) {
        if (event.type !== "keydown") {
          return false;
        }
        if (event.code === "Escape") {
          closePopup();
          return true;
        }
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          let name = input.value.trim();
          closePopup();
          call("launchProfile", name).then(
            () => flash(`Starting Claude with the profile "${name}"…`, innerWidth / 2 - 120, innerHeight / 3),
            (caught) => flash(caught.message, innerWidth / 2 - 160, innerHeight / 3),
          );
          return true;
        }
        return false;
      },
    });
    placeCentred(0.25)(panel);
    state.onClose = holdFocus(input, () => popup?.node === panel);
  }

  // --- Settings window -------------------------------------------------------------------------------
  // Rendered from the main process's layout (POWERTOYS_SETTINGS_SECTIONS). A control shows the saved
  // value: a change is sent to the main process, and the window redraws when it announces the saved
  // settings (no optimistic updates).
  let settingsWindow = null;
  async function openSettings() {
    closePopup();
    if (settingsWindow) {
      return;
    }
    let languages = await call("spellLanguages").catch(() => []);
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel settings");
    let head = element("div", "head");
    head.appendChild(element("span", "", "Powertoys settings"));
    let close = element("button", "iconbtn", "✕");
    head.appendChild(close);
    let body = element("div", "body");
    panel.append(head, body);
    ui().append(backdrop, panel);
    let save = (key, value) => call("setSetting", key, value).catch((caught) => flash(`Couldn't save: ${caught.message}`));
    let render = () => {
      let scroll = body.scrollTop;
      body.textContent = "";
      for (let section of settingsSections) {
        body.appendChild(element("h3", "", section.title));
        for (let item of section.items) {
          let row = element("div", "item");
          let label = element("label", "", item.label);
          row.appendChild(label);
          let value = settings[item.key];
          if (item.type === "switch") {
            let toggle = element("div", `toggle${value ? " on" : ""}`);
            toggle.setAttribute("role", "switch");
            toggle.setAttribute("aria-checked", String(!!value));
            toggle.addEventListener("click", () => save(item.key, !value));
            label.addEventListener("click", () => save(item.key, !value));
            row.appendChild(toggle);
          } else if (item.type === "number" || item.type === "text") {
            let input = element("input");
            input.type = item.type;
            if (item.min !== undefined) {
              input.min = String(item.min);
              input.max = String(item.max);
            }
            input.value = String(value ?? "");
            let commit = () => {
              let next = item.type === "number" ? Number(input.value) : input.value.trim();
              if (item.type === "number" && (!Number.isFinite(next) || next < item.min || next > item.max)) {
                input.value = String(value);
                flash(`Between ${item.min} and ${item.max}`);
                return;
              }
              if (next !== value) {
                save(item.key, next);
              }
            };
            input.addEventListener("change", commit);
            row.appendChild(input);
          } else if (item.type === "languages") {
            let chosen = new Set(String(value).split(",").map((code) => code.trim()).filter(Boolean));
            let box = element("div", "langs");
            for (let code of [...chosen].filter((code) => !languages.includes(code)).concat(languages)) {
              let option = element("label");
              let check = element("input");
              check.type = "checkbox";
              check.checked = chosen.has(code);
              check.addEventListener("click", (event) => {
                event.preventDefault();
                let next = new Set(chosen);
                next.has(code) ? next.delete(code) : next.add(code);
                if (next.size === 0) {
                  flash("Keep at least one language");
                  return;
                }
                save(item.key, [...next].join(","));
              });
              option.append(check, code);
              box.appendChild(option);
            }
            row.appendChild(box);
          } else if (item.type === "action") {
            label.textContent = "";
            let button = element("button", "action", item.label);
            button.addEventListener("click", () => {
              return item.key === "openInbox"
                ? openInbox()
                : call("settingsAction", item.key).catch((caught) => flash(caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
            });
            row.appendChild(button);
          }
          body.appendChild(row);
        }
      }
      body.scrollTop = scroll;
    };
    let shut = () => {
      backdrop.remove();
      panel.remove();
      settingsWindow = null;
    };
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    settingsWindow = {
      render,
      onKey(event) {
        if (event.type === "keydown" && event.code === "Escape" && !popup) {
          shut();
          return true;
        }
        return false;
      },
    };
    render();
  }

  // --- Notification inbox: every notification this run, answerable while its request waits ---------
  let inboxWindow = null;
  async function openInbox() {
    closePopup();
    if (inboxWindow) {
      inboxWindow.refresh();
      return;
    }
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel history inbox");
    let head = element("div", "head");
    head.appendChild(element("span", "", "Notification inbox"));
    let filter = element("select");
    for (let [value, text] of [["all", "All"], ["waiting", "Waiting for an answer"]]) {
      let option = element("option", "", text);
      option.value = value;
      filter.appendChild(option);
    }
    filter.style.cssText = "padding:6px 8px;border-radius:8px;background:hsl(var(--bg-100, 0 0% 8%));color:inherit;border:1px solid hsl(var(--border-300, 52 12% 87%) / 0.18);font:inherit;";
    let spacer = element("span");
    spacer.style.flex = "1";
    let clear = element("button", "action", "Clear answered");
    let close = element("button", "iconbtn", "✕");
    head.append(filter, spacer, clear, close);
    let list = element("div", "list");
    panel.append(head, list);
    ui().append(backdrop, panel);
    let entries = [];
    let answer = async (entry, kind, value) => {
      entries = (await call("inbox", "answer", entry.id, kind, value).catch((caught) => {
        flash(caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
        return null;
      })) ?? entries;
      render();
    };
    let render = () => {
      let scroll = list.scrollTop;
      list.textContent = "";
      let shown = entries.filter((entry) => filter.value === "all" || entry.answerable);
      if (shown.length === 0) {
        list.appendChild(element("div", "empty", filter.value === "all" ? "No notifications since Claude started" : "Nothing is waiting for an answer"));
      }
      for (let entry of shown) {
        let row = element("div", "row");
        row.appendChild(element("span", "dim", ago(Date.now() - entry.at)));
        let text = element("div");
        let title = element("div", "", entry.title);
        title.style.fontWeight = "600";
        text.append(title, element("div", "body", entry.body));
        row.appendChild(text);
        let acts = element("div", "acts");
        if (entry.answerable) {
          acts.appendChild(element("span", "chip waiting", "waiting"));
          for (let action of entry.actions) {
            let button = element("button", "action", action.text);
            button.addEventListener("click", () => answer(entry, "action", action.type));
            acts.appendChild(button);
          }
          if (entry.reply) {
            let input = element("input");
            input.placeholder = entry.reply.placeholder || "Type an answer";
            let send = element("button", "action", "Send");
            let go = () => input.value.trim() && answer(entry, "reply", input.value.trim());
            send.addEventListener("click", go);
            input.addEventListener("keydown", (event) => event.key === "Enter" && go());
            acts.append(input, send);
          }
        } else {
          acts.appendChild(element("span", "chip", entry.state === "answered" ? `answered${entry.answer ? `: ${String(entry.answer).slice(0, 30)}` : ""}` : entry.state));
        }
        if (entry.sessionId) {
          let open = element("button", "action", "Open");
          open.addEventListener("click", () => {
            answer(entry, "open");
            shut();
          });
          acts.appendChild(open);
        }
        row.appendChild(acts);
        list.appendChild(row);
      }
      list.scrollTop = scroll;
    };
    let refresh = async () => {
      entries = (await call("inbox", "list").catch(() => null)) ?? entries;
      render();
    };
    filter.addEventListener("change", render);
    clear.addEventListener("click", async () => {
      entries = (await call("inbox", "clear").catch(() => null)) ?? entries;
      render();
    });
    let shut = () => {
      backdrop.remove();
      panel.remove();
      inboxWindow = null;
    };
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    inboxWindow = {
      refresh,
      onKey(event) {
        if (event.type === "keydown" && event.code === "Escape" && !popup) {
          shut();
          return true;
        }
        return false;
      },
    };
    refresh();
  }
  ipc.on("powertoys:inbox", () => inboxWindow?.refresh());

  // --- While you were away: what the sessions did since the window lost focus -----------------------
  let awayWindow = null;
  let awaySince = null;
  function noteAway() {
    if (awaySince === null) {
      awaySince = Date.now();
    }
  }
  async function noteBack() {
    let since = awaySince;
    awaySince = null;
    let minutes = Number(settings?.awaySummaryMinutes) || 0;
    if (since === null || minutes <= 0 || Date.now() - since < minutes * 60000 || awayWindow) {
      return;
    }
    if (document.hasFocus()) {
      await showSessionSummary(since, `While you were away (${ago(Date.now() - since)})`, false);
    }
  }
  /** What each session did since `since`; `always` shows the panel even when nothing happened. */
  async function showSessionSummary(since, heading, always) {
    if (awayWindow) {
      return;
    }
    let sessions = await call("awaySummary", since).catch(() => []);
    if (!sessions.length && !always) {
      return;
    }
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel history away");
    let head = element("div", "head");
    head.appendChild(element("span", "", heading));
    let close = element("button", "iconbtn", "✕");
    head.append(element("span"), close);
    head.lastChild.previousSibling.style.flex = "1";
    let list = element("div", "list");
    if (sessions.length === 0) {
      list.appendChild(element("div", "empty", "No session on this computer did anything in that time"));
    }
    for (let session of sessions) {
      let row = element("div", "row");
      let wrap = element("span", "two");
      let line = element("span", "", `${session.state === "needsYou" ? "❗ " : session.state ? "• " : ""}${session.title}`);
      line.style.fontWeight = "600";
      let facts = [
        session.state === "needsYou" ? "waiting for you" : session.state === "newReply" ? "new reply" : "",
        session.prompts ? `${session.prompts} prompt${session.prompts === 1 ? "" : "s"}` : "",
        session.tools ? `${session.tools} tool call${session.tools === 1 ? "" : "s"}` : "",
        session.edited.length ? `edited ${session.edited.map((path) => path.split(/[\\/]/).pop()).join(", ")}` : "",
      ].filter(Boolean);
      wrap.append(line, element("span", "dim", facts.join("  ·  ")));
      if (session.lastAnswer) {
        let last = element("span", "dim", oneLine(session.lastAnswer).slice(0, 220));
        last.style.whiteSpace = "normal";
        wrap.appendChild(last);
      }
      row.appendChild(wrap);
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        shut();
        openSessionNow(session.sessionId);
      });
      list.appendChild(row);
    }
    panel.append(head, list);
    panel.style.inset = "12vh 22vw auto";
    panel.style.maxHeight = "70vh";
    ui().append(backdrop, panel);
    let shut = () => {
      backdrop.remove();
      panel.remove();
      awayWindow = null;
    };
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    awayWindow = {
      onKey(event) {
        if (event.type === "keydown" && event.code === "Escape" && !popup) {
          shut();
          return true;
        }
        return false;
      },
    };
  }
  addEventListener("blur", noteAway);
  addEventListener("focus", () => noteBack().catch((caught) => log(`away summary failed: ${caught.message}`)));
  document.addEventListener("visibilitychange", () => (document.hidden ? noteAway() : document.hasFocus() && noteBack().catch(() => undefined)));

  // --- Workspaces --------------------------------------------------------------------------------------
  function saveWorkspace() {
    askLine({
      title: "Save the open tabs and splits as a workspace",
      placeholder: "Workspace name, then Enter",
      onEnter(name) {
        if (!name) {
          return false;
        }
        call("workspaces", "save", name).then(
          () => flash(`Saved workspace “${name}”`),
          (caught) => flash(caught.message),
        );
        return true;
      },
    });
  }
  /** A one-line text box in a panel; Enter hands its trimmed text to onEnter (true closes the panel). */
  function askLine({ title, placeholder, value = "", onEnter }) {
    closePopup();
    let panel = element("div", "panel");
    panel.style.width = "420px";
    panel.appendChild(element("div", "title", title));
    let input = element("input", "search");
    input.placeholder = placeholder;
    input.value = value;
    panel.appendChild(input);
    openPopup(panel, {
      onKey(event) {
        if (event.type !== "keydown") {
          return false;
        }
        if (event.code === "Escape") {
          closePopup();
          return true;
        }
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          if (onEnter(input.value.trim()) !== false) {
            closePopup();
          }
          return true;
        }
        return false;
      },
    });
    placeCentred(0.2)(panel);
    let release = holdFocus(input, () => popup?.node === panel);
    popup.onClose = release;
  }

  // --- Session notes: one line per session, on its tab, in its preview and in Ctrl+Tab -----------------
  function editNote(sessionId, title) {
    askLine({
      title: `Note for “${title || "this session"}” (empty removes it)`,
      placeholder: "One line, then Enter",
      value: sessionNotes[sessionId] ?? "",
      onEnter(text) {
        call("setNote", sessionId, text).catch((caught) => flash(caught.message));
        return true;
      },
    });
  }

  // --- Token use and estimated cost per project and session ---------------------------------------------
  const money = (cost) => (cost >= 100 ? `$${Math.round(cost)}` : `$${cost.toFixed(2)}`);
  const tokenCount = (count) => (count >= 1e9 ? `${(count / 1e9).toFixed(1)}B` : count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${Math.round(count / 1e3)}k` : String(count));
  /** Projects by estimated cost over `days`; picking one lists its sessions, picking a session opens it. */
  async function showUsageReport(days = 7, project = null) {
    let report = await call("usageReport", days).catch((caught) => {
      flash(caught.message);
      return null;
    });
    if (!report) {
      return;
    }
    let period = `last ${report.days} days, today included; cost estimated from model prices`;
    if (!project) {
      let other = report.days === 7 ? 30 : 7;
      listPopup({
        title: `Token use by project (${period})`,
        items: [
          ...report.projects.map((each) => ({
            value: each,
            label: each.name,
            detail: `${money(each.cost)} · today ${money(each.todayCost)} · ${tokenCount(each.tokens)} tokens, ${tokenCount(each.output)} out · ${each.sessions} session${each.sessions === 1 ? "" : "s"}`,
          })),
          { value: "period", label: `Last ${other} days instead…` },
        ],
        place: placeCentred(0.15),
        width: 680,
        onPick: (picked) => (picked === "period" ? showUsageReport(other) : showUsageReport(report.days, picked)),
      });
      return;
    }
    let sessions = report.sessions.filter((session) => session.folder.toLowerCase() === project.folder.toLowerCase());
    listPopup({
      title: `${project.name}: sessions by cost (${period})`,
      items: sessions.map((session) => ({ value: session, label: session.title, detail: `${money(session.cost)} · today ${money(session.todayCost)} · ${tokenCount(session.tokens)} tokens, ${tokenCount(session.output)} out` })),
      place: placeCentred(0.15),
      width: 680,
      emptyText: "No session of this project used tokens in this period",
      onPick: (session) => openSessionNow(session.sessionId),
    });
  }

  // --- Command palette (Ctrl+Shift+P) -----------------------------------------------------------------
  async function paletteCommands() {
    let pane = activePane();
    let sessionId = paneSessionId(pane);
    let workspaces = await call("workspaces", "list").catch(() => []);
    let commands = [
      ["Powertoys settings", openSettings],
      ["Notification inbox", openInbox],
      ["What the sessions did in the last hour", () => showSessionSummary(Date.now() - 3600000, "The last hour", true)],
      ["What the sessions did today", () => showSessionSummary(new Date().setHours(0, 0, 0, 0), "Today", true)],
      ["History of every message", openHistory, "Ctrl+H"],
      ["Search all sessions", openSearch, "Ctrl+Shift+S"],
      ["Bookmarks", openBookmarkManager],
      ["Archived sessions", openArchived],
      ["Snippets", showSnippets, "Ctrl+Shift+Space"],
      ["Quick send to a session", () => call("quickSend")],
      ["Token use and cost by project (last 7 days)", () => showUsageReport(7)],
      ["Topic: this conversation's ticket, progress and PR", () => {
        let sessionId = paneSessionId(activePane());
        openTopic(sessionId, tabRows.find((row) => row.kind === "code" && row.id === sessionId)?.title);
      }],
      ["Context map: what fills this session's context, and how it grew", () => {
        let sessionId = paneSessionId(activePane());
        openContextMap(sessionId, tabRows.find((row) => row.kind === "code" && row.id === sessionId)?.title);
      }],
      ["Queued prompts for this session", () => {
        let sessionId = paneSessionId(activePane());
        sessionId ? showPromptQueue(sessionId, tabRows.find((row) => row.kind === "code" && row.id === sessionId)?.title) : flash("No session here");
      }],
      ["Start a session from a Notion ticket", startFromTicket],
      ["Review comments to answer on your sessions' PRs", showReviewThreads],
      ["Send one prompt to several sessions", broadcastPrompt],
      ["Go to the session that has waited longest for you", goToMostUrgent, "Ctrl+Shift+U"],
      ["Today's timeline: when each session worked and waited", showTimeline],
      ["Worktrees: PR state, changes, last use", showWorktrees],
      ["Reopen closed tab", reopenClosedTab, "Ctrl+Shift+T"],
      ["Save tabs and splits as a workspace", saveWorkspace],
      ...workspaces.map((workspace) => [`Workspace: open “${workspace.name}”`, () => call("workspaces", "restore", workspace.name).catch((caught) => flash(caught.message))]),
      ...workspaces.map((workspace) => [`Workspace: delete “${workspace.name}”`, () => call("workspaces", "delete", workspace.name).then(() => flash(`Deleted “${workspace.name}”`))]),
      ["Rebuild and restart Claude", () => call("settingsAction", "rebuildRestart").catch((caught) => flash(caught.message))],
    ];
    if (sessionId) {
      commands.push(
        ["This conversation: rebuild Claude, restart and continue here", () => restartAndContinue(sessionId)],
        [sessionNotes[sessionId] ? "This conversation: edit its note" : "This conversation: add a note", () => editNote(sessionId, tabRows.find((row) => row.id === sessionId)?.title)],
        ["This conversation: fix CI", () => fixCi(sessionId)],
        ...(compactOffered() ? [["This conversation: compact now", () => compactNow(sessionId)]] : []),
        ["This project: instructions for new sessions", () => editProjectInstructions(tabRows.find((row) => row.kind === "code" && row.id === sessionId))],
        ["This conversation: export as Markdown", () => exportConversation(pane, "markdown")],
        ["This conversation: export as HTML", () => exportConversation(pane, "html")],
        ["This conversation: export as PDF", () => exportConversation(pane, "pdf")],
        ["This conversation: open edited files in IntelliJ", () => openEditedInIdea(sessionId)],
        [isMuted(sessionId) ? "This conversation: unmute notifications" : "This conversation: mute notifications", () => call("muteSession", sessionId, !isMuted(sessionId))],
      );
    }
    for (let section of settingsSections) {
      for (let item of section.items.filter((item) => item.type === "switch")) {
        commands.push([`${settings[item.key] ? "Turn off" : "Turn on"}: ${item.label}`, () => call("setSetting", item.key, !settings[item.key])]);
      }
    }
    for (let row of tabRows.filter((row) => row.title)) {
      commands.push([`Go to: ${row.title}`, () => openConversation(row)]);
    }
    for (let { key, name } of sidebarProjectLabels()) {
      commands.push([`Project color: ${name}`, () => {
        let rect = document.querySelector('[data-sidebar-group-label]')?.getBoundingClientRect();
        contextMenu(projectColorMenu({ key, name }), innerWidth / 2 - 110, (rect?.top ?? 120) + 40);
      }]);
    }
    return commands.map(([label, run, key]) => ({ label, run, key }));
  }
  async function openPalette(initial = "") {
    closePopup();
    let commands = await paletteCommands();
    let panel = element("div", "panel palette");
    panel.style.width = `${Math.min(640, innerWidth - 32)}px`;
    let input = element("input", "search");
    input.placeholder = "Type a command";
    input.value = initial;
    let list = element("div", "list");
    panel.append(input, list);
    let shown = [];
    let selected = 0;
    let draw = () => {
      [...list.children].forEach((row, index) => {
        row.classList.toggle("sel", index === selected);
        index === selected && row.scrollIntoView({ block: "nearest" });
      });
    };
    let render = () => {
      let terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = commands.filter((command) => terms.every((term) => command.label.toLowerCase().includes(term))).slice(0, 80);
      selected = Math.min(selected, Math.max(0, shown.length - 1));
      list.textContent = "";
      if (shown.length === 0) {
        list.appendChild(element("div", "empty", "No matching command"));
      }
      shown.forEach((command, index) => {
        let row = element("div", "row");
        row.appendChild(highlighted(command.label, terms));
        if (command.key) {
          row.appendChild(element("span", "key", command.key));
        }
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          run(index);
        });
        list.appendChild(row);
      });
      draw();
    };
    let run = (index) => {
      let command = shown[index];
      closePopup();
      if (command) {
        Promise.resolve()
          .then(() => command.run())
          .catch((caught) => flash(caught.message));
      }
    };
    input.addEventListener("input", () => {
      selected = 0;
      render();
    });
    openPopup(panel, {
      onKey(event) {
        if (event.type !== "keydown") {
          return false;
        }
        if (event.code === "Escape") {
          closePopup();
          return true;
        }
        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
          if (shown.length) {
            selected = (selected + (event.code === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
            draw();
          }
          return true;
        }
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          run(selected);
          return true;
        }
        return false;
      },
    });
    placeCentred(0.12)(panel);
    render();
    let release = holdFocus(input, () => popup?.node === panel);
    popup.onClose = release;
  }

  // Windows that take keys while open, besides those named in the key handlers.
  const keyWindows = new Set();

  // --- Look: declutter, appearance -----------------------------------------------------------------
  // CSS for each switch, kept in one inserted sheet that is replaced when the settings change.
  let lookCss = null;
  let lookCssText = "";
  function cssString(text) {
    return JSON.stringify(String(text));
  }
  /** The page's "How is Claude doing this session?" bar (Bad / Fine / Good), found by its text: hidden, never answered. */
  function hideSurveyBars() {
    if (!settings?.hideSurvey) {
      return;
    }
    for (let good of document.querySelectorAll("button")) {
      if (good.textContent.trim() !== "Good" || good.closest("[data-pt-survey]")) {
        continue;
      }
      let bar = good.parentElement;
      while (bar && bar !== document.body && !bar.textContent.includes("How is Claude doing")) {
        bar = bar.parentElement;
      }
      if (bar && bar !== document.body && bar.textContent.length < 300) {
        bar.setAttribute("data-pt-survey", "");
        bar.style.setProperty("display", "none", "important");
        log("survey: hid the rating bar");
      }
    }
  }
  function applyLook() {
    document.documentElement.dataset.ptCopyPathBackslashes = settings.copyPathBackslashes === false ? "0" : "1";
    let rules = [];
    if (settings.hideSurvey) {
      rules.push('.epitaxy-hint-fade-in:has([aria-label="Rate this session"], [aria-label="Feedback follow-up"]) { display: none !important; }');
    }
    if (settings.hidePromptSuggestions) {
      rules.push("[data-prompt-suggestion-ghost] { display: none !important; }");
    }
    if (settings.hideNextStepBox) {
      rules.push("[data-turn-next] { display: none !important; }");
      rules.push(".rounded-card:has(> [data-turn-next]):not(:has(li)) { display: none !important; }");
    }
    if (settings.hideCreatePr) {
      rules.push('[data-cds="SplitDropdownButton"]:has(button[aria-label="More PR options"]), [data-cds="SplitDropdownButton"]:is([aria-label="Create PR"], [aria-label="Create draft PR"], [aria-label="Manually create PR"]) { display: none !important; }');
    }
    if (settings.hideThinking) {
      rules.push("[data-powertoys-thinking] { display: none !important; }");
    }
    let size = Number(settings.conversationFontSize) || 0;
    if (size > 0) {
      rules.push(`[data-cds="AssistantMessage"], [data-cds="UserMessage"] { --cds-font-size-prose: ${size}px; --cds-leading-prose: ${Math.round(size * 1.55)}px; --cds-font-size-body: ${size}px; --cds-leading-body: ${Math.round(size * 1.5)}px; }`);
      rules.push(`.epitaxy-prompt { --prompt-text-size: ${size}px; }`);
    }
    let font = String(settings.conversationFont ?? "").trim();
    if (font) {
      let family = `${cssString(font)}, sans-serif`;
      rules.push(`[data-cds="Prose"] { --_prose-face-sans: ${family}; --_prose-face-serif: ${cssString(font)}, serif; }`);
      rules.push(`.epitaxy-transcript-typography { --font-user-message: ${family}; --font-claude-response: ${family}; }`);
      rules.push(`[data-testid="code-prompt-input"], [data-composer-placeholder], [data-cds="UserMessage"] { font-family: ${family} !important; }`);
    }
    if (settings.fullWidth) {
      rules.push("[data-epitaxy-chat-column], [data-transcript-column-row] { --chat-column-measure: 100000px !important; }");
    }
    let text = rules.join("\n");
    if (text === lookCssText) {
      return;
    }
    lookCssText = text;
    if (lookCss) {
      electron.webFrame.removeInsertedCSS(lookCss);
      lookCss = null;
    }
    if (text) {
      lookCss = electron.webFrame.insertCSS(text, { cssOrigin: "author" });
    }
  }
  /** Marks the thinking rows ("Thought for 12s", "Thinking…"), which have no attribute of their own. */
  function markThinking() {
    if (!settings.hideThinking) {
      return;
    }
    for (let step of document.querySelectorAll('[data-cds="TurnStatusStep"]:not([data-powertoys-thinking-checked])')) {
      step.setAttribute("data-powertoys-thinking-checked", "");
      let label = step.querySelector("bdi")?.textContent.trim() ?? "";
      if (/^(Thought for|Thinking)/.test(label)) {
        step.setAttribute("data-powertoys-thinking", "");
      }
    }
  }

  // --- Finished turns and diffs ----------------------------------------------------------------------
  // A pane is working while its Stop button shows; when that goes, the turn's open tool groups are
  // closed (only then, so groups opened later by hand stay open). Edit / Write steps are opened as
  // they appear, once each.
  let paneWorking = new WeakMap();
  let expandedSteps = new Set();
  function followTurns() {
    for (let pane of panes()) {
      let working = !!pane.root.querySelector('[data-testid="code-prompt-stop"]');
      let was = paneWorking.get(pane.transcript);
      paneWorking.set(pane.transcript, working);
      if (settings.collapseFinishedTurns && was === true && !working) {
        setTimeout(() => {
          for (let toggle of pane.transcript.querySelectorAll('[data-cds="TurnStatus"][data-open] > [data-cds-row] [data-cds-row-toggle][aria-expanded="true"]')) {
            toggle.click();
          }
        }, 600);
      }
      if (settings.expandDiffs) {
        for (let group of pane.transcript.querySelectorAll('[data-cds="TurnStatus"]')) {
          let key = group.getAttribute("data-item-key");
          let summary = group.querySelector(":scope > [data-cds-row] bdi")?.textContent ?? "";
          if (!key || expandedSteps.has(key) || !/(edited|created|updated|wrote)/i.test(summary)) {
            continue;
          }
          expandedSteps.add(key);
          let groupToggle = group.querySelector(':scope > [data-cds-row] [data-cds-row-toggle][aria-expanded="false"]');
          groupToggle?.click();
          setTimeout(() => {
            for (let step of group.querySelectorAll('[data-cds="TurnStatusStep"]')) {
              let label = step.querySelector("bdi")?.textContent.trim() ?? "";
              if (/^(Edited|Created|Updated) /.test(label)) {
                step.querySelector('[data-cds-row-toggle][aria-expanded="false"]')?.click();
              }
            }
          }, 250);
        }
      }
    }
  }

  // --- Status in the prompt box's row ------------------------------------------------------------------
  // The row under each prompt box (the app's: permission mode … model, usage ring) gets this pane's
  // session folder, branch, context size, how long Claude has been working, and the plan's 5-hour and
  // weekly usage, between the mode on the left and the model on the right. Mode and model are the
  // app's own, so they aren't repeated.
  const statusCache = new Map(); // sessionId -> { at, info }
  const STATUS_STYLE = "display:flex;align-items:center;gap:12px;min-width:0;flex:1 1 auto;overflow:hidden;white-space:nowrap;" +
    "margin:0 12px;font-size:12px;color:hsl(var(--text-400, 48 5% 57%));";
  function chinRow(pane) {
    return pane.root.querySelector('[data-cds="ChatComposerChin"] [data-size="xs"]');
  }
  function meterNode(percent) {
    let wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-block;width:30px;height:5px;border-radius:3px;overflow:hidden;background:hsl(var(--bg-400, 0 0% 4%));flex:none;";
    let fill = document.createElement("i");
    let color = percent >= 90 ? "--danger-100, 0 72% 65%" : percent >= 70 ? "--brand-100, 15 63% 60%" : "--accent-100, 212 75% 62%";
    fill.style.cssText = `display:block;height:100%;width:${Math.max(0, Math.min(100, percent))}%;background:hsl(var(${color}));`;
    wrap.appendChild(fill);
    return wrap;
  }
  function untilText(iso) {
    let at = Date.parse(iso ?? "");
    if (!Number.isFinite(at)) {
      return "";
    }
    let minutes = Math.max(0, Math.round((at - Date.now()) / 60000));
    return minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
  }
  /**
   * One pane's status row. `show` says which parts it carries: side by side, what is the same for every
   * pane (the plan's usage, the profile, a folder and branch they share) is shown once, in the last
   * pane's row (marked "same for all panes"), and each row keeps only what is its own.
   */
  function statusContent(info, show = { profile: true, folder: true, plan: true, shared: false }) {
    let parts = [];
    let sharedNote = show.shared ? " (same for all panes side by side)" : "";
    let part = (children, title, strong) => {
      let node = document.createElement("span");
      node.style.cssText = `display:inline-flex;align-items:center;gap:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;${strong ? "color:hsl(var(--text-300, 55 9% 74%));" : ""}`;
      node.append(...children);
      if (title) {
        node.title = title;
      }
      parts.push(node);
    };
    let topic = info.sessionId ? topicParts(info.sessionId) : [];
    if (topic.length) {
      part([topic.join(" · ")], "This conversation's topic: its ticket, progress and PR (click for all of it)", true);
      let node = parts.at(-1);
      node.style.cursor = "pointer";
      node.addEventListener("click", () => openTopic(info.sessionId, tabRows.find((row) => row.kind === "code" && row.id === info.sessionId)?.title));
    }
    if (info.profile && show.profile) {
      part([`👤 ${info.profile}`], `Profile${sharedNote}`, true);
    }
    if (info.local && show.folder) {
      part([`📁 ${info.folderName}`], `${info.folder}${show.sharedFolder ? sharedNote : ""}`, true);
      if (info.branch || info.worktree) {
        part([`⎇ ${info.branch || ""}${info.worktree ? ` (worktree ${info.worktree})` : ""}`], `Branch${show.sharedFolder ? sharedNote : ""}`);
      }
    }
    if (info.local) {
      if (info.contextTokens) {
        part([`${Math.round(info.contextTokens / 1000)}k context`], "Context at the last response: click for what fills it and how it grew");
        let node = parts.at(-1);
        node.style.cursor = "pointer";
        node.addEventListener("click", () => openContextMap(info.sessionId, tabRows.find((row) => row.kind === "code" && row.id === info.sessionId)?.title));
      }
      if (info.turnAge) {
        part([`working ${info.turnAge}`], "This turn so far", true);
      }
    }
    let run = info.sessionId ? scheduledRuns[info.sessionId] : null;
    if (run && run.at > Date.now()) {
      let node = document.createElement("span");
      node.dataset.ptAt = String(run.at);
      node.textContent = `⏰ ${countdown(run.at)}`;
      part([node], `Next run at ${new Date(run.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${run.label}`, true);
    }
    let spacer = document.createElement("span");
    spacer.style.cssText = "flex:1 1 auto;";
    parts.push(spacer);
    for (let [key, label, name] of [
      ["fiveHour", "5 h", "5-hour"],
      ["sevenDay", "week", "Weekly"],
    ]) {
      let window2 = show.plan ? info.plan?.[key] : null;
      if (window2) {
        part([label, meterNode(window2.percent), `${Math.round(window2.percent)}%`], `${name} limit, resets in ${untilText(window2.resetsAt)}${sharedNote}`);
      }
    }
    return parts;
  }
  async function statusFor(sessionId) {
    let cached = statusCache.get(sessionId ?? "");
    if (cached && Date.now() - cached.at < 5000) {
      return cached.info;
    }
    let info = await call("statusInfo", sessionId).catch(() => null);
    if (info) {
      info.sessionId = sessionId;
    }
    statusCache.set(sessionId ?? "", { at: Date.now(), info });
    return info;
  }
  let statusBusy = false;
  async function updateStatusBar() {
    if (!settings.statusBar) {
      document.querySelectorAll("[data-powertoys-status]").forEach((node) => node.remove());
      return;
    }
    if (statusBusy) {
      return;
    }
    statusBusy = true;
    try {
      let entries = [];
      for (let pane of panes()) {
        let row = chinRow(pane);
        let info = row ? await statusFor(paneSessionId(pane)) : null;
        if (info) {
          entries.push({ row, info });
        }
      }
      let sideBySide = entries.length > 1;
      let same = (key) => entries.every((entry) => (entry.info.local ? entry.info[key] : null) === (entries[0].info.local ? entries[0].info[key] : null));
      let sharedFolder = sideBySide && entries.every((entry) => entry.info.local) && same("folder") && same("branch") && same("worktree");
      for (let [index, { row, info }] of entries.entries()) {
        let last = index === entries.length - 1;
        let show = sideBySide
          ? { profile: last, plan: last, folder: sharedFolder ? last : true, sharedFolder: sharedFolder && last, shared: last }
          : { profile: true, folder: true, plan: true, shared: false };
        let node = row.querySelector(":scope > [data-powertoys-status]");
        if (!node) {
          node = document.createElement("div");
          node.setAttribute("data-powertoys-status", "");
          node.style.cssText = STATUS_STYLE;
          // After the permission mode (the row's first item), before the model on the right.
          row.firstElementChild ? row.firstElementChild.after(node) : row.appendChild(node);
        }
        let signature = JSON.stringify([info, show, info.sessionId ? topicParts(info.sessionId) : []]);
        if (node.dataset.signature !== signature) {
          node.dataset.signature = signature;
          node.replaceChildren(...statusContent(info, show));
        }
      }
    } finally {
      statusBusy = false;
    }
  }

  // --- Right-to-left text ------------------------------------------------------------------------
  // Each paragraph, list, heading and quote in a message takes its direction from its own first
  // letters (dir="auto"), so Arabic or Hebrew lines run right to left with lists and alignment to
  // match, while code stays left to right. The prompt box can't take attributes (its editor owns
  // its DOM), so there each paragraph is laid out by its own text (unicode-bidi: plaintext).
  let rtlCss = null;
  function applyRtl() {
    let want = !!settings?.rtlAuto;
    if (want && !rtlCss) {
      rtlCss = electron.webFrame.insertCSS(
        ".ProseMirror p, .ProseMirror li { unicode-bidi: plaintext; text-align: start; }",
        { cssOrigin: "author" },
      );
    } else if (!want && rtlCss) {
      electron.webFrame.removeInsertedCSS(rtlCss);
      rtlCss = null;
      document.querySelectorAll("[data-powertoys-dir]").forEach((node) => {
        node.removeAttribute("dir");
        node.removeAttribute("data-powertoys-dir");
      });
    }
    if (!want) {
      return;
    }
    for (let node of document.querySelectorAll(
      "[data-epitaxy-entry] :is(p, li, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, td, th):not([dir]), [data-testid=user-message] :is(p, div):not([dir]):not([data-powertoys-nodir])",
    )) {
      if (node.closest("pre, code, .ProseMirror")) {
        continue;
      }
      // A user message's text sits in a plain div; layout divs (no text of their own) keep their direction.
      if (node.tagName === "DIV" && ![...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim() !== "")) {
        node.setAttribute("data-powertoys-nodir", "");
        continue;
      }
      node.setAttribute("dir", "auto");
      node.setAttribute("data-powertoys-dir", "");
    }
  }

  // --- History (Ctrl+H) -------------------------------------------------------------------------
  // Like a browser's history page: every prompt sent and every reply received, in every conversation
  // with a transcript on this computer, newest first and grouped by day. A week is loaded at a time
  // as the list scrolls; with a search, a year at a time. Rows of conversations the app doesn't list
  // (terminal Claude Code sessions) are shown but can only be copied.
  let historyWindow = null;
  const HISTORY_YOU_ICON =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="5.2" r="2.7"/><path d="M2.8 14c.6-2.9 2.7-4.6 5.2-4.6s4.6 1.7 5.2 4.6"/></svg>';
  // Claude's spark: rays of different lengths around the centre.
  const HISTORY_CLAUDE_ICON =
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
    [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
      .map((angle, index) => `<rect x="7.3" y="${index % 2 ? 2.4 : 0.8}" width="1.4" height="${index % 2 ? 5.6 : 7.2}" rx=".7" transform="rotate(${angle} 8 8)"/>`)
      .join("") +
    "</svg>";
  function openHistory() {
    closePopup();
    if (historyWindow) {
      historyWindow.focus();
      return;
    }
    let backdrop = element("div", "backdrop");
    let panel = element("div", "panel history");
    let head = element("div", "head");
    head.appendChild(element("span", "", "History"));
    let search = element("input");
    search.placeholder = "Search history";
    head.appendChild(search);
    let close = element("button", "iconbtn", "✕");
    head.appendChild(close);
    let list = element("div", "list");
    panel.append(head, list);
    ui().append(backdrop, panel);
    let state = { query: "", before: undefined, loading: false, exhausted: false, generation: 0, lastDay: "", rows: [], entries: [], selected: -1 };
    let releaseFocus = () => {};
    let shut = () => {
      releaseFocus();
      backdrop.remove();
      panel.remove();
      historyWindow = null;
    };
    let dayLabel = (at) => {
      let date = new Date(at);
      let today = new Date();
      let yesterday = new Date(Date.now() - 86400000);
      let long = date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      return date.toDateString() === today.toDateString() ? `Today – ${long}` : date.toDateString() === yesterday.toDateString() ? `Yesterday – ${long}` : long;
    };
    let terms = () => state.query.toLowerCase().split(/\s+/).filter(Boolean);
    let openEntry = async (entry) => {
      if (!entry.sessionId) {
        // A terminal Claude Code session: the app imports it (its own resume) and opens it.
        if (!entry.cliSessionId) {
          return;
        }
        let result = await call("openCliSession", entry.cliSessionId).catch((caught) => ({ ok: false, reason: caught.message }));
        if (!result?.ok || !result.sessionId) {
          let reasons = {
            running: "it is still running in a terminal",
            workspace_untrusted: "its folder isn't trusted yet",
            folder_missing: "its folder no longer exists",
            not_resumable: "the app can't resume it",
          };
          flash(`Can't open this terminal session: ${reasons[result?.reason] ?? result?.reason ?? "unknown reason"}`);
          return;
        }
        shut();
        revealWhenOnScreen(result.sessionId, entry.keys, entry.text);
        return;
      }
      shut();
      openSessionNow(entry.sessionId);
      revealWhenOnScreen(entry.sessionId, entry.keys, entry.text);
    };
    let select = (index) => {
      state.rows[state.selected]?.classList.remove("sel");
      state.selected = Math.max(0, Math.min(state.rows.length - 1, index));
      state.rows[state.selected]?.classList.add("sel");
      state.rows[state.selected]?.scrollIntoView({ block: "nearest" });
    };
    let append = (entries) => {
      for (let entry of entries) {
        let day = dayLabel(entry.at);
        if (day !== state.lastDay) {
          state.lastDay = day;
          list.appendChild(element("div", "day", day));
        }
        let row = element("div", `row${entry.sessionId ? "" : " offline"}`);
        row.title = entry.sessionId ? entry.text : `Terminal session: opening it imports it into Claude.\n\n${entry.text}`;
        let who = element("span", `who ${entry.fromUser ? "you" : "claude"}`);
        who.innerHTML = entry.fromUser ? HISTORY_YOU_ICON : HISTORY_CLAUDE_ICON;
        who.title = entry.fromUser ? "You" : "Claude";
        row.append(element("span", "time", new Date(entry.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })), who);
        let text = element("span", "text");
        text.appendChild(highlighted(oneLine(entry.text).slice(0, 300), terms()));
        row.append(text, element("span", "where", entry.title));
        let index = state.rows.length;
        row.addEventListener("mousedown", (event) => {
          if (event.button === 0) {
            event.preventDefault();
            select(index);
            openEntry(entry);
          }
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          contextMenu(
            [
              { label: entry.sessionId ? "Open" : "Open in Claude (import the terminal session)", onClick: () => openEntry(entry) },
              { label: "Copy text", onClick: () => navigator.clipboard.writeText(entry.text) },
            ],
            event.clientX,
            event.clientY,
          );
        });
        state.rows.push(row);
        state.entries.push(entry);
        list.appendChild(row);
      }
    };
    let loadMore = async () => {
      if (state.loading || state.exhausted) {
        return;
      }
      state.loading = true;
      let mine = state.generation;
      let status = element("div", "empty", "Loading…");
      list.appendChild(status);
      try {
        // Empty weeks are skipped without stopping the scroll.
        for (let pages = 0; pages < 12 && mine === state.generation; pages++) {
          let page = await call("timeline", state.before, state.query);
          if (mine !== state.generation) {
            return;
          }
          state.before = page.nextBefore;
          state.exhausted = page.exhausted;
          append(page.entries);
          if (page.entries.length || page.exhausted) {
            break;
          }
        }
      } catch (caught) {
        log(`history failed: ${caught.message}`);
      } finally {
        status.remove();
        if (mine === state.generation) {
          state.loading = false;
          if (state.rows.length === 0 && state.exhausted) {
            list.appendChild(element("div", "empty", state.query ? "Nothing matches" : "No history yet"));
          } else if (list.scrollHeight <= list.clientHeight + 40) {
            loadMore();
          }
        }
      }
    };
    let restart = () => {
      state.generation++;
      Object.assign(state, { before: undefined, loading: false, exhausted: false, lastDay: "", rows: [], entries: [], selected: -1 });
      list.textContent = "";
      loadMore();
    };
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.query = search.value.trim();
        restart();
      }, 250);
    });
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight > list.scrollHeight - 300) {
        loadMore();
      }
    });
    close.addEventListener("click", shut);
    backdrop.addEventListener("mousedown", shut);
    historyWindow = {
      focus: () => search.focus(),
      onKey(event) {
        if (event.type !== "keydown" || popup) {
          return false;
        }
        if (event.code === "Escape") {
          shut();
          return true;
        }
        if (event.code === "ArrowDown" || event.code === "ArrowUp") {
          select(state.selected + (event.code === "ArrowDown" ? 1 : -1));
          return true;
        }
        if ((event.code === "Enter" || event.code === "NumpadEnter") && state.selected >= 0) {
          openEntry(state.entries[state.selected]);
          return true;
        }
        return false;
      },
    };
    restart();
    releaseFocus = holdFocus(search, () => historyWindow !== null && !popup);
  }

  // --- Tabs for pinned and active conversations ----------------------------------------------------
  // In the free part of the top bar, between the session title and the title-bar buttons: pinned
  // conversations first, then the active ones (on screen, running or waiting for you). The rows come
  // from the page's own sidebar lists, so they follow its pins, titles and live states.
  let tabRows = [];
  let draggedTab = null; // { kind, id, group } while a tab is dragged
  let tabRowsAt = 0;
  let tabsNode = null;
  let tabsKey = "";
  let tabsScrolledFor = null; // the tab last scrolled into view in the strip
  let splitTabs = null; // side by side: { anchorId, sides } (see layoutTabs)
  const ROUTES = { code: (id) => `/epitaxy/${encodeURIComponent(id)}`, chat: (id) => `/chat/${id}`, project: (id) => `/project/${id}`, "epitaxy-project": (id) => `/epitaxy/project/${id}`, view: (id) => id };
  // Pages that are not a conversation get a tab too while they are on screen ("view" tabs: not stored
  // unless pinned, so visiting Search doesn't leave a tab behind). Their ids are their paths.
  const VIEW_TITLES = [
    [/^\/epitaxy\/?$/, "New session"],
    [/^\/new\/?$/, "New chat"],
    [/^\/epitaxy\/projects\b/, "Projects"],
    [/^\/epitaxy\/scheduled\b/, "Scheduled"],
    [/^\/epitaxy\/search\b/, "Search"],
    [/^\/settings\b/, "Settings"],
    [/^\/projects\/?$/, "Projects"],
    [/^\/recents\b/, "Chats"],
  ];
  // The New session page: its tab stays when you switch away (keepDraftTab), until closed or the draft is sent.
  const DRAFT_VIEW = "view:/epitaxy";
  let previousTabKey = null;
  function viewTitle(path) {
    let known = VIEW_TITLES.find(([pattern]) => pattern.test(path));
    return known ? known[1] : document.title.replace(/\s+[-–]\s+Claude(?: Code)?$/, "") || path;
  }
  function currentConversationKey() {
    // Side by side, the pane being worked in decides (the address follows only the main pane).
    let split = splitState();
    if (split?.focused) {
      return `code:${split.focused}`;
    }
    let path = location.pathname;
    let code = /^\/epitaxy\/([^/]+)$/.exec(path);
    if (code && !["projects", "scheduled", "search"].includes(code[1])) {
      return `code:${decodeURIComponent(code[1])}`;
    }
    let chat = /^\/chat\/([^/]+)/.exec(path);
    if (chat) {
      return `chat:${chat[1]}`;
    }
    let project = /^\/(epitaxy\/)?project\/([^/]+)/.exec(path);
    if (project) {
      return `${project[1] ? "epitaxy-project" : "project"}:${project[2]}`;
    }
    // Settings has a page per section; one tab stands for all of them.
    return `view:${/^\/settings\b/.test(path) ? "/settings" : path.replace(/\/+$/, "") || "/"}`;
  }
  function tabsWanted() {
    let onScreen = new Set(Object.keys(mainWorld("titles", panes()[0]?.transcript ?? document.body) ?? {}).map((id) => `code:${id}`));
    let current = currentConversationKey();
    if (current) {
      onScreen.add(current);
    }
    let key = (row) => `${row.kind}:${row.id}`;
    let byKey = new Map(tabRows.map((row) => [key(row), row]));
    syncOpenTabs(onScreen, current, byKey, key);
    let live = (tab, extra) => ({ ...(byKey.get(key(tab)) ?? { kind: tab.kind, id: tab.id, title: tab.title, updatedAt: 0 }), ...extra });
    let pinned = pinnedTabs.map((tab) => live(tab, { pinnedTab: true, ...(tab.kind === "view" ? { title: viewTitle(tab.id) } : {}) }));
    let open = (openTabs ?? []).map((tab) => live(tab, {}));
    if (settings?.groupTabsByProject) {
      // Each project's tabs together, projects in the order their first tab has (stable within one).
      let order = [...new Set(open.map((row) => row.project?.key ?? ""))];
      open = order.flatMap((projectKey) => open.filter((row) => (row.project?.key ?? "") === projectKey));
    }
    let list = [...pinned, ...open];
    // The page on screen when it is not a conversation: a tab of its own, after the others.
    if (current.startsWith("view:") && !list.some((row) => key(row) === current)) {
      let id = current.slice("view:".length);
      list.push({ kind: "view", id, title: viewTitle(id), updatedAt: 0 });
    }
    return { list, current, key };
  }
  function stateOf(row) {
    if (row.pending || row.liveStatus === "needs_input" || row.liveStatus === "awaiting") {
      return "needsYou";
    }
    if (row.isRunning || row.liveStatus === "running" || row.liveStatus === "working") {
      return "working";
    }
    if (row.hasError || row.liveStatus === "failed" || row.liveStatus === "error") {
      return "error";
    }
    return row.unread ? "done" : "";
  }
  const STATE_GLYPHS = { needsYou: "!", working: "", done: "✓", error: "✕" };
  const STATE_NAMES = { needsYou: "Waiting for you", working: "Working", done: "Finished (unread)", error: "Stopped with an error" };
  // --- Next scheduled run (a /loop wake-up or a recurring loop): a live countdown ------------------
  let scheduledRuns = {};
  function countdown(at) {
    let seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
    if (seconds >= 86400) {
      return new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
    }
    if (seconds >= 3600) {
      return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
    }
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  async function refreshScheduledRuns() {
    let next = await call("scheduledRuns").catch(() => null);
    if (next && JSON.stringify(next) !== JSON.stringify(scheduledRuns)) {
      scheduledRuns = next;
      tabsKey = "";
    }
  }
  /** Updates every countdown on screen (tabs and status rows) once a second. */
  function tickCountdowns() {
    for (let node of [...(tabsNode?.querySelectorAll("[data-at]") ?? []), ...document.querySelectorAll("[data-pt-at]")]) {
      let at = Number(node.dataset.at ?? node.dataset.ptAt);
      node.textContent = `⏰ ${at > Date.now() ? countdown(at) : "now"}`;
    }
  }
  setInterval(tickCountdowns, 1000);
  setInterval(() => refreshScheduledRuns().catch(() => undefined), 15000);
  setTimeout(() => refreshScheduledRuns().catch(() => undefined), 4000);
  // --- Project colors: sidebar project headers and their tabs ------------------------------------------
  const PROJECT_COLORS = [
    ["Red", "#e5534b"],
    ["Orange", "#f0883e"],
    ["Yellow", "#e8c547"],
    ["Lime", "#a3d43f"],
    ["Green", "#3fa85a"],
    ["Teal", "#2bb5a5"],
    ["Sky", "#4fc3f7"],
    ["Blue", "#3f6fe0"],
    ["Violet", "#8a6cf0"],
    ["Purple", "#c060d8"],
    ["Pink", "#f06aa8"],
    ["Rose", "#f4a3b0"],
    ["Brown", "#a8693c"],
    ["Sand", "#d8bf8a"],
    ["Stone", "#8f8a80"],
    ["Slate", "#6f8fb0"],
  ];
  const PALETTE = new Set(PROJECT_COLORS.map(([, color]) => color));
  /** Rough perceived distance between two #rrggbb colors ("redmean"). */
  function colorDistance(left, right) {
    let [r1, g1, b1] = [1, 3, 5].map((at) => parseInt(left.slice(at, at + 2), 16));
    let [r2, g2, b2] = [1, 3, 5].map((at) => parseInt(right.slice(at, at + 2), 16));
    let mean = (r1 + r2) / 2;
    return Math.sqrt((2 + mean / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - mean) / 256) * (b1 - b2) ** 2);
  }
  /** A project's entry in a settings map, also under the key it had with forward slashes. */
  function projectSetting(map, key) {
    if (!map) {
      return undefined;
    }
    if (key in map) {
      return map[key];
    }
    let slashless = (value) => value.replace(/\//g, "\\").replace(/\\+$/, "");
    let found = Object.keys(map).find((other) => slashless(other) === slashless(key));
    return found === undefined ? undefined : map[found];
  }
  function projectColor(key) {
    let chosen = projectSetting(settings?.projectColors, key);
    if (typeof chosen === "string" && /^#[0-9a-f]{6}$/i.test(chosen)) {
      return chosen;
    }
    let assigned = projectSetting(settings?.autoProjectColors, key);
    if (typeof assigned === "string" && /^#[0-9a-f]{6}$/i.test(assigned)) {
      return assigned;
    }
    let hash = 0;
    for (let character of key) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return PROJECT_COLORS[hash % PROJECT_COLORS.length][1];
  }
  /**
   * Gives each project seen without a color a palette color, once, and saves it, so projects keep their color.
   * The color picked is an unused one as far as possible from those in use (the least-used once all are taken).
   * An automatic color shared with another project, or no longer in the palette, is picked again while unused
   * colors remain.
   */
  let assigningColors = false;
  function assignProjectColors(keys) {
    if (assigningColors || !settings?.colorProjects) {
      return;
    }
    // Scratch folders (one per throwaway session) would use up the colors meant for real projects;
    // ones given a color before this rule are dropped.
    let isScratch = (key) => /[\\/]scratch-workspaces[\\/]/.test(key);
    let chosen = settings.projectColors ?? {};
    let saved = settings.autoProjectColors ?? {};
    let assigned = Object.fromEntries(Object.entries(saved).filter(([key]) => !isScratch(key)));
    let pruned = Object.keys(assigned).length !== Object.keys(saved).length;
    let uses = new Map(PROJECT_COLORS.map(([, color]) => [color, 0]));
    for (let color of Object.values(chosen)) {
      if (uses.has(color)) {
        uses.set(color, uses.get(color) + 1);
      }
    }
    let projectCount = new Set([...Object.keys(chosen), ...Object.keys(assigned), ...keys.filter((key) => !isScratch(key))]).size;
    let redo = [];
    for (let key of Object.keys(assigned).sort()) {
      let color = assigned[key];
      if (!PALETTE.has(color) || (uses.get(color) > 0 && projectCount <= PALETTE.size)) {
        redo.push(key);
        delete assigned[key];
      } else {
        uses.set(color, uses.get(color) + 1);
      }
    }
    let missing = [...new Set([...redo, ...keys])].filter((key) => !chosen[key] && !assigned[key] && !isScratch(key)).sort();
    if (missing.length === 0 && !pruned) {
      return;
    }
    for (let key of missing) {
      let fewest = Math.min(...uses.values());
      let inUse = [...uses].filter(([, count]) => count > 0).map(([color]) => color);
      let spread = (color) => Math.min(Infinity, ...inUse.map((other) => colorDistance(color, other)));
      let [color] = [...uses].filter(([, count]) => count === fewest).sort((left, right) => spread(right[0]) - spread(left[0]))[0];
      assigned[key] = color;
      uses.set(color, uses.get(color) + 1);
    }
    assigningColors = true;
    call("setSetting", "autoProjectColors", assigned)
      .catch((caught) => log(`saving project colors failed: ${caught.message}`))
      .finally(() => (assigningColors = false));
  }
  function setProjectColor(key, color) {
    let next = { ...(settings?.projectColors ?? {}) };
    if (color) {
      next[key] = color;
    } else {
      delete next[key];
    }
    return call("setSetting", "projectColors", next).catch((caught) => flash(caught.message));
  }
  // --- Per project: the model and effort new sessions in its folder start with ----------------------
  let knownModels = [];
  function refreshKnownModels() {
    call("knownModels")
      .then((models) => {
        if (Array.isArray(models)) {
          knownModels = models;
        }
      })
      .catch(() => {});
  }
  const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
  function projectDefaultsMenu(project) {
    refreshKnownModels(); // for the next time the menu opens; this one uses what is known now
    let current = projectSetting(settings?.projectDefaults, project.key) ?? {};
    let set = (change) => {
      let entry = { ...current, name: project.name, folder: project.folder || current.folder || "", ...change };
      if (!entry.folder) {
        flash("This project's folder isn't known yet");
        return;
      }
      let next = { ...(settings?.projectDefaults ?? {}) };
      if (entry.model || entry.effort) {
        next[project.key] = entry;
      } else {
        delete next[project.key];
      }
      call("setSetting", "projectDefaults", next)
        .then(() => flash(`New sessions in ${project.name}: ${entry.model || "the app's model"}, ${entry.effort ? `${entry.effort} effort` : "the app's effort"}`))
        .catch((caught) => flash(caught.message));
    };
    let models = [...new Set([...knownModels, ...(current.model ? [current.model] : [])])];
    return [
      { label: "Model: the app's choice", checked: !current.model, onClick: () => set({ model: "" }) },
      ...models.map((model) => ({ label: `Model: ${model}`, checked: current.model === model, onClick: () => set({ model }) })),
      "-",
      { label: "Effort: the app's choice", checked: !current.effort, onClick: () => set({ effort: "" }) },
      ...EFFORT_LEVELS.map((effort) => ({ label: `Effort: ${effort}`, checked: current.effort === effort, onClick: () => set({ effort }) })),
    ];
  }
  function projectColorMenu(project) {
    let chosen = settings?.projectColors?.[project.key];
    return [
      { label: "Automatic", swatch: "", checked: !chosen, onClick: () => setProjectColor(project.key, null) },
      "-",
      ...PROJECT_COLORS.map(([name, color]) => ({ label: name, swatch: color, checked: chosen === color, onClick: () => setProjectColor(project.key, color) })),
    ];
  }
  /** The sidebar's project group headers (not the environment ones) with their project key. */
  function sidebarProjectLabels() {
    return [...document.querySelectorAll('[data-sidebar-group-label][data-kind="group"]')]
      .map((label) => ({ label, rowKey: label.closest("[data-row-key]")?.getAttribute("data-row-key") ?? "" }))
      .filter(({ rowKey }) => rowKey.startsWith("label:project-") && !rowKey.startsWith("label:project-kind::"))
      .map(({ label, rowKey }) => ({ label, key: rowKey.slice("label:project-".length).toLowerCase(), name: label.querySelector("[data-group-name]")?.textContent.trim() ?? "" }));
  }
  function colorSidebarProjects() {
    let labels = sidebarProjectLabels();
    assignProjectColors([...labels.map(({ key }) => key), ...tabRows.map((row) => row.project?.key).filter(Boolean)]);
    for (let { label, key } of labels) {
      let name = label.querySelector("[data-group-name]");
      if (settings?.colorProjects) {
        let color = projectColor(key);
        if (label.dataset.ptColor !== color) {
          label.dataset.ptColor = color;
          label.style.boxShadow = `inset 3px 0 0 ${color}`;
          if (name) {
            name.style.color = color;
          }
        }
      } else if (label.dataset.ptColor) {
        delete label.dataset.ptColor;
        label.style.boxShadow = "";
        if (name) {
          name.style.color = "";
        }
      }
    }
  }
  setInterval(colorSidebarProjects, 1500);

  // --- Sidebar: start with every environment / folder group collapsed --------------------------------
  // The toggle sits in the label's heading (3.6556.1: label > h3 > button; it was the label's child).
  const SIDEBAR_GROUP_TOGGLE = '[data-sidebar-group-label][data-kind="group"] button[data-group-toggle][aria-expanded="true"]';
  function collapseSidebarGroupsAtStart() {
    if (!settings?.collapseSidebarGroupsAtStart) {
      return;
    }
    let started = Date.now();
    let attempt = () => {
      if (!document.querySelector(SIDEBAR_GROUP_TOGGLE)) {
        if (Date.now() - started < 60000) {
          setTimeout(attempt, 1000);
        } else {
          // The sidebar's markup changed (a new release): say what its toggles look like now.
          let describe = (node) =>
            node
              ? `<${node.tagName.toLowerCase()} ${[...node.attributes].filter((attribute) => /^(data-|aria-expanded|role)/.test(attribute.name)).map((attribute) => `${attribute.name}="${attribute.value.slice(0, 30)}"`).join(" ")}>`
              : "none";
          let toggles = [...document.querySelectorAll("[data-group-toggle], [data-sidebar-group-label]")].slice(0, 12);
          log(`no sidebar group to collapse after 60 s; ${toggles.length} candidate(s):`);
          toggles.forEach((node) => log(`  ${describe(node)} in ${describe(node.parentElement)} '${node.textContent.trim().slice(0, 30)}'`));
        }
        return;
      }
      // The groups render over a moment; collapse once they have settled. Innermost first (a folder comes
      // after its environment in the page), so every level is collapsed when it is opened again.
      setTimeout(() => {
        let toggles = [...document.querySelectorAll(SIDEBAR_GROUP_TOGGLE)].reverse();
        toggles.forEach((toggle) => toggle.click());
        log(`collapsed ${toggles.length} sidebar group(s) at start`);
      }, 2000);
    };
    attempt();
  }
  function isMuted(sessionId) {
    return Array.isArray(settings?.mutedSessions) && settings.mutedSessions.includes(sessionId);
  }
  let tabsLayoutCss = null;
  function applyTabsLayoutCss() {
    let want = !!settings?.topTabs;
    if (want && !tabsLayoutCss) {
      tabsLayoutCss = electron.webFrame.insertCSS(
        // The title group and the end buttons are siblings somewhere inside the bar (the page has nested
        // them deeper over time); the title goes right, beside the buttons, and a long one is cut with "…".
        '.epitaxy-titlebar [class*="group/lead"] { margin-inline-start: auto !important; max-width: 38%; overflow: hidden; } .epitaxy-titlebar .epitaxy-titlebar-end { margin-inline-start: 0 !important; }',
        { cssOrigin: "author" },
      );
    } else if (!want && tabsLayoutCss) {
      electron.webFrame.removeInsertedCSS(tabsLayoutCss);
      tabsLayoutCss = null;
    }
  }
  function layoutTabs() {
    // While a tab is dragged the strip stays as it is: redrawing it (a state dot changing) would remove
    // the dragged tab and end the drag before it reaches the drop zone.
    if (draggedTab) {
      return;
    }
    applyTabsLayoutCss();
    if (!settings?.topTabs) {
      tabsNode?.remove();
      tabsNode = null;
      return;
    }
    if (Date.now() - tabRowsAt > 1500) {
      tabRowsAt = Date.now();
      tabRows = mainWorld("conversationRows", document.body) ?? tabRows;
    }
    let bar = document.querySelector(".epitaxy-titlebar") ?? document.querySelector(".dframe-chrome-title-slot");
    if (!bar || !isShown(bar)) {
      tabsNode?.remove();
      tabsNode = null;
      return;
    }
    // The title is moved to the right, beside its buttons (tabsLayoutCss); the tabs take the left.
    let lead = bar.querySelector('[class*="group/lead"]');
    let end = bar.querySelector(".epitaxy-titlebar-end");
    let barRect = bar.getBoundingClientRect();
    // Right after the bar's own left-hand buttons (menu, sidebar, back / forward). The lead's box
    // ends there: the Claude/Code switch in it is laid out but hidden until the floating sidebar opens,
    // and then the sidebar's strip covers the tabs below (see the clip further down).
    let leadButtons = document.querySelector(".dframe-chrome-lead");
    let left = Math.max(barRect.left, leadButtons && isShown(leadButtons) ? leadButtons.getBoundingClientRect().right : 0) + 8;
    let right = (lead ? lead.getBoundingClientRect().left : end ? end.getBoundingClientRect().left : barRect.right) - 12;
    let overlay = navigator.windowControlsOverlay?.visible ? navigator.windowControlsOverlay.getTitlebarAreaRect() : null;
    if (overlay && overlay.width > 0) {
      right = Math.min(right, overlay.x + overlay.width - 8);
    }
    let { list, current, key } = tabsWanted();
    if (right - left < 90 || list.length === 0) {
      tabsNode?.remove();
      tabsNode = null;
      return;
    }
    if (!tabsNode) {
      tabsNode = element("div", "tabs");
      // The (vertical) mouse wheel scrolls the strip sideways.
      tabsNode.addEventListener(
        "wheel",
        (event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && tabsNode.scrollWidth > tabsNode.clientWidth) {
            tabsNode.scrollLeft += event.deltaY;
            event.preventDefault();
          }
        },
        { passive: false },
      );
      ui().appendChild(tabsNode);
    }
    tabsNode.style.left = `${Math.round(left)}px`;
    watchSidebar();
    updateTabsClip();
    tabsNode.style.width = `${Math.round(right - left)}px`;
    tabsNode.style.top = `${Math.round(barRect.top + (barRect.height - 26) / 2)}px`;
    tabsNode.style.height = "26px";
    let split = splitState();
    let visibleInSplit = split?.visible ?? new Set();
    // Side by side, the conversations on screen are one tab: the first pane's (the first one with a tab),
    // marked ⧉ with their number; the others' tabs stay in the list and come back when their pane closes.
    let paneIds = split ? panes().map(paneSessionId).filter(Boolean) : [];
    let anchorId = paneIds.find((id) => list.some((row) => row.kind === "code" && row.id === id)) ?? null;
    splitTabs = anchorId ? { anchorId, sides: paneIds.filter((id) => id !== anchorId) } : null;
    if (splitTabs) {
      list = list.filter((row) => !(row.kind === "code" && splitTabs.sides.includes(row.id)));
      if (current.startsWith("code:") && visibleInSplit.has(current.slice("code:".length))) {
        current = `code:${anchorId}`;
      }
    }
    let signature = JSON.stringify([list.map((row) => [key(row), row.title, row.pinnedTab, stateOf(row), row.project?.key]), current, [...visibleInSplit], splitTabs, Math.round(right - left), settings?.groupTabsByProject, tabExtrasKey]);
    if (signature === tabsKey) {
      return;
    }
    tabsKey = signature;
    // Every tab, the strip scrolling sideways when they don't fit (the wheel scrolls it): where it was
    // scrolled stays, and a tab that becomes current is brought into view.
    let scrolledTo = tabsNode.scrollLeft;
    tabsNode.textContent = "";
    let currentTab = null;
    for (let [index, row] of list.entries()) {
      let tab = tabFor(row, key(row) === current, row.kind === "code" && visibleInSplit.has(row.id));
      if (splitTabs && row.kind === "code" && row.id === splitTabs.anchorId) {
        let badge = element("span", "split-badge", `⧉ ${splitTabs.sides.length + 1}`);
        badge.title = `Side by side with ${splitTabs.sides.map(splitTitle).join(", ")} (click: go to one, or collapse it to a tab)`;
        badge.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
          let rect = badge.getBoundingClientRect();
          contextMenu(splitSideMenuItems(), rect.left, rect.bottom + 4);
        });
        badge.addEventListener("click", (event) => event.stopPropagation());
        tab.insertBefore(badge, tab.querySelector(".label"));
      }
      let previous = list[index - 1];
      if (settings?.groupTabsByProject && previous && !row.pinnedTab && (previous.pinnedTab || (previous.project?.key ?? "") !== (row.project?.key ?? ""))) {
        tab.classList.add("group-start");
      }
      if (key(row) === current) {
        currentTab = tab;
      }
      tabsNode.appendChild(tab);
    }
    tabsNode.scrollLeft = scrolledTo;
    if (currentTab && current !== tabsScrolledFor) {
      tabsScrolledFor = current;
      if (currentTab.offsetLeft < tabsNode.scrollLeft) {
        tabsNode.scrollLeft = currentTab.offsetLeft - 8;
      } else if (currentTab.offsetLeft + currentTab.offsetWidth > tabsNode.scrollLeft + tabsNode.clientWidth) {
        tabsNode.scrollLeft = currentTab.offsetLeft + currentTab.offsetWidth - tabsNode.clientWidth + 8;
      }
    }
  }
  /**
   * Opens tabs the way a browser does: the conversation you go to gets a tab, and one that starts
   * waiting for you gets one too (once; closing it while it still waits keeps it closed). The first
   * time, the list is seeded with what the strip used to show: sidebar pins, on screen, running.
   */
  let tabRequests = new Set();
  let waitingSeen = new Set();
  // The conversations already waiting when the page first lists them (after a start or a restart, which
  // also leaves interrupted ones waiting) are not news: their tabs stay as they were, closed ones too.
  let waitingBaselined = false;
  function syncOpenTabs(onScreen, current, byKey, key) {
    let isWaiting = (row) => row.pending || row.liveStatus === "needs_input" || row.liveStatus === "awaiting";
    let known = new Set([...pinnedTabs, ...(openTabs ?? [])].map(key));
    let wanted = [];
    let reasons = new Map();
    // Seed only once the page has listed its conversations (they load after the page starts).
    if (openTabs === null && tabRows.length === 0) {
      return;
    }
    if (openTabs === null) {
      wanted = tabRows.filter((row) => row.isStarred || onScreen.has(key(row)) || row.isRunning || isWaiting(row));
      wanted.forEach((row) => reasons.set(key(row), "first tabs"));
    }
    // A draft sent from the New session page became a session (a new one, on screen now): its tab goes,
    // the session's takes over. Opening an older session from that page leaves the draft's tab.
    if (previousTabKey === DRAFT_VIEW && current?.startsWith("code:") && known.has(DRAFT_VIEW) && !known.has(current)) {
      let updatedAt = byKey.get(current)?.updatedAt;
      if (!updatedAt || Date.now() - updatedAt < 60000) {
        log("tabs: the draft was sent; closing the New session tab");
        call("tabs", "close", "view", DRAFT_VIEW.slice("view:".length)).catch((caught) => log(`tabs: closing failed: ${caught.message}`));
      }
    }
    previousTabKey = current;
    // A view's tab is not stored (see tabsWanted) unless it is pinned, or it is the New session page.
    let keepsView = current === DRAFT_VIEW && settings?.keepDraftTab !== false;
    if (current && !known.has(current) && (!current.startsWith("view:") || keepsView)) {
      let row = byKey.get(current);
      let [kind, id] = [current.slice(0, current.indexOf(":")), current.slice(current.indexOf(":") + 1)];
      wanted.push(row ?? { kind, id, title: kind === "view" ? viewTitle(id) : document.title.replace(/\s+[-–]\s+Claude(?: Code)?$/, "") });
      reasons.set(current, "on screen");
    }
    if (!waitingBaselined && tabRows.length > 0) {
      waitingBaselined = true;
      for (let row of tabRows.filter(isWaiting)) {
        waitingSeen.add(key(row));
      }
      log(`tabs: ${waitingSeen.size} conversation(s) already waiting at start; their tabs stay as they were`);
    }
    for (let row of tabRows) {
      let rowKey = key(row);
      if (isWaiting(row)) {
        if (!waitingSeen.has(rowKey)) {
          waitingSeen.add(rowKey);
          if (!known.has(rowKey)) {
            wanted.push(row);
            reasons.set(rowKey, `started waiting (${row.pending ? "approval" : row.liveStatus})`);
          }
        }
      } else {
        waitingSeen.delete(rowKey);
      }
    }
    wanted = wanted.filter((row) => !known.has(key(row)) && !tabRequests.has(key(row)));
    if (openTabs === null || wanted.length) {
      let tabs = wanted.map((row) => ({ kind: row.kind, id: row.id, title: row.title }));
      if (tabs.length) {
        log(`tabs: opening ${tabs.map((tab) => `'${tab.title}' (${reasons.get(key(tab)) ?? "?"})`).join(", ")}`);
      }
      tabs.forEach((tab) => tabRequests.add(key(tab)));
      openTabs ??= [];
      call("tabs", "open", tabs)
        .catch((caught) => log(`tabs: opening failed: ${caught.message}`))
        .finally(() => tabs.forEach((tab) => tabRequests.delete(key(tab))));
    }
    // Keep stored titles current, so tabs of conversations the page doesn't list still read right.
    for (let tab of [...pinnedTabs, ...(openTabs ?? [])]) {
      let row = byKey.get(key(tab));
      if (row?.title && row.title !== tab.title && !tabRequests.has(`title:${key(tab)}`)) {
        tabRequests.add(`title:${key(tab)}`);
        call("tabs", "retitle", tab.kind, tab.id, row.title).finally(() => tabRequests.delete(`title:${key(tab)}`));
      }
    }
  }
  /**
   * Closes a tab; closing the one on screen goes to its neighbour (right, else left). Side by side, the
   * neighbour is the nearest tab not already in a pane: that one takes the closed session's pane (a tab
   * already on screen would only be focused, leaving the closed session where it was).
   */
  /**
   * Closes several (unpinned) tabs at once: "others" all but `row`, "right" the ones after it, "finished"
   * the ones read and neither working nor waiting. The tab on screen and those side by side stay, except
   * that "others" moves to `row` first. Each goes to the reopen list, like a single close.
   */
  function closeTabsExcept(row, which) {
    let { list, current, key } = tabsWanted();
    let visible = splitState()?.visible ?? new Set();
    let onScreen = (other) => key(other) === current || (other.kind === "code" && visible.has(other.id));
    let index = list.findIndex((other) => key(other) === key(row));
    let closing = list.filter((other, at) => {
      if (other.pinnedTab || other.kind === "view" || key(other) === key(row)) {
        return false;
      }
      if (which === "others") {
        return true;
      }
      if (which === "right") {
        return at > index && !onScreen(other);
      }
      return stateOf(other) === "" && !onScreen(other);
    });
    if (!closing.length) {
      flash("No tabs to close");
      return;
    }
    if (which === "others" && key(row) !== current) {
      openConversation(row);
    }
    call("tabs", "closeMany", closing.map((other) => ({ kind: other.kind, id: other.id }))).catch((caught) => log(`tabs: closing failed: ${caught.message}`));
  }
  // --- Side by side as one tab -----------------------------------------------------------------------
  /** The tabs as the strip shows them: without the side conversations of the split on screen. */
  const shownTabs = (list) => (splitTabs ? list.filter((row) => !(row.kind === "code" && splitTabs.sides.includes(row.id))) : list);
  const splitTitle = (sessionId) => `“${tabRows.find((row) => row.kind === "code" && row.id === sessionId)?.title || "Untitled"}”`;
  /** The side conversations of the split on screen: go to one, or collapse it back to a tab of its own. */
  function splitSideMenuItems() {
    return (splitTabs?.sides ?? []).flatMap((sessionId) => [
      { label: `Go to ${splitTitle(sessionId)}`, onClick: () => openConversation({ kind: "code", id: sessionId }) },
      { label: `Collapse ${splitTitle(sessionId)} to a tab`, onClick: () => collapseSplitSide(sessionId) },
    ]);
  }
  /** Closes a side conversation's pane (it keeps running) and makes sure it has a tab to come back to. */
  async function collapseSplitSide(sessionId) {
    let anchorId = splitTabs?.anchorId;
    if (!anchorId) {
      return;
    }
    let known = [...pinnedTabs, ...(openTabs ?? [])].some((tab) => tab.kind === "code" && tab.id === sessionId);
    if (!known) {
      await call("tabs", "open", [{ kind: "code", id: sessionId, title: tabRows.find((row) => row.id === sessionId)?.title ?? "" }]).catch((caught) => log(`tabs: opening failed: ${caught.message}`));
    }
    let outcome = await call("closeSplit", anchorId, sessionId).catch((caught) => caught.message);
    if (outcome !== "done" && outcome !== "noop") {
      flash(`Couldn't collapse it (${outcome})`);
    }
  }
  /** Reopens the most recently closed tab (kept by the main process, so also after a restart). */
  async function reopenClosedTab() {
    let tab = await call("tabs", "reopen").catch((caught) => {
      log(`tabs: reopening failed: ${caught.message}`);
      return null;
    });
    if (tab) {
      openConversation(tab);
    } else {
      flash("No closed tab to reopen");
    }
  }
  /** A session being deleted: its tab closes first and another one opens (the New session page when none is left). */
  function closeDeletedTab(sessionId) {
    let { list, current, key } = tabsWanted();
    let gone = `code:${sessionId}`;
    let row = list.find((each) => key(each) === gone);
    let others = list.filter((each) => key(each) !== gone && !(each.kind === "view" && key(each) === current));
    log(`tabs: session ${sessionId} is being deleted${row ? "; closing its tab" : ""}`);
    if (row) {
      closeTab(row);
    } else if (current === gone) {
      openConversation(others[0] ?? { kind: "view", id: DRAFT_VIEW.slice("view:".length) });
    }
  }
  function closeTab(row) {
    let { list, current, key } = tabsWanted();
    let index = list.findIndex((other) => key(other) === key(row));
    if (key(row) === current) {
      let visible = splitState()?.visible ?? new Set();
      let free = (other) => other && !(other.kind === "code" && visible.has(other.id));
      let neighbour = null;
      for (let step = 1; step < list.length && !neighbour; step++) {
        neighbour = [list[index + step], list[index - step]].find(free) ?? null;
      }
      // The last tab: a new conversation, else the closed one stays on screen and its tab comes back.
      openConversation(neighbour ?? { kind: "view", id: DRAFT_VIEW.slice("view:".length) });
    }
    call("tabs", "close", row.kind, row.id).catch((caught) => log(`tabs: closing failed: ${caught.message}`));
  }
  /**
   * The floating sidebar's strip in the top bar (dframe-chrome-peek-band) covers the bar's left part
   * while it is open. The tabs are drawn above the page, so the part under the strip is clipped
   * away: the sidebar covers them and they stay where they are. The strip fades and slides, so the
   * clip follows it frame by frame for a moment after the sidebar opens or closes.
   */
  function updateTabsClip() {
    if (!tabsNode) {
      return;
    }
    // The strip's own (animated) opacity says how much of it is there: the covered part of the tabs
    // fades out as it fades in, and back as it fades out.
    let band = document.querySelector(".dframe-chrome-peek-band");
    let covered = 0;
    let shown = 0;
    if (band) {
      let rect = band.getBoundingClientRect();
      shown = rect.width > 0 ? Number(getComputedStyle(band).opacity) || 0 : 0;
      covered = Math.max(0, rect.right - tabsNode.getBoundingClientRect().left);
    }
    if (covered > 0 && shown > 0.001) {
      let alpha = Math.max(0, 1 - shown).toFixed(3);
      let mask = `linear-gradient(to right, rgba(0,0,0,${alpha}) 0, rgba(0,0,0,${alpha}) ${Math.round(covered)}px, #000 ${Math.round(covered)}px)`;
      tabsNode.style.maskImage = mask;
      tabsNode.style.webkitMaskImage = mask;
    } else {
      tabsNode.style.maskImage = "";
      tabsNode.style.webkitMaskImage = "";
    }
  }
  let clipFollowUntil = 0;
  function followSidebar() {
    let first = clipFollowUntil < performance.now();
    clipFollowUntil = performance.now() + 600;
    if (!first) {
      return;
    }
    let frame = () => {
      updateTabsClip();
      if (performance.now() < clipFollowUntil) {
        requestAnimationFrame(frame);
      }
    };
    frame();
  }
  // Only the sidebar's button and strip are watched; they are attached as they appear.
  let sidebarObserver = new MutationObserver(followSidebar);
  let sidebarWatched = new WeakSet();
  function watchSidebar() {
    for (let node of document.querySelectorAll('button[aria-label="Show sidebar"], .dframe-chrome-peek-band')) {
      if (!sidebarWatched.has(node)) {
        sidebarWatched.add(node);
        sidebarObserver.observe(node, { attributes: true, attributeFilter: ["aria-expanded", "data-shown", "style", "class"] });
      }
    }
  }
  /**
   * Dragging a code session's tab onto the conversation on screen opens it beside that one, as the
   * app's own split view does when a session is dragged in from the sidebar (the same layout command
   * its open_session_in tool sends). The drop zone covers the conversation on screen.
   */
  let splitDrop = null;
  /** The area the conversation pane takes on screen: its tile host can have no box of its own (3.6556.2). */
  function paneArea(pane) {
    for (let node = pane?.root; node && node !== document.body; node = node.parentElement) {
      let rect = node.getBoundingClientRect();
      if (rect.width >= 300 && rect.height >= 200) {
        return rect;
      }
    }
    for (let node = pane?.transcript; node && node !== document.body; node = node.parentElement) {
      let rect = node.getBoundingClientRect();
      if (rect.width >= 300 && rect.height >= 200) {
        return rect;
      }
    }
    return null;
  }
  function showSplitDrop(row) {
    let current = currentConversationKey();
    let pane = panes().find((each) => paneArea(each)) ?? panes()[0];
    // Dragging the conversation on screen pairs it with its neighbour in the strip (left, else right).
    let partner = null;
    if (row.kind === "code" && current === `code:${row.id}`) {
      let { list } = tabsWanted();
      let at = list.findIndex((other) => other.kind === "code" && other.id === row.id);
      partner = [list[at - 1], list[at + 1]].find((other) => other?.kind === "code") ?? null;
    }
    let refusal =
      row.kind !== "code"
        ? `a ${row.kind} tab, not a code session`
        : !current.startsWith("code:")
          ? `the page on screen is ${current || "not a conversation"}`
          : current === `code:${row.id}` && !partner
            ? "it is the conversation on screen and no other code tab is beside it"
            : !pane
              ? "no conversation pane found"
              : "";
    let rect = pane ? paneArea(pane) : null;
    if (!refusal && !rect) {
      refusal = "no conversation pane of a usable size on screen";
    }
    if (refusal) {
      log(`split drop: not offered for '${row.title}' (${refusal})`);
      return;
    }
    // What opens beside what: the dragged tab beside the conversation on screen, or its neighbour beside it.
    let [callerId, targetRow] = partner ? [row.id, partner] : [current.slice("code:".length), row];
    splitDrop = element("div", "split-drop", partner ? `Drop here to open “${partner.title || "Untitled"}” beside this one` : "Drop here to open it side by side");
    Object.assign(splitDrop.style, {
      left: `${Math.round(rect.left + 8)}px`,
      top: `${Math.round(rect.top + 8)}px`,
      width: `${Math.round(rect.width - 16)}px`,
      height: `${Math.round(rect.height - 16)}px`,
    });
    splitDrop.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      splitDrop.classList.add("over");
    });
    splitDrop.addEventListener("dragleave", () => splitDrop?.classList.remove("over"));
    splitDrop.addEventListener("drop", (event) => {
      event.preventDefault();
      hideSplitDrop();
      call("openInSplit", callerId, targetRow.id).then(
        (outcome) => {
          log(`split drop: '${targetRow.title}' beside ${callerId}: ${outcome}`);
          if (outcome !== "done" && outcome !== "noop") {
            flash(`Couldn't open it side by side (${outcome})`);
          }
        },
        (caught) => {
          log(`split drop: '${targetRow.title}' failed: ${caught.message}`);
          flash(caught.message);
        },
      );
    });
    ui().appendChild(splitDrop);
  }
  function hideSplitDrop() {
    splitDrop?.remove();
    splitDrop = null;
  }
  // --- Hovering a conversation's tab: its last answer, with model, effort, context and state -----------
  let tabPreviewNode = null;
  let tabPreviewTimer = null;
  let tabPreviewWatch = null;
  const tabPreviewCache = new Map(); // sessionId -> { at, data }
  /** Markdown inline marks (code, bold, italic, links as their text) as nodes appended to `parent`. */
  function appendInlineMarkdown(parent, text) {
    let pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
    let at = 0;
    for (let match of text.matchAll(pattern)) {
      parent.append(text.slice(at, match.index));
      let token = match[0];
      if (token.startsWith("`")) {
        parent.appendChild(element("code", "", token.slice(1, -1)));
      } else if (token.startsWith("**") || token.startsWith("__")) {
        let strong = element("strong", "");
        appendInlineMarkdown(strong, token.slice(2, -2));
        parent.appendChild(strong);
      } else if (token.startsWith("[")) {
        parent.appendChild(element("span", "link", token.slice(1, token.indexOf("]("))));
      } else {
        let emphasis = element("em", "");
        appendInlineMarkdown(emphasis, token.slice(1, -1));
        parent.appendChild(emphasis);
      }
      at = match.index + token.length;
    }
    parent.append(text.slice(at));
  }
  /**
   * Markdown as elements (never as HTML: the text comes from a transcript): headings, paragraphs,
   * bullet and numbered lists, quotes, rules, fenced code and pipe tables, with inline marks.
   */
  function markdownNodes(markdown) {
    let root = document.createDocumentFragment();
    let lines = markdown.replace(/\r/g, "").split("\n");
    let paragraph = null;
    let list = null;
    let end = () => {
      paragraph = null;
      list = null;
    };
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index];
      let fence = /^\s*```/.test(line);
      if (fence) {
        end();
        let code = [];
        while (++index < lines.length && !/^\s*```/.test(lines[index])) {
          code.push(lines[index]);
        }
        let pre = element("pre", "");
        pre.appendChild(element("code", "", code.join("\n")));
        root.appendChild(pre);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        end();
        let table = element("table", "");
        for (; index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]); index++) {
          if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[index])) {
            continue; // the header's |---|---| line
          }
          let row = element("tr", "");
          for (let cell of lines[index].trim().slice(1, -1).split("|")) {
            let td = element(table.childElementCount === 0 ? "th" : "td", "");
            appendInlineMarkdown(td, cell.trim());
            row.appendChild(td);
          }
          table.appendChild(row);
        }
        index--;
        root.appendChild(table);
        continue;
      }
      let heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      let bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      let numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
      let quote = /^\s*>\s?(.*)$/.exec(line);
      if (!line.trim()) {
        end();
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        end();
        root.appendChild(element("hr", ""));
      } else if (heading) {
        end();
        let node = element("div", `h h${heading[1].length}`);
        appendInlineMarkdown(node, heading[2]);
        root.appendChild(node);
      } else if (bullet || numbered) {
        let [, indent, text] = bullet ?? numbered;
        let tag = bullet ? "ul" : "ol";
        if (!list || list.tagName.toLowerCase() !== tag) {
          paragraph = null;
          list = element(tag, "");
          root.appendChild(list);
        }
        let item = element("li", "");
        item.style.marginInlineStart = `${Math.min(4, Math.floor(indent.length / 2)) * 14}px`;
        appendInlineMarkdown(item, text);
        list.appendChild(item);
      } else if (quote) {
        end();
        let node = element("blockquote", "");
        appendInlineMarkdown(node, quote[1]);
        root.appendChild(node);
      } else if (list && /^\s{2,}\S/.test(line)) {
        // A list item's continuation line.
        list.lastElementChild.append(" ");
        appendInlineMarkdown(list.lastElementChild, line.trim());
      } else {
        list = null;
        if (!paragraph) {
          paragraph = element("p", "");
          root.appendChild(paragraph);
        } else {
          paragraph.appendChild(document.createElement("br"));
        }
        appendInlineMarkdown(paragraph, line.trim());
      }
    }
    return root;
  }
  function hideTabPreview() {
    clearTimeout(tabPreviewTimer);
    clearInterval(tabPreviewWatch);
    tabPreviewWatch = null;
    tabPreviewNode?.remove();
    tabPreviewNode = null;
  }
  function scheduleTabPreview(tab, row) {
    clearTimeout(tabPreviewTimer);
    tabPreviewTimer = setTimeout(() => showTabPreview(tab, row), 450);
  }
  async function showTabPreview(tab, row) {
    let cached = tabPreviewCache.get(row.id);
    let data = cached && Date.now() - cached.at < 15000 ? cached.data : await call("tabPreview", row.id).catch(() => null);
    // The pointer may have moved on (or the strip been redrawn) while the answer was read.
    if (!data || !tab.isConnected || !tab.matches(":hover")) {
      return;
    }
    tabPreviewCache.set(row.id, { at: Date.now(), data });
    hideTabPreview();
    let node = element("div", "tab-preview");
    node.style.opacity = String(Math.min(100, Math.max(20, Number(settings?.tabPreviewOpacity) || 80)) / 100);
    node.appendChild(element("div", "head", row.title || "Untitled"));
    if (sessionNotes[row.id]) {
      node.appendChild(element("div", "note", `✎ ${sessionNotes[row.id]}`));
    }
    let state = stateOf(row);
    let extra = tabExtras[row.id];
    let meta = [
      state ? STATE_NAMES[state] + (extra?.reason && state !== "working" ? `: ${extra.reason}` : "") : "",
      extra?.topic?.ticket ? `🎫 ${extra.topic.ticket.id}${extra.topic.ticket.status ? ` · ${extra.topic.ticket.status}` : ""}` : "",
      ciText(ciOf(extra)),
      taskShort(row.id),
      extra?.queued ? `⏭ ${extra.queued} queued` : "",
      data.model,
      data.effort && `${data.effort} effort`,
      data.contextTokens ? `${Math.round(data.contextTokens / 1000)}k context` : "",
      data.cost ? `≈ ${money(data.cost)} so far` : "",
    ].filter(Boolean);
    if (meta.length) {
      node.appendChild(element("div", "meta", meta.join("  ·  ")));
    }
    let text = data.text.trim();
    if (text) {
      let body = element("div", "body");
      body.appendChild(markdownNodes(text.length > 1500 ? `${text.slice(0, 1500)}…` : text));
      node.appendChild(body);
    } else {
      node.appendChild(element("div", "body empty", "No finished answer yet"));
    }
    ui().appendChild(node);
    let rect = tab.getBoundingClientRect();
    node.style.left = `${Math.round(Math.max(16, Math.min(rect.left, innerWidth - node.offsetWidth - 16)))}px`;
    node.style.top = `${Math.round(rect.bottom + 6)}px`;
    tabPreviewNode = node;
    tabPreviewWatch = setInterval(() => {
      if (!tab.isConnected || !tab.matches(":hover")) {
        hideTabPreview();
      }
    }, 300);
  }
  function tabFor(row, isCurrent, isOnScreen = false) {
    let tab = element("div", `tab${isCurrent ? " current" : isOnScreen ? " onscreen" : ""}${row.kind === "view" ? " view" : ""}`);
    let state = stateOf(row);
    let note = row.kind === "code" ? sessionNotes[row.id] : "";
    let extra = row.kind === "code" ? tabExtras[row.id] : null;
    let ci = ciOf(extra);
    let stateName = state ? STATE_NAMES[state] + (extra?.reason && state !== "working" ? `: ${extra.reason}` : "") : "";
    tab.title = [row.title, note ? `✎ ${note}` : "", stateName, ciText(ci), isMuted(row.id) ? "Notifications muted" : ""].filter(Boolean).join("\n");
    if (row.kind === "code" && settings?.tabPreview) {
      // The preview says all the tooltip did, and more.
      tab.removeAttribute("title");
      tab.addEventListener("mouseenter", () => scheduleTabPreview(tab, row));
      tab.addEventListener("mouseleave", hideTabPreview);
      tab.addEventListener("mousedown", hideTabPreview);
    }
    if (state) {
      tab.appendChild(element("span", `dot ${state}`, STATE_GLYPHS[state]));
    }
    if (ci?.checks) {
      let mark = element("span", `ci ${ci.checks}`, CI_GLYPHS[ci.checks] ?? "");
      mark.title = `${ciText(ci)}${ci.url ? " (click to open)" : ""}`;
      mark.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        ci.url && call("openUrl", ci.url).catch((caught) => flash(caught.message));
      });
      tab.appendChild(mark);
    }
    if (extra?.queued) {
      let queued = element("span", "queued", `⏭${extra.queued}`);
      queued.title = `${extra.queued} queued prompt${extra.queued === 1 ? "" : "s"}: sent one by one as turns end (click to see)`;
      queued.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showPromptQueue(row.id, row.title);
      });
      tab.appendChild(queued);
    }
    let limit = tabLimits[row.id];
    if (limit?.over?.length) {
      let warn = element("span", "queued", "⚠");
      warn.title = `${[limit.over.includes("cost") ? `about $${limit.cost.toFixed(2)} so far` : "", limit.over.includes("context") ? `context ${limit.contextPercent}% full` : ""].filter(Boolean).join(", ")} (click to compact)`;
      warn.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        compactNow(row.id);
      });
      tab.appendChild(warn);
    }
    if (isMuted(row.id)) {
      tab.appendChild(element("span", "muted", "🔕"));
    }
    if (note) {
      tab.appendChild(element("span", "muted", "✎"));
    }
    if (settings?.colorProjects && row.project) {
      tab.classList.add("colored");
      tab.style.setProperty("--pt-project", projectColor(row.project.key));
    }
    let run = row.kind === "code" ? scheduledRuns[row.id] : null;
    if (run && run.at > Date.now()) {
      let sched = element("span", "sched", `⏰ ${countdown(run.at)}`);
      sched.dataset.at = String(run.at);
      sched.title = `Next run at ${new Date(run.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${run.label}`;
      tab.appendChild(sched);
    }
    if (row.pinnedTab) {
      tab.appendChild(element("span", "pin", "📌"));
    }
    tab.appendChild(element("span", "label", row.title || "Untitled"));
    if (!row.pinnedTab) {
      let close = element("span", "close", "×");
      close.title = "Close tab";
      close.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeTab(row);
      });
      tab.appendChild(close);
    }
    tab.addEventListener("mousedown", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(row);
      }
    });
    // A click opens it; a drag (which never ends in a click) moves it.
    tab.addEventListener("click", (event) => {
      // The × closes on mousedown; its click must not reopen the tab.
      if (event.button === 0 && !event.target.closest?.(".close")) {
        openConversation(row);
      }
    });
    tab.draggable = true;
    tab.dataset.group = row.pinnedTab ? "pinned" : "open";
    tab.addEventListener("dragstart", (event) => {
      draggedTab = { kind: row.kind, id: row.id, group: tab.dataset.group };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/x-powertoys-tab", `${row.kind}:${row.id}`);
      tab.classList.add("dragging");
      showSplitDrop(row);
    });
    tab.addEventListener("dragend", () => {
      hideSplitDrop();
      draggedTab = null;
      tab.classList.remove("dragging");
      tabsNode?.querySelectorAll(".drop-before, .drop-after").forEach((other) => other.classList.remove("drop-before", "drop-after"));
    });
    tab.addEventListener("dragover", (event) => {
      if (!draggedTab || draggedTab.group !== tab.dataset.group) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      let rect = tab.getBoundingClientRect();
      let after = event.clientX > rect.left + rect.width / 2;
      tabsNode?.querySelectorAll(".drop-before, .drop-after").forEach((other) => other !== tab && other.classList.remove("drop-before", "drop-after"));
      tab.classList.toggle("drop-after", after);
      tab.classList.toggle("drop-before", !after);
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("drop-before", "drop-after"));
    tab.addEventListener("drop", (event) => {
      event.preventDefault();
      let dragged = draggedTab;
      tab.classList.remove("drop-before", "drop-after");
      if (!dragged || dragged.group !== tab.dataset.group || (dragged.kind === row.kind && dragged.id === row.id)) {
        return;
      }
      // Positions within the group, as the main process stores it.
      let list = dragged.group === "pinned" ? pinnedTabs : openTabs ?? [];
      let from = list.findIndex((other) => other.kind === dragged.kind && other.id === dragged.id);
      let to = list.findIndex((other) => other.kind === row.kind && other.id === row.id);
      if (from < 0 || to < 0) {
        return;
      }
      let rect = tab.getBoundingClientRect();
      let after = event.clientX > rect.left + rect.width / 2;
      let target = to + (after ? 1 : 0);
      if (from < target) {
        target--;
      }
      call("tabs", "move", dragged.kind, dragged.id, target).catch((caught) => log(`tabs: moving failed: ${caught.message}`));
    });
    tab.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      let pinnedHere = pinnedTabs.findIndex((other) => other.kind === row.kind && other.id === row.id);
      let items = [
        { label: "Open", onClick: () => openConversation(row) },
        { label: "Open in new window", onClick: () => call("openWindow", ROUTES[row.kind]?.(row.id)).catch((caught) => flash(caught.message)) },
        { label: "Close tab", onClick: () => closeTab(row) },
        { label: "Close other tabs", onClick: () => closeTabsExcept(row, "others") },
        { label: "Close tabs to the right", onClick: () => closeTabsExcept(row, "right") },
        { label: "Close finished tabs (read, not working or waiting)", onClick: () => closeTabsExcept(row, "finished") },
        { label: "Reopen closed tab (Ctrl+Shift+T)", onClick: reopenClosedTab },
        pinnedHere >= 0
          ? { label: "Unpin tab", onClick: () => call("tabs", "unpin", row.kind, row.id) }
          : { label: "Pin tab", onClick: () => call("tabs", "pin", { kind: row.kind, id: row.id, title: row.title }) },
      ];
      if (pinnedHere > 0) {
        items.push({ label: "Move left", onClick: () => call("tabs", "move", row.kind, row.id, pinnedHere - 1) });
      }
      if (pinnedHere >= 0 && pinnedHere < pinnedTabs.length - 1) {
        items.push({ label: "Move right", onClick: () => call("tabs", "move", row.kind, row.id, pinnedHere + 1) });
      }
      if (row.kind === "code") {
        items.push(
          "-",
          { label: sessionNotes[row.id] ? "Edit note…" : "Add a note…", onClick: () => editNote(row.id, row.title) },
          { label: `Queued prompts (${promptQueue[row.id]?.length ?? 0})…`, onClick: () => showPromptQueue(row.id, row.title) },
          { label: "Topic: ticket, progress, PR…", onClick: () => openTopic(row.id, row.title) },
          { label: "Context map…", onClick: () => openContextMap(row.id, row.title) },
          ...(ciOf(tabExtras[row.id])?.checks === "failed" ? [{ label: "Fix CI (asks it to read the failing checks' logs)", onClick: () => fixCi(row.id) }] : []),
          ...(compactOffered() ? [{ label: "Compact now", onClick: () => compactNow(row.id) }] : []),
          ...(row.project?.folder ? [{ label: `Instructions for new sessions in ${row.project.name}…`, onClick: () => editProjectInstructions(row) }] : []),
          ...(tabExtras[row.id]?.taskList === false ? [{ label: "Add the task list to this session", onClick: () => addTaskList(row.id) }] : []),
          isMuted(row.id)
            ? { label: "Unmute notifications", onClick: () => call("muteSession", row.id, false) }
            : { label: "Mute notifications", onClick: () => call("muteSession", row.id, true) },
          { label: "Open edited files in IntelliJ", onClick: () => openEditedInIdea(row.id) },
          { label: "Export as", submenu: exportMenuItems(row.id, null) },
          { label: "Rebuild Claude, restart and continue here", onClick: () => restartAndContinue(row.id) },
        );
      }
      if (row.project) {
        items.push(
          "-",
          { label: `Color for ${row.project.name}`, submenu: projectColorMenu(row.project) },
          { label: `New sessions in ${row.project.name}`, submenu: projectDefaultsMenu(row.project) },
        );
      }
      if (splitTabs && row.kind === "code" && row.id === splitTabs.anchorId) {
        items.push("-", ...splitSideMenuItems());
      }
      items.push("-", { label: "Save tabs and splits as a workspace…", onClick: saveWorkspace });
      let rect = tab.getBoundingClientRect();
      contextMenu(items, rect.left, rect.bottom + 4);
    });
    return tab;
  }
  // --- Tabs in split view ------------------------------------------------------------------------
  // With sessions side by side, the tab of the pane being worked in is the current one (not the main
  // pane's address), the other sessions on screen are marked, and a tab click goes through the app's
  // own "focus" layout command: a session already in a pane gets that pane focused, any other takes
  // the place of the session being worked in, and the split stays.
  let lastFocusedPaneSessionId = null;
  document.addEventListener(
    "focusin",
    (event) => {
      let pane = paneOf(event.target);
      if (pane && panes().length > 1) {
        lastFocusedPaneSessionId = paneSessionId(pane);
      }
    },
    true,
  );
  /** null without a split; else { focused, visible } session ids. */
  function splitState() {
    let all = panes();
    if (all.length < 2) {
      return null;
    }
    let visible = new Set(all.map(paneSessionId).filter(Boolean));
    let inFocus = all.find((pane) => pane.root.contains(document.activeElement));
    let focused = (inFocus && paneSessionId(inFocus)) || (visible.has(lastFocusedPaneSessionId) ? lastFocusedPaneSessionId : null) || paneSessionId(all[0]);
    return { focused, visible };
  }
  function openConversation(row) {
    if (row.kind === "code") {
      let split = splitState();
      if (split?.focused && split.focused !== row.id) {
        let fallback = () => openSessionNow(row.id);
        call("focusSessionInSplit", split.focused, row.id).then(
          (outcome) => {
            if (outcome === "done" || outcome === "noop") {
              lastFocusedPaneSessionId = row.id;
            } else {
              log(`tabs: split focus gave ${outcome}; opening the usual way`);
              fallback();
            }
          },
          (caught) => {
            log(`tabs: split focus failed: ${caught.message}`);
            fallback();
          },
        );
        return;
      }
      if (split?.focused === row.id) {
        return;
      }
      openSessionNow(row.id);
      return;
    }
    let route = ROUTES[row.kind]?.(row.id);
    if (route) {
      call("openPath", route).catch((caught) => log(`tabs: opening ${route} failed: ${caught.message}`));
    }
  }

  // --- Agents button and "Edit message" ----------------------------------------------------------
  // The page has a per-session "Background tasks" pane listing the session's agents (subagents,
  // teammates, background shells), but its View options entry only appears once the session has
  // tasks. A title-bar button opens it any time, through the pane store's own toggleSidePane.
  const AGENTS_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="5.5" cy="5.5" r="2.2"/><circle cx="11" cy="6.5" r="1.8"/><path d="M1.8 13c.4-2.2 1.9-3.5 3.7-3.5S8.8 10.8 9.2 13"/><path d="M9.6 10.2c.4-.4 1-.7 1.6-.7 1.4 0 2.6 1.1 2.9 2.9"/></svg>';
  const EDIT_ICON =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/></svg>';
  function iconButtonLike(template, label, svg) {
    let button = template.cloneNode(true);
    button.removeAttribute("id");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-haspopup");
    button.removeAttribute("data-popup-open");
    button.removeAttribute("disabled");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("data-powertoys-item", "");
    // The page draws some icons with elements rather than SVG; replace whatever is inside.
    button.innerHTML = svg;
    return button;
  }
  function decorateTitleBars() {
    for (let viewOptions of document.querySelectorAll('button[aria-label="View options"]')) {
      if (viewOptions.parentElement?.querySelector(':scope > [data-powertoys-agents]')) {
        continue;
      }
      let button = iconButtonLike(viewOptions, "Agents and background tasks", AGENTS_ICON);
      button.setAttribute("data-powertoys-agents", "");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        let current = button.parentElement?.querySelector('button[aria-label="View options"]');
        if (!current || !mainWorld("toggleTasks", current)) {
          log("agents: the session pane store was not found");
          flash("Couldn't open the agents pane");
        }
      });
      viewOptions.before(button);
    }
  }
  // --- The title bar's buttons in its ⋯ (View options) menu --------------------------------------
  // The buttons on the right of the title bar take the room the tabs need. With foldTitleBarButtons
  // they stay in the page, folded out of sight so they keep working, and the View options menu lists
  // them: an entry per button, added when the menu opens, that closes the menu and clicks the button.
  let foldCss = null;
  function applyFoldCss() {
    let want = !!(settings?.topTabs && settings?.foldTitleBarButtons);
    if (want && !foldCss) {
      foldCss = electron.webFrame.insertCSS(
        "[data-powertoys-folded] { position: absolute !important; width: 1px !important; height: 1px !important; overflow: hidden !important; clip-path: inset(50%) !important; opacity: 0 !important; pointer-events: none !important; }",
        { cssOrigin: "author" },
      );
    } else if (!want && foldCss) {
      electron.webFrame.removeInsertedCSS(foldCss);
      foldCss = null;
    }
    return want;
  }
  const buttonLabel = (button) => button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent.trim();
  let foldedLogged = "";
  function foldTitleBarButtons() {
    let want = applyFoldCss();
    for (let viewOptions of document.querySelectorAll('.epitaxy-titlebar-end button[aria-label="View options"]')) {
      let end = viewOptions.closest(".epitaxy-titlebar-end");
      let folded = [];
      for (let button of end.querySelectorAll("button")) {
        if (button !== viewOptions && !button.closest('[role="menu"]')) {
          button.toggleAttribute("data-powertoys-folded", want);
          folded.push(buttonLabel(button));
        }
      }
      // Which buttons there are differs between releases and sessions; main.log says what was folded.
      if (want && folded.join("|") !== foldedLogged) {
        foldedLogged = folded.join("|");
        log(`title bar buttons in the View options menu: ${folded.join(", ") || "none"}`);
      }
      if (!viewOptions.hasAttribute("data-powertoys-fold-hook")) {
        viewOptions.setAttribute("data-powertoys-fold-hook", "");
        let opening = () => settings?.topTabs && settings?.foldTitleBarButtons && addFoldedToMenu(end);
        viewOptions.addEventListener("pointerdown", opening, true);
        viewOptions.addEventListener("keydown", (event) => ["Enter", " ", "ArrowDown"].includes(event.key) && opening(), true);
      }
    }
  }
  function addFoldedToMenu(end) {
    let folded = [...end.querySelectorAll("button[data-powertoys-folded]")].filter((button) => buttonLabel(button));
    if (!folded.length) {
      return;
    }
    let before = new Set(document.querySelectorAll('[role="menu"]'));
    let started = performance.now();
    let poll = () => {
      let menu = [...document.querySelectorAll('[role="menu"]')].find((candidate) => !before.has(candidate) && isShown(candidate));
      if (!menu) {
        if (performance.now() - started < 1500) {
          requestAnimationFrame(poll);
        }
        return;
      }
      if (menu.querySelector("[data-powertoys-folded-item]")) {
        return;
      }
      // Entries look like the menu's own: a shallow copy of its first item (classes, no handlers).
      let template = menu.querySelector('[role="menuitem"]');
      let separator = menu.querySelector('[role="separator"]')?.cloneNode(true);
      if (separator) {
        separator.setAttribute("data-powertoys-folded-item", "");
        menu.appendChild(separator);
      }
      for (let button of folded) {
        let item = template ? template.cloneNode(false) : document.createElement("div");
        item.removeAttribute("id");
        item.removeAttribute("data-highlighted");
        item.setAttribute("role", "menuitem");
        item.setAttribute("data-powertoys-folded-item", "");
        item.tabIndex = -1;
        item.textContent = buttonLabel(button);
        item.toggleAttribute("aria-disabled", button.disabled);
        item.addEventListener("pointerenter", () => item.setAttribute("data-highlighted", ""));
        item.addEventListener("pointerleave", () => item.removeAttribute("data-highlighted"));
        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (button.disabled) {
            return;
          }
          menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          setTimeout(() => button.click(), 50);
        });
        menu.appendChild(item);
      }
    };
    requestAnimationFrame(poll);
  }
  // "Edit message", as in Claude Code (Esc Esc): the page's own "Rewind to here" removes the prompt
  // and what follows and puts the prompt back in the composer; then the composer gets focus with the
  // cursor at the end, ready to edit and send.
  function focusRestoredPrompt(pane) {
    let editor = paneEditor(pane);
    let before = editor?.innerText ?? "";
    let started = performance.now();
    let poll = () => {
      editor = paneEditor(pane);
      let text = editor?.innerText ?? "";
      if (editor && text.trim() !== "" && text !== before) {
        editor.focus();
        let range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        let selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      // The rewind may ask first (conversation / code); give the person time to answer.
      if (performance.now() - started < 30000) {
        setTimeout(poll, 150);
      }
    };
    setTimeout(poll, 150);
  }
  function decorateRewindButtons() {
    for (let rewind of document.querySelectorAll('[data-epitaxy-entry] button[aria-label="Rewind to here"]')) {
      let holder = rewind.parentElement?.matches("span, div") && rewind.parentElement.children.length === 1 ? rewind.parentElement : rewind;
      let next = holder.nextElementSibling;
      let button = next?.hasAttribute("data-powertoys-edit") ? next : null;
      if (!button) {
        button = iconButtonLike(rewind, "Edit message", EDIT_ICON);
        button.setAttribute("data-powertoys-edit", "");
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          let row = button.closest("[data-epitaxy-entry]");
          let current = row?.querySelector('button[aria-label="Rewind to here"]');
          if (!current || current.disabled) {
            flash("Editing is unavailable while Claude is working");
            return;
          }
          current.click();
          focusRestoredPrompt(paneOf(row));
        });
        holder.after(button);
      }
      // Follow the rewind button's state (disabled while Claude works).
      button.disabled = rewind.disabled;
      button.toggleAttribute("aria-disabled", rewind.disabled);
    }
  }

  // --- Keyboard ----------------------------------------------------------------------------------
  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onKey(event) {
    if (!event.isTrusted || !settings) {
      return;
    }
    // Keys typed in Powertoys' own fields (search, rename) stay there: the page sees our host
    // element as the target and would take plain letters for its shortcuts.
    if (uiHost && event.target === uiHost) {
      if (inlineEditing?.onKey(event) || (manager && manager.onKey(event)) || historyWindow?.onKey(event) || inboxWindow?.onKey(event) || awayWindow?.onKey(event) || [...keyWindows].some((each) => each.onKey(event)) || settingsWindow?.onKey(event) || archivedWindow?.onKey(event) || popup?.onKey?.(event)) {
        event.preventDefault();
      }
      event.stopImmediatePropagation();
      return;
    }
    // An open list or menu takes its keys first.
    if (switcher?.controls && event.type === "keydown" && event.ctrlKey && event.code === "Tab") {
      swallow(event);
      switcher.controls.move(event.shiftKey ? -1 : 1);
      return;
    }
    if (switcher && event.type === "keyup" && (event.key === "Control" || !event.ctrlKey)) {
      swallow(event);
      if (switcher.controls) {
        switcher.controls.pick();
      } else {
        switcher.released = true;
      }
      return;
    }
    if (switcher && event.type === "keydown" && event.code === "Escape") {
      swallow(event);
      switcher.controls ? closePopup() : (switcher = null);
      return;
    }
    if (historyPicker?.controls && event.type === "keydown" && event.altKey && (event.code === "ArrowUp" || event.code === "ArrowDown")) {
      swallow(event);
      historyPicker.controls.move(event.code === "ArrowUp" ? 1 : -1);
      return;
    }
    if (historyPicker && event.type === "keyup" && (event.key === "Alt" || !event.altKey)) {
      swallow(event);
      historyPicker.controls ? historyPicker.controls.pick() : (historyPicker = null);
      return;
    }
    if (manager && manager.onKey(event)) {
      swallow(event);
      return;
    }
    if (historyWindow?.onKey(event) || inboxWindow?.onKey(event) || awayWindow?.onKey(event) || [...keyWindows].some((each) => each.onKey(event)) || settingsWindow?.onKey(event) || archivedWindow?.onKey(event)) {
      swallow(event);
      return;
    }
    if (popup?.onKey?.(event)) {
      swallow(event);
      return;
    }
    if (event.type !== "keydown") {
      return;
    }
    let ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
    let code = event.code;
    if (settings.sessionSwitcher && ctrl && code === "Tab") {
      swallow(event);
      if (!switcher) {
        startSwitcher(event.shiftKey ? -1 : 1);
      }
      return;
    }
    if (settings.history && ctrl && !event.shiftKey && code === "KeyH") {
      swallow(event);
      openHistory();
      return;
    }
    if (ctrl && event.shiftKey && !event.altKey && code === "KeyU") {
      swallow(event);
      goToMostUrgent();
      return;
    }
    if (settings.search && ctrl && event.shiftKey && code === "KeyS") {
      swallow(event);
      openSearch();
      return;
    }
    if (settings.topTabs && settings.tabNumberKeys && ctrl && !event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(code)) {
      // As in a browser: Ctrl+1…8 the tab at that place, Ctrl+9 the last one (of the tabs shown).
      let list = shownTabs(tabsWanted().list);
      let number = Number(code.slice("Digit".length));
      let row = number === 9 ? list.at(-1) : list[number - 1];
      if (row) {
        swallow(event);
        openConversation(row);
        return;
      }
    }
    if (settings.topTabs && settings.tabNumberKeys && ctrl && event.shiftKey && !event.altKey && (code === "PageUp" || code === "PageDown")) {
      // Moves the current tab one place left or right among its neighbours as shown (pinned with pinned).
      let { list: wanted, current, key } = tabsWanted();
      let list = shownTabs(wanted);
      if (splitTabs && current.startsWith("code:") && splitState()?.visible.has(current.slice("code:".length))) {
        current = `code:${splitTabs.anchorId}`;
      }
      let at = list.findIndex((other) => key(other) === current);
      let row = list[at];
      let neighbour = list[at + (code === "PageUp" ? -1 : 1)];
      if (row && neighbour && row.kind !== "view" && neighbour.kind !== "view" && !!row.pinnedTab === !!neighbour.pinnedTab) {
        swallow(event);
        let group = row.pinnedTab ? pinnedTabs : openTabs ?? [];
        let to = group.findIndex((other) => key(other) === key(neighbour));
        call("tabs", "move", row.kind, row.id, to).catch((caught) => log(`tabs: moving failed: ${caught.message}`));
        return;
      }
    }
    if (settings.topTabs && settings.tabNumberKeys && ctrl && event.shiftKey && !event.altKey && code === "KeyT") {
      swallow(event);
      reopenClosedTab();
      return;
    }
    if (settings.topTabs && ctrl && !event.shiftKey && code === "KeyW") {
      let { list, current, key } = tabsWanted();
      let row = list.find((other) => key(other) === current);
      if (row) {
        swallow(event);
        closeTab(row);
        return;
      }
    }
    if ((code === "Enter" || code === "NumpadEnter") && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && inPromptBox()) {
      let pane = activePane();
      let editor = paneEditor(pane);
      let sessionId = paneSessionId(pane);
      if (editor && sessionId && /^\/(rename|name)$/i.test(editor.innerText.trim())) {
        swallow(event);
        editor.focus();
        document.execCommand("selectAll");
        document.execCommand("delete");
        flash("Naming the session…");
        call("autoRename", sessionId).then(
          (title) => flash(`Renamed: ${title}`),
          (caught) => flash(caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")),
        );
        return;
      }
    }
    if (settings.commandPalette && ctrl && event.shiftKey && code === "KeyP") {
      swallow(event);
      openPalette();
      return;
    }
    if (settings.snippets && ctrl && event.shiftKey && code === "Space") {
      swallow(event);
      showSnippets();
      return;
    }
    if (settings.hidePromptSuggestions && code === "Tab" && !event.ctrlKey && !event.altKey && inPromptBox() && activePane()?.root.querySelector("[data-prompt-suggestion-ghost]")) {
      // The suggestion is hidden, so Tab must not accept it.
      swallow(event);
      return;
    }
    if (settings.promptQueueKey && event.altKey && !ctrl && !event.shiftKey && (code === "Enter" || code === "NumpadEnter") && inPromptBox()) {
      swallow(event);
      queueFromPromptBox();
      return;
    }
    if (settings.ctrlEnterSendsNow && ctrl && !event.shiftKey && (code === "Enter" || code === "NumpadEnter") && inPromptBox()) {
      // Not swallowed: the app queues the message, then its "Send now" is pressed.
      let pane = activePane();
      watchForSendNow(pane, paneEditor(pane));
      return;
    }
    if (inOtherTextField() || inDialog()) {
      return;
    }
    if (settings.promptHistory && event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && code === "ArrowUp" && inPromptBox()) {
      swallow(event);
      if (!historyPicker) {
        startHistory(deepActiveElement().closest('.ProseMirror[contenteditable="true"]'));
      }
      return;
    }
    if (settings.editQueuedKey && ctrl && !event.shiftKey && code === "ArrowUp" && inPromptBox() && editLastQueued()) {
      swallow(event);
      return;
    }
    if (settings.promptJump && ctrl && !event.shiftKey && (code === "ArrowUp" || code === "ArrowDown")) {
      swallow(event);
      jumpPrompt(code === "ArrowUp" ? -1 : 1);
      return;
    }
    if (settings.conversationEnds && ctrl && !event.shiftKey && (code === "Home" || code === "End")) {
      swallow(event);
      goToEnd(code === "Home");
      return;
    }
  }

  // --- Wiring ------------------------------------------------------------------------------------
  function applySettings(next) {
    settings = next;
    tabsKey = "";
    colorSidebarProjects();
    applySidebarCss();
    applyLook();
    updateStatusBar();
    applyRtl();
    layoutOutlineButtons();
    settingsWindow?.render();
  }
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener(
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      onPointerMoveForSidebar(event);
      messageTimeFrame ||= requestAnimationFrame(showMessageTime);
    },
    { capture: true, passive: true },
  );
  window.addEventListener("contextmenu", onMessageContextMenu, true);
  window.addEventListener(
    "mousedown",
    (event) => {
      if (popup && event.target !== uiHost) {
        closePopup();
      }
    },
    true,
  );
  window.addEventListener("blur", () => {
    if (switcher || historyPicker) {
      closePopup();
      switcher = null;
      historyPicker = null;
    }
  });
  ipc.on("powertoys:settings", (event, next) => applySettings(next));
  ipc.on("powertoys:tabs", (event, next) => {
    pinnedTabs = next?.pinned ?? [];
    openTabs = next?.open ?? null;
    tabsKey = "";
  });
  ipc.on("powertoys:window", (event, next) => {
    windowMaximized = next?.maximized === true;
  });
  ipc.on("powertoys:sessionDeleting", (event, sessionId) => {
    if (typeof sessionId === "string") {
      closeDeletedTab(sessionId);
    }
  });
  ipc.on("powertoys:queue", (event, next) => {
    promptQueue = next ?? {};
    refreshTabExtras();
  });
  ipc.on("powertoys:notes", (event, next) => {
    sessionNotes = next ?? {};
    tabPreviewCache.clear();
    tabsKey = "";
  });
  ipc.on("powertoys:snippets", (event, next) => {
    snippets = next;
  });
  ipc.on("powertoys:bookmarks", (event, next) => {
    bookmarkData = next;
    manager?.render();
  });
  ipc.on("powertoys:command", (event, command) => {
    if (command?.type === "insert") {
      let pane = activePane();
      let editor = paneEditor(pane);
      expandSnippet(command.text, paneSessionId(pane)).then((text) => setTimeout(() => insertIntoEditor(editor, text), 50));
    } else if (command?.type === "openSearch") {
      openSearch();
    } else if (command?.type === "openArchived") {
      openArchived();
    } else if (command?.type === "newProfile") {
      askNewProfile();
    } else if (command?.type === "openSettings") {
      openSettings();
    } else if (command?.type === "openInbox") {
      openInbox();
    } else if (command?.type === "saveWorkspace") {
      saveWorkspace();
    } else if (command?.type === "openPalette") {
      openPalette(command.query ?? "");
    } else if (command?.type === "openHistory") {
      openHistory();
    } else if (command?.type === "openBookmarks") {
      openBookmarkManager();
    } else if (command?.type === "flash") {
      flash(command.text, command.x ?? pointer.x, command.y ?? pointer.y);
    } else if (command?.type === "reveal") {
      revealWhenOnScreen(command.sessionId, command.keys ?? [], command.text ?? "");
    }
  });
  let start = async () => {
    let state = null;
    for (let attempt = 0; !state && attempt < 60; attempt++) {
      try {
        state = await call("getState");
      } catch (caught) {
        if (attempt === 59) {
          console.warn("[powertoys] could not start:", caught);
          return;
        }
        await sleep(500);
      }
    }
    snippets = state.snippets;
    bookmarkData = state.bookmarks;
    pinnedTabs = state.tabs?.pinned ?? [];
    settingsSections = state.settingsSections ?? [];
    openTabs = state.tabs?.open ?? null;
    sessionNotes = state.notes ?? {};
    promptQueue = state.queue ?? {};
    windowMaximized = state.window?.maximized !== false;
    applySettings(state.settings);
    collapseSidebarGroupsAtStart();
    refreshKnownModels();
    log(`page module started on ${location.pathname}`);
    // A timer, not requestAnimationFrame: frames stop while the window is covered or minimised.
    let decorate = () => {
      layoutOutlineButtons();
      try {
        layoutTabs();
        applyRtl();
        markThinking();
        followTurns();
        updateStatusBar();
        decorateOpenInMenus();
        decorateTitleBars();
        foldTitleBarButtons();
        decorateRewindButtons();
        hideSurveyBars();
      } catch (caught) {
        log(`decorating failed: ${caught.message}`);
      }
    };
    setInterval(decorate, 300);
    setInterval(() => refreshTabExtras().catch((caught) => log(`tab extras failed: ${caught.message}`)), 5000);
    // Task lists search the page's text, so once a second.
    setInterval(() => {
      try {
        decorateTaskLists();
      } catch (caught) {
        log(`task progress failed: ${caught.message}`);
      }
    }, 1000);
    decorate();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}

/**
 * Runs in the page's main world, before the page's scripts (contextBridge.executeInMainWorld); must not use
 * anything outside itself. A folder a claude://code/new?folder= link opens goes through the page's
 * "external folder" step, which asks "Trust this workspace?" every time unless its web flag
 * ccd_deeplink_trusted_folder_skip_main is on; then it asks the app (LocalSessions.checkStoredTrust) and
 * skips the question for a trusted folder. That flag comes in the bootstrap response's growthbook.features,
 * keyed by the djb2 hash of its name (growthbook.hashing_algorithm); this turns it on there. With folder
 * trust off every folder counts as trusted (claude-json-workspace-trust-config.js), so it never asks.
 */
function powertoysSkipTrustedFolderPromptInMainWorld() {
  let djb2 = (text) => {
    let hash = 0;
    for (let index = 0; index < text.length; index++) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return String(hash);
  };
  let flag = djb2("ccd_deeplink_trusted_folder_skip_main");
  let pageFetch = window.fetch;
  window.fetch = async function (...args) {
    let response = await pageFetch.apply(this, args);
    let url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? String(args[0]);
    if (!/\/bootstrap(\/[^/?]+\/app_start)?\?[^#]*growthbook_format=sdk/.test(url) || !response.ok) {
      return response;
    }
    try {
      let body = await response.clone().json();
      let growthbook = body?.growthbook;
      if (growthbook?.hashing_algorithm !== "djb2" || typeof growthbook.features !== "object" || !growthbook.features) {
        console.warn("[powertoys] folder trust: the bootstrap has no djb2 growthbook features; the link prompt stays");
        return response;
      }
      growthbook.features[flag] = { defaultValue: true };
      console.info("[powertoys] folder trust: ccd_deeplink_trusted_folder_skip_main on in the bootstrap");
      return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (caught) {
      console.warn("[powertoys] folder trust: reading the bootstrap failed", caught);
      return response;
    }
  };
}

/**
 * Runs in the page's main world, before the page's scripts; must not use anything outside itself. "Copy path"
 * and "Copy absolute path" copy E:/a/b on Windows; a Windows path the page copies right after you pick such an
 * item goes to the clipboard as E:\a\b (setting copyPathBackslashes, read from a DOM attribute the page module
 * keeps). Other copies are left alone.
 */
function powertoysBackslashCopiedPathsInMainWorld() {
  let picked = { at: 0, text: "" };
  let note = (target) => {
    let item = target?.closest?.('[role="menuitem"], [role="option"], button, a, li') ?? target;
    picked = { at: Date.now(), text: String(item?.innerText ?? item?.textContent ?? "").trim().slice(0, 80) };
  };
  for (let type of ["pointerup", "click"]) {
    document.addEventListener(type, (event) => note(event.target), true);
  }
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") {
        note(document.activeElement);
      }
    },
    true,
  );
  let prototype = window.Clipboard?.prototype;
  let writeText = prototype?.writeText;
  if (!writeText) {
    return;
  }
  prototype.writeText = function (text) {
    if (
      typeof text === "string" &&
      document.documentElement.dataset.ptCopyPathBackslashes === "1" &&
      Date.now() - picked.at < 2000 &&
      /\bcopy\b.*\bpath\b/i.test(picked.text) &&
      /^(?:[A-Za-z]:\/|\/\/[^/])/.test(text) &&
      !/[\r\n]/.test(text)
    ) {
      text = text.replace(/\//g, "\\");
    }
    return writeText.call(this, text);
  };
}

/** Runs in the page's main world (contextBridge.executeInMainWorld); must not use anything outside itself. */
function powertoysMainWorldOperation(operation, marker, argument) {
  let target = marker ? document.querySelector(`[data-powertoys-target="${marker}"]`) : null;
  let fiberOf = (node) => {
    let key = node && Object.keys(node).find((name) => name.startsWith("__reactFiber$"));
    return key ? node[key] : null;
  };
  let paneProps = (node) => {
    for (let fiber = fiberOf(node), depth = 0; fiber && depth < 150; fiber = fiber.return, depth++) {
      let props = fiber.memoizedProps;
      if (props && Array.isArray(props.entries) && typeof props.sessionId === "string") {
        return props;
      }
    }
    return null;
  };
  let scrollHandles = () => {
    let root = fiberOf(target);
    while (root?.return) {
      root = root.return;
    }
    let found = [];
    let stack = root ? [root] : [];
    while (stack.length) {
      let fiber = stack.pop();
      let props = fiber.memoizedProps;
      if (props && typeof props.scrollToEntry === "function" && props.sessionRef) {
        found.push(props);
      }
      for (let child = fiber.child; child; child = child.sibling) {
        stack.push(child);
      }
    }
    return found;
  };
  let textOf = (entry) =>
    (entry.items ?? [])
      .filter((item) => item?.kind === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n\n");
  if (operation === "titles") {
    let titles = {};
    for (let handle of scrollHandles()) {
      let meta = handle.messagesInput?.meta;
      if (meta && typeof meta.id === "string" && typeof meta.title === "string" && meta.title) {
        titles[meta.id] = meta.title;
      }
    }
    return titles;
  }
  if (operation === "conversationRows") {
    let root = fiberOf(document.getElementById("root")?.firstElementChild ?? target);
    while (root?.return) {
      root = root.return;
    }
    let rows = new Map();
    let stack = root ? [root] : [];
    while (stack.length) {
      let fiber = stack.pop();
      let all = fiber.memoizedProps?.ctx?.allRows;
      if (Array.isArray(all)) {
        for (let row of all) {
          let kind = row?.ref?.kind;
          let id = row?.ref?.id;
          if (typeof kind === "string" && typeof id === "string" && !rows.has(`${kind}:${id}`)) {
            rows.set(`${kind}:${id}`, {
              kind,
              id,
              title: String(row.title ?? ""),
              isStarred: row.isStarred === true,
              isRunning: row.isRunning === true || row.isResponding === true,
              pending: row.hasPendingApproval === true,
              unread: row.isUnread === true,
              liveStatus: String(row.liveStatus ?? ""),
              updatedAt: Number(row.updatedAtMs) || 0,
              hasError: row.hasError === true,
              project: (() => {
                let data = row.source?.data;
                let repo = data?.repoInfo;
                let folder = typeof data?.cwd === "string" ? data.cwd : "";
                if (repo?.owner && repo?.name) {
                  return { key: `${repo.owner}/${repo.name}`.toLowerCase(), name: String(repo.name), folder };
                }
                // E:/x and E:\x are one project (a session a claude:// link started can have either).
                if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(folder)) {
                  folder = folder.replace(/\//g, "\\").replace(/(?<!^[A-Za-z]:)\\+$/, "");
                }
                return folder ? { key: folder.toLowerCase(), name: folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop(), folder } : null;
              })(),
            });
          }
        }
      }
      for (let child = fiber.child; child; child = child.sibling) {
        stack.push(child);
      }
    }
    return [...rows.values()];
  }
  if (operation === "openPeek") {
    for (let fiber = fiberOf(target), depth = 0; fiber && depth < 30; fiber = fiber.return, depth++) {
      let props = fiber.memoizedProps;
      if (props && "data-peek-owner" in props && typeof props.onPointerEnter === "function" && fiber.stateNode instanceof Element) {
        let rect = target.getBoundingClientRect();
        let at = (x) => ({ clientX: x, clientY: rect.top + rect.height / 2, pointerType: "mouse" });
        props.onPointerLeave?.({ pointerType: "mouse", nativeEvent: new PointerEvent("pointerleave", at(rect.right + 400)) });
        props.onPointerEnter({ currentTarget: fiber.stateNode, target, pointerType: "mouse", nativeEvent: new PointerEvent("pointerenter", at(rect.left + 4)) });
        return true;
      }
    }
    return false;
  }
  if (operation === "menuFilePath") {
    // The Open-in menu's component has the file's path in its props (React keeps a portal's parents).
    for (let fiber = fiberOf(target), depth = 0; fiber && depth < 80; fiber = fiber.return, depth++) {
      let props = fiber.memoizedProps;
      for (let key of ["path", "filePath", "absolutePath"]) {
        if (props && typeof props[key] === "string" && /^([A-Za-z]:[\\/]|\\\\|\/)/.test(props[key])) {
          return props[key];
        }
      }
    }
    return null;
  }
  if (operation === "toggleTasks") {
    // The session pane store is a context value above the pane's own controls.
    for (let fiber = fiberOf(target), depth = 0; fiber && depth < 500; fiber = fiber.return, depth++) {
      let value = fiber.memoizedProps?.value;
      for (let store of [value, value?.store]) {
        try {
          let state = typeof store?.getState === "function" ? store.getState() : null;
          if (state && typeof state.toggleSidePane === "function") {
            state.toggleSidePane("tasks");
            return true;
          }
        } catch {}
      }
    }
    return false;
  }
  let props = target ? paneProps(target) : null;
  if (operation === "pane") {
    return props ? { sessionId: props.sessionId } : null;
  }
  if (operation === "entries") {
    return props
      ? props.entries.map((entry) => ({
          id: String(entry.id),
          fromUser: entry.author === "user",
          text: textOf(entry),
          turnEnded: entry.turnEnded === true,
          at: Date.parse(entry.timestamp ?? "") || 0,
        }))
      : null;
  }
  if (operation === "entryTime") {
    let entry = props?.entries.find((candidate) => String(candidate.id) === argument);
    return entry ? Date.parse(entry.timestamp ?? "") || 0 : 0;
  }
  if (operation === "scrollTo") {
    if (!props || !props.entries.some((entry) => String(entry.id) === argument)) {
      return false;
    }
    let handles = scrollHandles();
    let handle = handles.find((candidate) => (candidate.sessionRef?.current ?? candidate.sessionRef)?.id === props.sessionId) ?? null;
    if (!handle) {
      return false;
    }
    handle.scrollToEntry(argument, "smooth", { flash: true });
    return true;
  }
  return null;
}

if (isTrustedClaudeOriginTopFrameForSettings()) {
  try {
    powertoysPageMain();
  } catch (caught) {
    console.error("[powertoys] page module failed to start", caught);
  }
}
