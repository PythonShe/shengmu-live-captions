(() => {
  // 5 -> 6 (0.5.5): stale-slot rework (the previous translation stays at full
  // brightness and a corner dot marks the wait). 6 -> 7: the wheel listener is
  // bound only while the pointer is over the captions. 7 -> 8: caption rows
  // arrive as deltas. 8 -> 9: status and mode labels go through chrome.i18n.
  // 9 -> 10: eased shell height and the one-line English slot. 10 -> 11: the
  // broadcast visual restyle and the dimmed uncommitted tail inside .source.
  // An instance of an older version is rebuilt, not reused.
  const OVERLAY_VERSION = 11;
  const existing = globalThis.__shengmuCaptionOverlay;
  if (existing?.version === OVERLAY_VERSION && existing.refresh) {
    existing.refresh();
    return;
  }
  // A leftover overlay from an older injection still holds window-level
  // listeners; retire it before this instance binds its own.
  existing?.teardown?.();

  const DEFAULT_SETTINGS = {
    displayMode: "bilingual",
    fontSize: 34,
    opacity: 0.86,
    overlayEnabled: true
  };
  const MODES = ["bilingual", "dual", "chinese", "english"];
  const POSITION_KEY = "overlayPositions";

  let settings = { ...DEFAULT_SETTINGS };
  let runtimeState = null;
  let host = null;
  let shadow = null;
  let stage = null;
  let stack = null;
  let shell = null;
  let sourceElement = null;
  let translationElement = null;
  let previousElement = null;
  let historyElement = null;
  let historyListElement = null;
  let chipElement = null;
  let statusElement = null;
  let modeButton = null;
  let idleTimer = null;
  let awaitingDotTimer = null;
  let awaitingSince = 0;
  let positionStore = {};
  let positionPending = false;
  let dragState = null;
  let sizeObserver = null;
  let shellWidthPx = 0;
  let shellHeightPx = 0;
  let shellShrinkTimer = 0;
  let shellShrinkTransitionTimer = 0;
  let shellResizeTimer = 0;
  let shellWidthSettleTimer = 0;
  let measureContext = null;
  let stageRectCache = null;
  let historyRectCache = null;
  let lastPanelRect = null;

  // Wheel-up scrollback: historyLog is a rolling log of finished lines.
  // The panel is tail-follow: it always shows the newest `scrollBack` lines, so
  // a new sentence slides in at the bottom and the oldest visible row slides out
  // at the top. The wheel only changes how many rows are kept.
  const HISTORY_LIMIT = 60;
  const MAX_SCROLLBACK = 40;
  const WHEEL_STEP_PX = 48;
  const WHEEL_COOLDOWN_MS = 700;
  const IDLE_FADE_MS = 3500;
  // Width policy for the caption box: hugging text is the point, but a frame
  // that resizes on every streamed token is worse than a wide one. Growth is
  // immediate, shrinking waits for the text to settle.
  const SHELL_WIDTH_MIN_PX = 240;
  const SHELL_WIDTH_MAX_PX = 860;
  const SHELL_WIDTH_VIEWPORT_RATIO = 0.68;
  const SHELL_SHRINK_DELAY_MS = 420;
  // Canvas `measureText` and the real DOM layout disagree by a few pixels on
  // mixed CJK/Latin, punctuation squeeze and bold serif spacing. Without a
  // margin the target width lands just under the text and wraps it.
  const SHELL_WIDTH_SLACK_PX = 12;
  const SHELL_WIDTH_TRANSITION_MS = 170;
  // The CSS transition is `height 160ms`; the class that keeps the slots from
  // shrinking is held 40 ms longer so it can never end the animation early.
  const SHELL_HEIGHT_RESIZE_LOCK_MS = 200;
  // A line is 36-47 px, so anything under two pixels is sub-pixel noise from
  // the measured text boxes, not a wrap; re-targeting on it would only toggle
  // the easing class and keep the slots out of their default flex behaviour.
  const SHELL_HEIGHT_EPSILON_PX = 2;
  // overlay-history.js ships in the same injection list and must run first. An
  // older worker build injects content-overlay.js on its own, and dereferencing
  // the missing helper used to abort this whole script, so the page overlay
  // never appeared at all. Fall back to a log-only shim that keeps live
  // captions working, and delegate history syncing at call time so a later
  // injection of overlay-history.js restores scrollback without a rebuild.
  const HISTORY_API = globalThis.ShengmuOverlayHistory || {
    createHistoryLog(limit) {
      return {
        limit: Math.max(1, Number(limit) || 1),
        entries: [],
        byId: new Map()
      };
    },
    resetHistoryLog(log) {
      if (!log) return;
      log.entries.length = 0;
      log.byId.clear();
    },
    syncHistoryLog(log, lines) {
      const api = globalThis.ShengmuOverlayHistory;
      return api ? api.syncHistoryLog(log, lines) : false;
    },
    // Without overlay-history.js there is nothing to reuse, so the degraded
    // panel re-creates its rows (still correct, just not incremental). The
    // removed list stays honest, otherwise the nodes of rows that slid out
    // would pile up outside the plan's order.
    planHistoryRows(previousIds, nextIds) {
      const api = globalThis.ShengmuOverlayHistory;
      if (api) return api.planHistoryRows(previousIds, nextIds);
      const previous = Array.isArray(previousIds) ? previousIds : [];
      const next = Array.isArray(nextIds) ? nextIds : [];
      const nextSet = new Set(next);
      return {
        order: [...next],
        added: [...next],
        removed: previous.filter((id) => !nextSet.has(id))
      };
    }
  };
  if (!globalThis.ShengmuOverlayHistory) {
    console.warn(
      "声幕浮层：缺少 overlay-history.js，滚动回看已降级（请在 chrome://extensions 重新加载扩展）"
    );
  }
  const historyLog = HISTORY_API.createHistoryLog(HISTORY_LIMIT);
  // Live rows currently in the panel, oldest first; parallel to the rendered
  // `.history-line` nodes so a merge can reuse them.
  const scrollbackRows = [];
  let scrollBack = 0;
  let wheelAccum = 0;
  let wheelCooldownUntil = 0;
  let syncedLinesRef = null;
  let windowListenersBound = false;
  let wheelListenerBound = false;
  // Last pointer position seen by the passive tracker, so the wheel binding can
  // be re-evaluated when the captions move under a stationary pointer.
  let lastPointer = null;

  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function siteKey() {
    return location.hostname || "local";
  }

  // chrome.i18n; this classic script cannot import ui/i18n.js.
  function t(key, ...params) {
    return chrome.i18n.getMessage(key, params.map((param) => String(param ?? ""))) || key;
  }

  // For catalog text placed in the shadow root's markup.
  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  }

  // Both return message keys, mirrored by ui-model.js (tests compare them).
  function currentModeLabel() {
    return {
      bilingual: "display_mode_short_bilingual",
      dual: "display_mode_short_dual",
      chinese: "display_mode_short_chinese",
      english: "display_mode_short_english"
    }[settings.displayMode] || "display_mode_short_bilingual";
  }

  function statusLabel() {
    if (!runtimeState?.active) {
      return runtimeState?.status === "incomplete" ? "overlay_status_incomplete" : "overlay_status_stopped";
    }
    if (runtimeState.status === "reconnecting") return "overlay_status_reconnecting";
    if (runtimeState.status === "starting") return "overlay_status_starting";
    if (runtimeState.status === "error") return "overlay_status_error";
    if (runtimeState.wsConnected) return "overlay_status_live";
    return "overlay_status_waiting";
  }

  function buildOverlay() {
    // Extension reloads can leave a detached isolated-world host behind. An
    // older build has no teardown() and its fullscreenchange handler can still
    // re-append its host, so hide stale hosts as well as removing them.
    retireStaleHosts();
    // A rebuild normally arrives through teardown(), but the timers are cleared
    // here as well so a reused instance cannot leave one pointing at a dead node.
    for (const timer of [shellShrinkTimer, shellShrinkTransitionTimer,
                         shellResizeTimer, shellWidthSettleTimer]) {
      if (timer) clearTimeout(timer);
    }
    shellShrinkTimer = 0;
    shellShrinkTransitionTimer = 0;
    shellResizeTimer = 0;
    shellWidthSettleTimer = 0;
    host = document.createElement("div");
    host.id = "shengmu-caption-host";
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;" +
      "pointer-events:none;contain:layout style;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .stage {
          --translation-size: 34px;
          --overlay-opacity: 0.86;
          /* Broadcast-style typography: a modern sans stack survives the chroma
             subsampling and bitrate squeeze of a livestream, while a serif
             falls back to SimSun on Windows and its 1px horizontals break up. */
          --caption-sans: "HarmonyOS Sans SC", "MiSans", "PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
          --caption-latin: Inter, "Segoe UI", "SF Pro Text", Roboto, "Helvetica Neue", Arial, sans-serif;
          /* Closed outlines instead of -webkit-text-stroke: a stroke eats into
             the glyph fill and fattens the letterforms, these shadows only add
             a black moat on all four sides, so the text stays crisp on a fully
             transparent background over bright gameplay. */
          --caption-outline-strong: -1px -1px 0 rgb(0 0 0 / 0.94), 1px -1px 0 rgb(0 0 0 / 0.94), -1px 1px 0 rgb(0 0 0 / 0.94), 1px 1px 0 rgb(0 0 0 / 0.94), 0 -1px 0 rgb(0 0 0 / 0.94), 0 1px 0 rgb(0 0 0 / 0.94), -1px 0 0 rgb(0 0 0 / 0.94), 1px 0 0 rgb(0 0 0 / 0.94), 0 2px 10px rgb(0 0 0 / 0.85);
          --caption-outline-soft: -1px -1px 0 rgb(0 0 0 / 0.9), 1px -1px 0 rgb(0 0 0 / 0.9), -1px 1px 0 rgb(0 0 0 / 0.9), 1px 1px 0 rgb(0 0 0 / 0.9), 0 1px 6px rgb(0 0 0 / 0.8);
          position: fixed;
          left: 50%;
          bottom: 8vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          /* Upper bound only. The box that is actually drawn is .caption-shell,
             which hugs its text inside this anchoring stage. */
          width: min(68vw, 860px);
          min-width: 260px;
          transform: translateX(-50%);
          color: #f1f5f9;
          font-family: var(--caption-sans);
          pointer-events: none;
          transition: opacity 180ms ease, transform 180ms ease;
        }
        .stage.dragged {
          transform: none;
        }
        .stage[hidden] { display: none; }
        .caption-stack {
          position: relative;
          align-self: center;
          width: fit-content;
          max-width: 100%;
        }
        /* Growing must land in the same frame as the new text: a transition
           keeps the frame narrower than its text for ~170 ms, so the sentence
           wraps to 2 lines and snaps back to 1 line when the width arrives.
           Only the delayed shrink (scheduleShellShrink) animates. */
        .caption-stack.shrinking {
          transition: width 170ms ease-out;
        }
        .history {
          position: absolute;
          left: 0;
          right: 0;
          bottom: calc(100% + 8px);
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 40vh;
          padding: 14px 22px 12px;
          overflow: hidden;
          border: 1px solid rgb(255 255 255 / calc(0.11 * var(--overlay-opacity)));
          border-radius: 14px;
          /* The history panel is read, not watched, so it keeps a readable floor
             even when the user pulls the background almost fully transparent. */
          background:
            linear-gradient(180deg, rgb(14 18 26 / max(0.62, var(--overlay-opacity))), rgb(8 11 16 / max(0.58, var(--overlay-opacity))));
          box-shadow: 0 16px 40px rgb(0 0 0 / calc(0.36 * var(--overlay-opacity)));
          backdrop-filter: blur(calc(11px * max(0.4, var(--overlay-opacity))));
        }
        .history[hidden] { display: none; }
        .history-list {
          display: flex;
          flex: 0 1 auto;
          flex-direction: column;
          gap: 7px;
          min-height: 0;
          overflow: hidden;
        }
        .history-list.overflowing {
          -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 24px);
          mask-image: linear-gradient(to bottom, transparent 0, #000 24px);
        }
        .history-meta {
          flex: none;
          margin-top: 2px;
          padding-top: 7px;
          border-top: 1px solid rgb(180 212 244 / 0.14);
          color: rgb(203 213 225 / 0.72);
          font: 700 10px/1.5 var(--caption-sans);
          letter-spacing: 0.06em;
          text-align: right;
          text-shadow: 0 1px 2px #000;
        }
        .history-line {
          display: flex;
          flex: none;
          flex-direction: column;
          gap: 2px;
        }
        .history-source {
          display: block;
          max-height: 1.4em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: rgb(180 212 244 / 0.92);
          font-family: var(--caption-latin);
          font-size: clamp(10px, calc(var(--translation-size) * 0.38), 20px);
          font-weight: 500;
          line-height: 1.35;
          text-shadow: var(--caption-outline-soft);
        }
        .history-translation {
          display: -webkit-box;
          max-height: 2.8em;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
          color: #f1f5f9;
          font-family: var(--caption-sans);
          font-size: clamp(12px, calc(var(--translation-size) * 0.6), 30px);
          font-weight: 600;
          line-height: 1.4;
          text-shadow: var(--caption-outline-soft);
        }
        .history-translation:empty,
        .history-source:empty { display: none; }
        .caption-shell {
          position: relative;
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          width: 100%;
          /* With a large font on a short window the slots could still add up to
             more than the viewport. Cap the shell and let the older slots
             shrink first, so the current translation always stays readable. */
          max-height: min(70vh, 680px);
          /* The shell height follows its text; keeping it explicit lets CSS
             ease the 1-line <-> 2-line jump instead of snapping the top
             border (see syncShellHeight). */
          transition: height 160ms cubic-bezier(0.22, 1, 0.36, 1);
          /* Symmetric paddings keep the bar lean: it sits on top of gameplay,
             so every pixel of height it does not use is a pixel of scene the
             viewer still sees. */
          padding: 14px 22px;
          overflow: hidden;
          /* Every chrome layer fades with the same opacity variable, so pulling
             the slider down reaches "text only" instead of a glass slab. The
             neutral obsidian base carries no hue of its own, so it does not
             tint the gameplay behind it the way the old green did. */
          border: 1px solid rgb(255 255 255 / calc(0.11 * var(--overlay-opacity)));
          border-radius: 14px;
          background:
            linear-gradient(180deg, rgb(14 18 26 / var(--overlay-opacity)), rgb(8 11 16 / min(1, calc(var(--overlay-opacity) + 0.05))));
          box-shadow:
            0 20px 54px rgb(0 0 0 / calc(0.42 * var(--overlay-opacity))),
            inset 0 1px rgb(255 255 255 / calc(0.07 * var(--overlay-opacity)));
          backdrop-filter: blur(calc(11px * var(--overlay-opacity)));
        }
        /* One ASR segment can cover minutes of speech. Every caption slot is
           therefore a tail-aligned window of N lines: the newest lines stay
           visible, the overflow is clipped at the top and faded out, so an
           oversized segment can no longer grow the box over the whole page. */
        .prev-translation,
        .source,
        .translation {
          display: none;
          flex-direction: column;
          justify-content: flex-end;
          overflow: hidden;
        }
        .prev-translation.visible,
        .source.visible,
        .translation.visible { display: flex; }
        .caption-text {
          display: block;
          flex: none;
          width: 100%;
        }
        .prev-translation,
        .source {
          flex: 0 3 auto;
          min-height: 0;
        }
        .translation {
          flex: 0 1 auto;
          min-height: 0;
        }
        /* While the height eases, the slots have to keep their natural size: a
           shrinking flex item moves the text it holds, which is exactly the jump
           the easing is meant to remove. */
        .caption-shell.resizing .prev-translation,
        .caption-shell.resizing .translation {
          flex: 0 0 auto;
        }
        .prev-translation.overflowing,
        .translation.overflowing {
          -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
          mask-image: linear-gradient(to bottom, transparent 0, #000 1.1em);
        }
        .prev-translation {
          max-height: 2.68em;
          margin-bottom: 7px;
          /* Same language as the current line, but one step down the cool
             grey scale: the time ordering reads at a glance without the old
             opacity drop that made the line look disabled. */
          color: rgb(203 213 225 / 0.88);
          font-family: var(--caption-sans);
          font-size: calc(var(--translation-size) * 0.8);
          font-weight: 600;
          letter-spacing: 0.015em;
          line-height: 1.34;
          text-shadow: var(--caption-outline-soft);
          white-space: pre-wrap;
        }
        .source {
          /* One fixed line: the recogniser appends words to the same sentence
             for seconds, so a two-line English slot changed the box height on
             almost every update. The slot is a tail-aligned window now and the
             overflow is clipped (and faded) on the left. */
          flex: 0 0 auto;
          max-height: 1.38em;
          margin-bottom: 7px;
          /* Cross-axis alignment inside the column flex: the text keeps its
             natural width and spills to the left, where it is clipped. */
          align-items: flex-end;
          white-space: nowrap;
          /* Cool track vs warm-white Chinese: the eye splits the two lines by
             hue in a glance, and 92% opacity keeps the letters from picking up
             the colour of the footage underneath. */
          color: rgb(180 212 244 / 0.92);
          font-family: var(--caption-latin);
          font-size: clamp(13px, calc(var(--translation-size) * 0.6), 34px);
          font-weight: 500;
          letter-spacing: 0.012em;
          line-height: 1.38;
          text-shadow: var(--caption-outline-soft);
        }
        .source .caption-text {
          flex: 0 0 auto;
          width: auto;
          max-width: none;
          white-space: nowrap;
        }
        /* The words the recogniser is still revising sit one step down in
           opacity, so the committed prefix reads as settled text and the tail
           reads as a work in progress (ReaLingo calls this the stash). */
        .source .source-stash {
          color: rgb(180 212 244 / 0.56);
        }
        .source.overflowing {
          -webkit-mask-image: linear-gradient(to right, transparent 0, #000 2em);
          mask-image: linear-gradient(to right, transparent 0, #000 2em);
        }
        .translation {
          max-height: 4.14em;
          color: #ffffff;
          font-family: var(--caption-sans);
          font-size: var(--translation-size);
          font-weight: 700;
          letter-spacing: 0.015em;
          line-height: 1.38;
          text-shadow: var(--caption-outline-strong);
          white-space: pre-wrap;
        }
        .translation.pending {
          color: rgb(180 212 244 / 0.68);
          font-size: calc(var(--translation-size) * 0.72);
          font-weight: 500;
          letter-spacing: 0.08em;
        }
        .translation.failed {
          color: rgba(255, 186, 162, 0.9);
        }
        /* A sentence whose translation has not arrived yet keeps the previous
           translation on screen at full brightness: dimming the whole slot made
           every sentence flash grey while the next one was being translated.
           The wait is signalled by a small corner dot instead (see
           .caption-shell[data-awaiting="1"]::before), so the Chinese text the
           reader is looking at never changes contrast. */
        .translation.stale {
          color: #ffffff;
        }
        .caption-shell[data-awaiting="1"]::before {
          position: absolute;
          right: 14px;
          bottom: 8px;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: rgb(180 212 244 / calc(0.3 + var(--overlay-opacity) * 0.45));
          box-shadow: 0 0 6px rgb(180 212 244 / calc(0.2 * var(--overlay-opacity)));
          content: "";
          animation: shengmu-awaiting 2.4s ease-in-out infinite;
        }
        @keyframes shengmu-awaiting {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 0.95; }
        }
        @media (prefers-reduced-motion: reduce) {
          .caption-shell[data-awaiting="1"]::before {
            animation: none;
            opacity: 0.75;
          }
        }
        .drag-handle {
          position: absolute;
          top: -9px;
          left: 50%;
          z-index: 3;
          width: 68px;
          height: 18px;
          padding: 0;
          transform: translateX(-50%);
          border: 0;
          background: transparent;
          pointer-events: auto;
          cursor: grab;
          opacity: 0;
          transition: opacity 160ms ease;
        }
        .drag-handle::before {
          display: block;
          width: 42px;
          height: 4px;
          margin: 5px auto 0;
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.64);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
          content: "";
        }
        .stage:hover .drag-handle,
        .stage:focus-within .drag-handle { opacity: 1; }
        .drag-handle:active { cursor: grabbing; }
        .toolbar {
          position: absolute;
          top: -35px;
          right: 0;
          z-index: 2;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 5px 6px;
          border: 1px solid rgb(255 255 255 / 0.13);
          border-radius: 8px;
          background: rgb(10 13 18 / 0.86);
          box-shadow: 0 7px 22px rgba(0, 0, 0, 0.28);
          opacity: 0;
          pointer-events: auto;
          transform: translateY(4px);
          transition: opacity 150ms ease, transform 150ms ease;
          backdrop-filter: blur(9px);
        }
        .stage:hover .toolbar,
        .stage:focus-within .toolbar {
          opacity: 1;
          transform: translateY(0);
        }
        .toolbar button {
          min-width: 28px;
          height: 25px;
          padding: 0 7px;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: rgb(203 213 225 / 0.8);
          font: 11px/25px var(--caption-sans);
          cursor: pointer;
        }
        .toolbar button:hover {
          background: rgba(255, 255, 255, 0.1);
          color: #ffffff;
        }
        .live-chip {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 0 6px;
          color: rgb(203 213 225 / 0.72);
          font: 700 9px/25px Bahnschrift, sans-serif;
          letter-spacing: 0.1em;
        }
        .live-chip::before {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #d85236;
          box-shadow: 0 0 0 3px rgba(216, 82, 54, 0.14);
          content: "";
        }
        .stage.ended .live-chip::before { background: #7f877f; box-shadow: none; }
        .status-text {
          min-width: 38px;
          padding-right: 4px;
          color: rgb(180 212 244 / 0.86);
          font: 10px/25px var(--caption-sans);
          text-align: center;
        }
        .divider {
          width: 1px;
          height: 13px;
          margin: 0 2px;
          background: rgba(255, 255, 255, 0.13);
        }
        .translation-error {
          display: none;
          margin-top: 6px;
          color: #ffd0c8;
          font: 10px/1.4 "Microsoft YaHei UI", sans-serif;
        }
        .translation-error.visible { display: block; }
        @media (max-width: 720px) {
          .stage { width: 92vw; min-width: 0; bottom: 5vh; }
          .caption-shell { padding: 12px 16px; }
          .toolbar { right: 50%; transform: translate(50%, 4px); }
          .stage:hover .toolbar,
          .stage:focus-within .toolbar { transform: translate(50%, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          * { transition-duration: 0.01ms !important; }
        }
      </style>
      <section class="stage" aria-live="polite" hidden>
        <button class="drag-handle" type="button" aria-label="${escapeHtml(t("overlay_drag"))}"></button>
        <div class="history" hidden>
          <div class="history-list"></div>
          <div class="history-meta"></div>
        </div>
        <div class="caption-stack">
          <div class="toolbar" role="toolbar" aria-label="${escapeHtml(t("overlay_toolbar"))}">
            <span class="live-chip">声幕</span>
            <span class="status-text"></span>
            <span class="divider"></span>
            <button type="button" data-action="mode" title="${escapeHtml(t("overlay_mode_title"))}">${escapeHtml(t(currentModeLabel()))}</button>
            <button type="button" data-action="smaller" title="${escapeHtml(t("overlay_smaller"))}">A−</button>
            <button type="button" data-action="larger" title="${escapeHtml(t("overlay_larger"))}">A＋</button>
            <button type="button" data-action="monitor" title="${escapeHtml(t("overlay_monitor_title"))}">${escapeHtml(t("overlay_monitor"))}</button>
            <button type="button" data-action="close" title="${escapeHtml(t("overlay_close_title"))}">×</button>
          </div>
          <div class="caption-shell">
            <div class="prev-translation"><span class="caption-text"></span></div>
            <div class="source"><span class="caption-text"></span></div>
            <div class="translation" role="status"><span class="caption-text"></span></div>
            <div class="translation-error"></div>
          </div>
        </div>
      </section>
    `;
    stage = shadow.querySelector(".stage");
    stack = shadow.querySelector(".caption-stack");
    shell = shadow.querySelector(".caption-shell");
    sourceElement = shadow.querySelector(".source");
    translationElement = shadow.querySelector(".translation");
    previousElement = shadow.querySelector(".prev-translation");
    historyElement = shadow.querySelector(".history");
    historyListElement = shadow.querySelector(".history-list");
    chipElement = shadow.querySelector(".history-meta");
    statusElement = shadow.querySelector(".status-text");
    modeButton = shadow.querySelector('[data-action="mode"]');
    mount();
    bindEvents();
    bindWindowListeners();
    watchSize();
    clearScrollbackRows();
    shellWidthPx = 0;
    shellHeightPx = 0;
    stageRectCache = null;
    historyRectCache = null;
  }

  function mount() {
    if (!host) return;
    const fullscreenElement = document.fullscreenElement;
    const target =
      fullscreenElement && fullscreenElement.tagName !== "VIDEO"
        ? fullscreenElement
        : document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
    stageRectCache = null;
    historyRectCache = null;
  }

  function bindEvents() {
    shadow.querySelector(".drag-handle").addEventListener("pointerdown", (event) => {
      const rect = stage.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      stage.classList.add("dragged");
      event.preventDefault();
    });
    shadow.querySelector(".drag-handle").addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const rect = stage.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(window.innerWidth - rect.width - 8, event.clientX - dragState.offsetX)
      );
      const top = Math.max(
        8,
        Math.min(window.innerHeight - rect.height - 8, event.clientY - dragState.offsetY)
      );
      stage.style.left = `${left}px`;
      stage.style.top = `${top}px`;
      stage.style.bottom = "auto";
      stageRectCache = null;
      historyRectCache = null;
    });
    const endDrag = (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const rect = stage.getBoundingClientRect();
      const widthRange = Math.max(1, window.innerWidth - rect.width);
      const heightRange = Math.max(1, window.innerHeight - rect.height);
      const key = siteKey();
      const position = {
        x: rect.left / widthRange,
        y: rect.top / heightRange
      };
      positionStore[key] = position;
      // Other tabs write their own sites into the same key; merging into a
      // fresh read keeps their drags instead of replaying our stale snapshot.
      void chrome.storage.local.get(POSITION_KEY).then((values) => {
        positionStore = { ...(values[POSITION_KEY] || {}), [key]: position };
        return chrome.storage.local.set({ [POSITION_KEY]: positionStore });
      });
      dragState = null;
      stageRectCache = null;
      historyRectCache = null;
    };
    shadow.querySelector(".drag-handle").addEventListener("pointerup", endDrag);
    shadow.querySelector(".drag-handle").addEventListener("pointercancel", endDrag);

    shadow.querySelector(".toolbar").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "mode") {
        const next = MODES[(MODES.indexOf(settings.displayMode) + 1) % MODES.length];
        void saveSettings({ displayMode: next });
      } else if (action === "smaller" || action === "larger") {
        const delta = action === "smaller" ? -2 : 2;
        void saveSettings({
          fontSize: Math.max(20, Math.min(64, settings.fontSize + delta))
        });
      } else if (action === "monitor") {
        void chrome.runtime.sendMessage({
          target: "background",
          type: "open-monitor"
        });
      } else if (action === "close") {
        void chrome.runtime.sendMessage({
          target: "background",
          type: "hide-overlay"
        });
      }
    });
  }

  function retireStaleHosts() {
    document.querySelectorAll("#shengmu-caption-host").forEach((staleHost) => {
      if (staleHost === host) return;
      // display:none keeps a re-mounted stale overlay invisible and leaves it
      // with a zero-size hit box, so it cannot swallow wheel events.
      staleHost.style.display = "none";
      staleHost.remove();
    });
  }

  function handleFullscreenChange() {
    mount();
    applyStoredPosition();
    // A 0.4.1 instance re-appends its host from its own fullscreenchange
    // handler without asking us; its listener runs first, so sweep again.
    retireStaleHosts();
  }

  // Bound once per overlay instance: the wheel hit test and the position
  // refresh live outside the shadow root, so a later rebuild must not stack a
  // second copy of these listeners. teardown() is the counterpart.
  function bindWindowListeners() {
    if (windowListenersBound) return;
    windowListenersBound = true;
    window.addEventListener("resize", handleWindowResize);
    // The stage is pointer-events:none, so enter/leave events never fire on it
    // and the pointer is tracked with a passive listener instead. A
    // non-passive wheel listener on window blocks compositor scrolling on the
    // whole page, so it is attached only while the pointer is over the
    // captions (see syncWheelBinding).
    window.addEventListener("pointermove", handlePointerMove, {
      capture: true,
      passive: true
    });
    document.addEventListener("fullscreenchange", handleFullscreenChange);
  }

  function handlePointerMove(event) {
    lastPointer = { clientX: event.clientX, clientY: event.clientY };
    syncWheelBinding();
  }

  function setWheelBinding(wanted) {
    if (wanted === wheelListenerBound) return;
    wheelListenerBound = wanted;
    if (wanted) {
      window.addEventListener("wheel", handleWheel, {
        capture: true,
        passive: false
      });
    } else {
      window.removeEventListener("wheel", handleWheel, { capture: true });
    }
  }

  // Attach the blocking wheel listener only while the pointer is over the
  // overlay (or its just-closed history panel during the cooldown).
  function syncWheelBinding() {
    const wanted = Boolean(
      lastPointer &&
        stage &&
        !stage.hidden &&
        host?.isConnected &&
        pointerInsideOverlay(lastPointer)
    );
    setWheelBinding(wanted);
  }

  // Wheel hit tests read layout boxes; ResizeObserver invalidates the cache on
  // any real geometry change, so a scroll burst costs no layout reads.
  function watchSize() {
    if (typeof ResizeObserver !== "function") return;
    if (sizeObserver) sizeObserver.disconnect();
    sizeObserver = new ResizeObserver(() => {
      stageRectCache = null;
      historyRectCache = null;
      syncWheelBinding();
    });
    sizeObserver.observe(stage);
    if (historyElement) sizeObserver.observe(historyElement);
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "save-settings",
        settings: patch
      });
      if (response?.settings) {
        settings = { ...settings, ...response.settings };
        render();
      }
    } catch {
      // The extension may have been reloaded; keep the local visual update.
    }
  }

  async function loadPosition() {
    try {
      const values = await chrome.storage.local.get(POSITION_KEY);
      positionStore = values[POSITION_KEY] || {};
      applyStoredPosition();
    } catch {
      // Position persistence is optional.
    }
  }

  function applyStoredPosition() {
    if (!stage || dragState) return;
    // Any reposition (load, resize, fullscreen) invalidates the wheel hit-test
    // cache, including the default bottom-centred placement.
    stageRectCache = null;
    historyRectCache = null;
    const position = positionStore[siteKey()];
    if (!position) {
      positionPending = false;
      return;
    }
    const rect = stage.getBoundingClientRect();
    // A hidden stage has no layout box; using it as the stage size would place
    // the overlay at the far edge of the viewport. Retry once it is visible.
    if (stage.hidden || rect.width === 0 || rect.height === 0) {
      positionPending = true;
      return;
    }
    positionPending = false;
    const widthRange = Math.max(1, window.innerWidth - rect.width);
    const heightRange = Math.max(1, window.innerHeight - rect.height);
    stage.classList.add("dragged");
    stage.style.left = `${Math.round(Math.max(0, Math.min(1, position.x)) * widthRange)}px`;
    stage.style.top = `${Math.round(Math.max(0, Math.min(1, position.y)) * heightRange)}px`;
    stage.style.bottom = "auto";
    stageRectCache = null;
    historyRectCache = null;
  }

  function applyVisualSettings() {
    if (!stage) return;
    stage.style.setProperty("--translation-size", `${settings.fontSize}px`);
    stage.style.setProperty("--overlay-opacity", String(settings.opacity));
    modeButton.textContent = t(currentModeLabel());
  }

  // Caption text is laid out by the browser, so the target width is measured on
  // a detached canvas instead: the widest visible slot decides how wide the box
  // wants to be. Measuring the DOM would feed the current width back into the
  // next measurement and oscillate.
  function measureSlotWidth(slot) {
    const textNode = slot?.firstElementChild;
    const text = textNode?.textContent || "";
    if (!text) return 0;
    const style = getComputedStyle(textNode);
    measureContext ||= document.createElement("canvas").getContext("2d");
    if (!measureContext) return 0;
    measureContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const spacing = parseFloat(style.letterSpacing) || 0;
    let widest = 0;
    for (const line of text.split("\n")) {
      widest = Math.max(
        widest,
        measureContext.measureText(line).width + spacing * line.length
      );
    }
    return widest;
  }

  function applyShellWidth(width, animate = false) {
    shellWidthPx = width;
    if (!stack) return;
    clearTimeout(shellShrinkTransitionTimer);
    shellShrinkTransitionTimer = 0;
    if (animate) {
      stack.classList.add("shrinking");
      shellShrinkTransitionTimer = setTimeout(() => {
        shellShrinkTransitionTimer = 0;
        stack?.classList.remove("shrinking");
      }, SHELL_WIDTH_TRANSITION_MS);
    } else {
      stack.classList.remove("shrinking");
    }
    stack.style.width = `${width}px`;
  }

  // Target width for the current text, or 0 when there is nothing to measure.
  function measureShellWidth() {
    if (!stack || !shell || !stage || stage.hidden) return 0;
    const style = getComputedStyle(shell);
    const chromeWidth =
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0) +
      (parseFloat(style.borderLeftWidth) || 0) +
      (parseFloat(style.borderRightWidth) || 0);
    let contentWidth = 0;
    for (const slot of [previousElement, sourceElement, translationElement]) {
      if (!slot || !slot.classList.contains("visible")) continue;
      contentWidth = Math.max(contentWidth, measureSlotWidth(slot));
    }
    const limit = Math.min(
      Math.round(window.innerWidth * SHELL_WIDTH_VIEWPORT_RATIO),
      SHELL_WIDTH_MAX_PX
    );
    return Math.min(
      limit,
      Math.max(
        SHELL_WIDTH_MIN_PX,
        Math.ceil(contentWidth + chromeWidth + SHELL_WIDTH_SLACK_PX)
      )
    );
  }

  // A pending shrink must re-measure before it applies: the text may have grown
  // back in the meantime, and applying the old, narrower target would wrap a
  // sentence that already fits.
  function scheduleShellShrink() {
    if (shellShrinkTimer) return;
    shellShrinkTimer = setTimeout(() => {
      shellShrinkTimer = 0;
      const target = measureShellWidth();
      if (!target || target >= shellWidthPx - 1) return;
      applyShellWidth(target, true);
      // The text rewraps while the width eases, so the height measured in this
      // frame belongs to the old width: re-sync once the width has landed, or a
      // sentence that gained a line on the way down stays clipped.
      clearTimeout(shellWidthSettleTimer);
      shellWidthSettleTimer = setTimeout(() => {
        shellWidthSettleTimer = 0;
        syncShellHeight();
        refreshCaptionOverflow();
      }, SHELL_WIDTH_TRANSITION_MS + 30);
    }, SHELL_SHRINK_DELAY_MS);
  }

  // Grow in the same frame the text appears (no transition, see
  // .caption-stack.shrinking), shrink only after the text has stopped changing:
  // a streamed sentence grows every few hundred ms and would otherwise make the
  // frame twitch on every token.
  function syncShellWidth() {
    const wanted = measureShellWidth();
    if (!wanted) return;
    if (wanted > shellWidthPx + 1) {
      clearTimeout(shellShrinkTimer);
      shellShrinkTimer = 0;
      applyShellWidth(wanted);
    } else if (wanted < shellWidthPx - 1) {
      scheduleShellShrink();
    } else {
      clearTimeout(shellShrinkTimer);
      shellShrinkTimer = 0;
    }
  }

  // Overlay caption slots wrap their text in a span so the slot itself can be a
  // fixed-height, bottom-aligned window: the span keeps its natural height and
  // its top is clipped once the text runs past the cap.
  function setCaptionText(element, text) {
    const captionText = element.firstElementChild;
    if (captionText && captionText.textContent !== text) {
      captionText.textContent = text;
    }
    element.classList.toggle("visible", Boolean(text));
  }

  // The English slot carries two tones: the committed row stays at full colour,
  // the words the recogniser is still revising drop to 56 %. Both live inside
  // the same .caption-text so measureSlotWidth keeps reading one text run (its
  // textContent is exactly the string composeLiveSource would have produced).
  let sourceTextKey = "";

  function setSourceText(stable, stash) {
    const node = sourceElement?.firstElementChild;
    if (!node) return;
    const key = `${stable}\u0000${stash}`;
    // `!node.firstChild !== !key` also catches the round trip through the modes
    // that blank the slot (english prints the source in the translation slot):
    // the key is unchanged then, but the children are gone.
    if (key !== sourceTextKey || Boolean(stable || stash) !== Boolean(node.firstChild)) {
      sourceTextKey = key;
      node.textContent = "";
      if (stable) node.appendChild(document.createTextNode(stash ? `${stable} ` : stable));
      if (stash) {
        const tail = document.createElement("span");
        tail.className = "source-stash";
        tail.textContent = stash;
        node.appendChild(tail);
      }
    }
    sourceElement.classList.toggle("visible", Boolean(stable || stash));
  }

  // The shell height follows its text (1 <-> 2 lines several times a minute) and
  // the frame is bottom-anchored, so every change snapped the top border 47 px.
  // Keep the height explicit so CSS can ease it: the natural height is summed
  // from the slot text boxes (which keep their own height even while the shell
  // is mid-animation), and the target is only written when it really changed, so
  // an in-flight transition is retargeted instead of being restarted.
  function measureShellNaturalHeight() {
    const style = getComputedStyle(shell);
    let height =
      (parseFloat(style.paddingTop) || 0) +
      (parseFloat(style.paddingBottom) || 0) +
      (parseFloat(style.borderTopWidth) || 0) +
      (parseFloat(style.borderBottomWidth) || 0);
    for (const slot of [previousElement, sourceElement, translationElement]) {
      if (!slot || !slot.classList.contains("visible")) continue;
      const slotStyle = getComputedStyle(slot);
      const textHeight = slot.firstElementChild?.getBoundingClientRect().height || 0;
      if (!textHeight) continue;
      const cap = parseFloat(slotStyle.maxHeight);
      height += (Number.isFinite(cap) ? Math.min(textHeight, cap) : textHeight) +
        (parseFloat(slotStyle.marginBottom) || 0);
    }
    const errorElement = shadow.querySelector(".translation-error");
    if (errorElement?.classList.contains("visible")) {
      const errorStyle = getComputedStyle(errorElement);
      height += errorElement.getBoundingClientRect().height +
        (parseFloat(errorStyle.marginTop) || 0);
    }
    return height;
  }

  function syncShellHeight() {
    if (!shell || !stage || stage.hidden) return;
    const maxHeight = parseFloat(getComputedStyle(shell).maxHeight);
    const natural = measureShellNaturalHeight();
    const target = Number.isFinite(maxHeight) ? Math.min(natural, maxHeight) : natural;
    const rounded = target ? Math.ceil(target) : 0;
    if (!rounded && !shellHeightPx) return;
    if (rounded && Math.abs(rounded - shellHeightPx) < SHELL_HEIGHT_EPSILON_PX) return;
    shellHeightPx = rounded;
    shell.classList.add("resizing");
    clearTimeout(shellResizeTimer);
    shellResizeTimer = setTimeout(() => {
      shellResizeTimer = 0;
      shell?.classList.remove("resizing");
      refreshCaptionOverflow();
    }, SHELL_HEIGHT_RESIZE_LOCK_MS);
    shell.style.height = rounded ? `${rounded}px` : "";
  }

  // The caption slots clip their overflow, so a long segment would silently
  // lose its first lines. Fade the clipped edge instead of cutting it dry.
  function markCaptionOverflow(...elements) {
    for (const element of elements) {
      if (!element || !element.classList.contains("visible")) {
        element?.classList.remove("overflowing");
        continue;
      }
      const captionText = element.firstElementChild;
      const rect = captionText ? captionText.getBoundingClientRect() : null;
      const clipped =
        Boolean(rect) &&
        element.clientHeight > 0 &&
        // Vertical overflow (clipped lines) and horizontal overflow (the
        // single-line English slot, tail-aligned so the spill is on the left).
        (rect.height - element.clientHeight > 1 ||
          rect.width - element.clientWidth > 1);
      element.classList.toggle("overflowing", clipped);
    }
  }

  function refreshCaptionOverflow() {
    markCaptionOverflow(previousElement, sourceElement, translationElement);
  }

  // A dragged position is stored as a viewport ratio, so a caption that grows
  // later (an oversized ASR segment) can push the box past the bottom edge.
  // Pull it back instead of leaving the newest lines off-screen.
  function keepStageInViewport() {
    if (!stage || stage.hidden || !stage.classList.contains("dragged")) return;
    const rect = stage.getBoundingClientRect();
    const overflowBottom = rect.bottom - window.innerHeight;
    const overflowRight = rect.right - window.innerWidth;
    if (overflowBottom > 0) {
      const top = parseFloat(stage.style.top);
      if (Number.isFinite(top)) {
        stage.style.top = `${Math.max(0, Math.round(top - overflowBottom))}px`;
      }
    }
    if (overflowRight > 0) {
      const left = parseFloat(stage.style.left);
      if (Number.isFinite(left)) {
        stage.style.left = `${Math.max(0, Math.round(left - overflowRight))}px`;
      }
    }
    if (overflowBottom > 0 || overflowRight > 0) {
      stageRectCache = null;
      historyRectCache = null;
    }
  }

  function handleWindowResize() {
    applyStoredPosition();
    syncShellWidth();
    syncShellHeight();
    refreshCaptionOverflow();
  }

  function lineTranslation(line) {
    const value = line?.translation;
    if (typeof value === "string") return clean(value);
    if (value && typeof value === "object") return clean(value.text || "");
    return "";
  }

  // Rolling log of finished lines. The worker caps runtimeState.current.lines,
  // so the overlay keeps its own copy for wheel-up history. The array identity
  // check skips the merge when the worker re-broadcasts an unchanged list.
  function syncHistory() {
    const lines = Array.isArray(runtimeState?.current?.lines)
      ? runtimeState.current.lines
      : [];
    if (lines === syncedLinesRef) return false;
    syncedLinesRef = lines;
    if (lines.length === 0) return false;
    // The worker sends its whole 120-line window; once our 60-line log is full,
    // anything older than its first row would be inserted and trimmed again on
    // every broadcast, so drop it before the string normalisation.
    const retainedFrom =
      historyLog.entries.length >= historyLog.limit
        ? historyLog.entries[0].order
        : 0;
    const normalized = [];
    for (const line of lines) {
      const order = Number(line?.order) || 0;
      if (
        retainedFrom > 0 &&
        order > 0 &&
        order <= retainedFrom &&
        !historyLog.byId.has(line.id)
      ) {
        continue;
      }
      const source = clean(line?.source);
      const translation = lineTranslation(line);
      if (!source && !translation) continue;
      normalized.push({
        id: line.id || `${line.order ?? ""}:${source.slice(0, 32)}`,
        order,
        source,
        translation
      });
    }
    return HISTORY_API.syncHistoryLog(historyLog, normalized);
  }

  function scrollbackEntries() {
    const entries = historyLog.entries.filter(
      (entry) => entry.translation || entry.source
    );
    const caption = latestCaption();
    const last = entries.at(-1);
    if (!last) return [];
    const sameAsLive = caption.lineId
      ? last.id === caption.lineId
      : last.translation === caption.translation &&
        last.source === caption.source;
    return sameAsLive ? entries.slice(0, -1) : entries;
  }

  function previousTranslation(caption) {
    const entries = historyLog.entries.filter((entry) => entry.translation);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (caption.lineId && entry.id === caption.lineId) continue;
      if (entry.translation === caption.translation) continue;
      return entry.translation;
    }
    return "";
  }

  // Tail-follow: the panel shows the newest `scrollBack` usable rows and nothing
  // is frozen, so a new sentence slides in at the bottom while the oldest visible
  // row slides out at the top. The wheel only changes how many rows are kept.
  function maxScrollBack() {
    return Math.min(scrollbackEntries().length, MAX_SCROLLBACK);
  }

  function openScrollback() {
    // Nothing to show yet: the reader may retry once lines land.
    if (scrollBack > 0) return true;
    if (scrollbackEntries().length === 0) return false;
    wheelAccum = 0;
    return true;
  }

  function closeScrollback() {
    if (scrollBack === 0 && scrollbackRows.length === 0) return;
    scrollBack = 0;
    wheelAccum = 0;
    renderScrollback();
  }

  function historyRowText(entry) {
    const mode = settings.displayMode;
    const source = mode === "bilingual" ? entry.source : "";
    let primary = entry.translation;
    // Never print the same English twice: an untranslated row leans on the
    // primary slot only when there is no source slot to hold the English.
    if (!primary && mode !== "bilingual") primary = entry.source;
    if (mode === "english") primary = entry.source;
    return { source, primary };
  }

  function createHistoryRow(id) {
    const element = document.createElement("div");
    element.className = "history-line";
    // Exposed for the CDP probes: the row is patched in place, so the id is the
    // only stable way to tell "same row, late translation" from "new row".
    element.dataset.lineId = id;
    const sourceElement = document.createElement("span");
    sourceElement.className = "history-source";
    const primaryElement = document.createElement("span");
    primaryElement.className = "history-translation";
    element.append(sourceElement, primaryElement);
    return { id, element, sourceElement, primaryElement, sourceText: "", primaryText: "" };
  }

  // Returns true only when a text node really changed, so an idle broadcast costs
  // no layout and no paint.
  function patchHistoryRow(row, entry) {
    const { source, primary } = historyRowText(entry);
    let changed = false;
    if (row.sourceText !== source) {
      row.sourceText = source;
      row.sourceElement.textContent = source;
      changed = true;
    }
    if (row.primaryText !== primary) {
      row.primaryText = primary;
      row.primaryElement.textContent = primary;
      changed = true;
    }
    return changed;
  }

  // The view is a sliding window over the log, so a merge usually only moves one
  // node in at the bottom and drops one at the top. Walking the target order and
  // reusing every node whose line is still visible avoids the full
  // replaceChildren that made the panel flash on every caption broadcast.
  function syncScrollbackRows(entries) {
    const previousIds = scrollbackRows.map((row) => row.id);
    const nextIds = entries.map((entry) => entry.id);
    const plan = HISTORY_API.planHistoryRows(previousIds, nextIds);
    let changed = plan.added.length > 0 || plan.removed.length > 0;
    const rowsById = new Map(scrollbackRows.map((row) => [row.id, row]));
    for (const id of plan.removed) {
      rowsById.get(id)?.element.remove();
      rowsById.delete(id);
    }
    // Walk the target order and only touch the DOM where a row is not already
    // in its slot: a sliding window moves one node in at the bottom and drops
    // one at the top, not a full replaceChildren on every caption broadcast.
    for (let index = 0; index < plan.order.length; index += 1) {
      const id = plan.order[index];
      let row = rowsById.get(id);
      if (!row) {
        row = createHistoryRow(id);
        rowsById.set(id, row);
      }
      const current = historyListElement.children[index];
      if (current !== row.element) historyListElement.insertBefore(row.element, current || null);
    }
    scrollbackRows.length = 0;
    for (let index = 0; index < plan.order.length; index += 1) {
      const row = rowsById.get(plan.order[index]);
      if (patchHistoryRow(row, entries[index])) changed = true;
      scrollbackRows.push(row);
    }
    return changed;
  }

  function clearScrollbackRows() {
    for (const row of scrollbackRows) row.element.remove();
    scrollbackRows.length = 0;
  }

  function renderScrollback() {
    if (!historyElement || !historyListElement || !chipElement) return;
    const live = scrollBack > 0 ? scrollbackEntries() : null;
    const entries = live ? live.slice(-scrollBack) : [];
    if (entries.length === 0) {
      if (!historyElement.hidden) historyElement.hidden = true;
      if (scrollbackRows.length > 0) clearScrollbackRows();
      if (historyListElement.childElementCount) {
        historyListElement.replaceChildren();
      }
      chipElement.textContent = "";
      historyRectCache = null;
      return;
    }

    let changed = syncScrollbackRows(entries);

    // Unhide before measuring: a hidden panel has no layout, so scrollTop
    // cannot be anchored to the newest line until it is visible.
    const wasHidden = historyElement.hidden;
    historyElement.hidden = false;
    if (wasHidden) changed = true;
    // Rows sliding in or out change the panel box, so the rect the wheel
    // hit-tests against has to be measured again; reusing the old one let a
    // wheel over the newly grown part of the panel fall through to the page.
    if (changed) historyRectCache = null;
    lastPanelRect = historyRect();
    if (changed) {
      // The reader is watching the newest rows, so every change re-anchors the
      // list to its bottom; skipping the write when nothing changed avoids a
      // per-frame layout read on top of an already correct scroll position.
      historyListElement.scrollTop = historyListElement.scrollHeight;
      historyListElement.classList.toggle(
        "overflowing",
        historyListElement.scrollHeight > historyListElement.clientHeight + 1
      );
    }
    if (stage) stage.style.opacity = "1";
    chipElement.textContent =
      scrollBack < Math.min(live.length, MAX_SCROLLBACK)
        ? t("overlay_history_more", entries.length)
        : t("overlay_history_back", entries.length);
  }

  function stageRect() {
    if (!stageRectCache) stageRectCache = stage.getBoundingClientRect();
    return stageRectCache;
  }

  function historyRect() {
    if (!historyRectCache) historyRectCache = historyElement.getBoundingClientRect();
    return historyRectCache;
  }

  // The stage and the history panel are the only wheel targets: the host spans
  // the whole viewport with pointer-events:none, so hit testing has to use the
  // cached boxes instead of event.target. While the close cooldown lasts, the
  // area of the just-closed panel stays part of the overlay as well, otherwise
  // the tail of the same gesture would scroll the page.
  function pointerInsideOverlay(event) {
    const rects = [stageRect()];
    if (historyElement && !historyElement.hidden) {
      rects.push(historyRect());
    } else if (lastPanelRect && performance.now() < wheelCooldownUntil) {
      rects.push(lastPanelRect);
    }
    return rects.some(
      (rect) =>
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
    );
  }

  function handleWheel(event) {
    if (!stage || stage.hidden) return;
    // A retired instance can still be alive for a moment after its host was
    // replaced; never let it keep swallowing page scroll.
    if (!host?.isConnected) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (!pointerInsideOverlay(event)) return;

    const scrollingDown = event.deltaY > 0;
    if (scrollingDown && scrollBack <= 0) {
      // The wheel gesture that closed the panel would otherwise keep scrolling
      // the page (YouTube jumps to the next video). Swallow the tail of it.
      if (performance.now() < wheelCooldownUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!scrollingDown && !openScrollback()) return;

    event.preventDefault();
    event.stopPropagation();
    if ((wheelAccum > 0) !== scrollingDown) wheelAccum = 0;
    wheelAccum += event.deltaY;

    let changed = false;
    while (Math.abs(wheelAccum) >= WHEEL_STEP_PX) {
      if (wheelAccum > 0) {
        if (scrollBack <= 0) {
          wheelAccum = 0;
          break;
        }
        wheelAccum -= WHEEL_STEP_PX;
        scrollBack -= 1;
      } else {
        if (scrollBack >= maxScrollBack()) {
          wheelAccum = 0;
          break;
        }
        wheelAccum += WHEEL_STEP_PX;
        scrollBack += 1;
      }
      changed = true;
    }
    if (!changed) return;
    // Reaching the newest line closes the history panel again.
    if (scrollBack === 0) {
      wheelCooldownUntil = performance.now() + WHEEL_COOLDOWN_MS;
    }
    // render() also refreshes the dual-line context, which steps aside while
    // the reader is looking at the history panel.
    render();
  }

  // Local copy of caption-utils' composeLiveSource / composeLiveSourceParts:
  // this file is an IIFE and may not import ES modules. The recogniser hands
  // over the words after the row it is still working on, so appending keeps the
  // English slot monotonic instead of alternating between the sentence and one
  // or two words. The split feeds the dimmed tail span; change both sides or
  // their output drifts.
  function composeLiveSourceParts(lineSource, bufferSource) {
    const line = clean(lineSource);
    const buffer = clean(bufferSource);
    if (!line) return { stable: buffer, stash: "" };
    if (!buffer) return { stable: line, stash: "" };
    const lineWords = line.split(" ");
    const bufferWords = buffer.split(" ");
    const shorter = Math.min(lineWords.length, bufferWords.length);
    for (let count = shorter; count > 0; count -= 1) {
      const tail = lineWords.slice(-count).join(" ").toLowerCase();
      const head = bufferWords.slice(0, count).join(" ").toLowerCase();
      if (tail !== head) continue;
      return count === bufferWords.length
        ? { stable: line, stash: "" }
        : { stable: line, stash: bufferWords.slice(count).join(" ") };
    }
    return { stable: line, stash: buffer };
  }

  function composeLiveSourceText(parts) {
    const stable = parts?.stable || "";
    const stash = parts?.stash || "";
    if (!stable) return stash;
    return stash ? `${stable} ${stash}` : stable;
  }

  function latestCaption() {
    const current = runtimeState?.current || {};
    const displayCaption = current.displayCaption;
    if (displayCaption) {
      const source = clean(displayCaption.source);
      const stable = clean(displayCaption.sourceStable);
      const stash = clean(displayCaption.sourceStash);
      return {
        lineId: displayCaption.lineId || null,
        source,
        // A worker that predates the split sends only `source`: keep the whole
        // line solid instead of guessing which words are still in flight.
        sourceStable: stable || (stash ? "" : source),
        sourceStash: stash,
        translation: clean(displayCaption.translation),
        error: clean(displayCaption.error),
        pending: Boolean(displayCaption.pending),
        failed: Boolean(displayCaption.failed)
      };
    }
    // Fallback for a worker that predates displayCaption: same rules as
    // caption-utils' selectDisplayCaption (the English slot appends the buffer,
    // the translation slot reads the newest row first, and `pending` means the
    // Chinese lags the source), otherwise the old-worker path and the new one
    // disagree. Change both or neither.
    const lines = Array.isArray(current.lines) ? current.lines : [];
    const reversed = [...lines].reverse();
    const line = reversed.find((item) => item?.source || item?.translation);
    const translated = reversed.find((item) => lineTranslation(item));
    const bufferTranslation = clean(current.bufferTranslation);
    const own = lineTranslation(line);
    const source = composeLiveSourceParts(line?.source, current.bufferSource);
    const failed = Boolean(line?.translationFailed && !own);
    return {
      lineId: line?.id || null,
      source: composeLiveSourceText(source),
      sourceStable: source.stable,
      sourceStash: source.stash,
      translation: own || bufferTranslation || lineTranslation(translated),
      error: clean(current.translationError),
      // `.stable`, not the object: `source` is always truthy, so testing the
    // object would light the awaiting dot for an empty caption. selectDisplayCaption
    // checks `latestSource.stable` the same way.
    pending: Boolean(source.stable && !failed && (line?.translationPending || !own)),
      failed
    };
  }

  const AWAITING_DOT_DELAY_MS = 700;

  // Long translations do happen (measured 1-7 s on a 9B local model), so the
  // reader needs *some* sign that the Chinese on screen is still the previous
  // sentence. A dot that appears immediately would blink on almost every
  // sentence, so it waits out the short gaps and only shows up when the wait
  // is real.
  function syncAwaitingDot(waiting) {
    if (!shell) return;
    if (!waiting) {
      awaitingSince = 0;
      clearTimeout(awaitingDotTimer);
      awaitingDotTimer = null;
      shell.dataset.awaiting = "";
      return;
    }
    const now = performance.now();
    if (!awaitingSince) awaitingSince = now;
    const remaining = AWAITING_DOT_DELAY_MS - (now - awaitingSince);
    if (remaining <= 0) {
      shell.dataset.awaiting = "1";
      return;
    }
    if (!awaitingDotTimer) {
      awaitingDotTimer = setTimeout(() => {
        awaitingDotTimer = null;
        if (awaitingSince && shell) shell.dataset.awaiting = "1";
      }, remaining);
    }
  }

  function render() {
    if (!stage) return;
    // render() has several early returns that flip stage.hidden; re-check the
    // wheel binding once the whole pass is done.
    queueMicrotask(syncWheelBinding);
    applyVisualSettings();
    syncHistory();
    const active = Boolean(runtimeState?.active);
    const caption = latestCaption();
    stage.classList.toggle("ended", !active);
    statusElement.textContent = t(statusLabel());

    if (!active && !caption.source && !caption.translation) {
      stage.hidden = true;
      closeScrollback();
      return;
    }
    if (settings.overlayEnabled === false) {
      stage.hidden = true;
      closeScrollback();
      return;
    }
    stage.hidden = false;
    clearTimeout(idleTimer);
    stage.style.opacity = "1";

    const previous =
      settings.displayMode === "dual" && scrollBack === 0
        ? previousTranslation(caption)
        : "";
    setCaptionText(previousElement, previous);

    if (settings.displayMode === "english") {
      setCaptionText(sourceElement, "");
      setCaptionText(translationElement, caption.source);
      translationElement.classList.remove("pending", "stale", "failed");
      syncAwaitingDot(false);
    } else {
      setCaptionText(translationElement, caption.translation);
      // `pending` is the empty placeholder, `stale` the previous sentence held
      // on screen until its successor is translated.
      translationElement.classList.toggle(
        "pending",
        Boolean(caption.pending && !caption.translation)
      );
      translationElement.classList.toggle(
        "stale",
        Boolean(caption.pending && caption.translation)
      );
      translationElement.classList.toggle("failed", Boolean(caption.failed));
      // The corner dot only means "a translation is on its way while the last
      // sentence is still on screen". An empty first slot keeps the small
      // pending placeholder instead, which already reads as "not translated".
      // A short wait shows nothing at all: most gaps are under a second and a
      // dot that blinks on every sentence is worse than no feedback.
      syncAwaitingDot(Boolean(caption.pending && caption.translation));
      if (settings.displayMode === "bilingual") {
        setSourceText(caption.sourceStable, caption.sourceStash);
      } else {
        setCaptionText(sourceElement, "");
      }
    }

    const errorElement = shadow.querySelector(".translation-error");
    errorElement.textContent = caption.error;
    errorElement.classList.toggle("visible", Boolean(caption.error));

    // reveal first, then resolve a position that was requested while hidden
    if (positionPending) applyStoredPosition();
    syncShellWidth();
    syncShellHeight();
    refreshCaptionOverflow();
    keepStageInViewport();
    renderScrollback();

    if (!active) {
      idleTimer = setTimeout(() => {
        if (stage && scrollBack === 0) stage.style.opacity = "0.35";
      }, IDLE_FADE_MS);
    }
  }

  function resetSessionHistory() {
    HISTORY_API.resetHistoryLog(historyLog);
    clearScrollbackRows();
    syncedLinesRef = null;
    scrollBack = 0;
    wheelAccum = 0;
  }

  // Single entry point for runtime-state replacement so every path (message or
  // refresh response) applies the same session-switch cleanup.
  // Caption rows arrive as deltas (lib/caption-delta.js). This is a verbatim
  // copy of applyCaptionMessage there, since a classic script cannot import;
  // tests/caption-delta.test.js runs both on the same cases.
  function applyCaptionMessage(held, message) {
    if (!message) return held ? { ...held, changed: [] } : null;
    if (message.full) {
      return { seq: message.seq, current: message.full, changed: message.full.lines || [] };
    }
    const delta = message.delta;
    if (!delta || !held || held.seq !== message.baseSeq) return null;
    const byId = new Map();
    for (const line of held.current?.lines || []) {
      if (line?.id) byId.set(line.id, line);
    }
    for (const line of delta.lines) byId.set(line.id, line);
    const lines = [];
    for (const id of delta.lineIds) {
      const line = byId.get(id);
      if (!line) return null;
      lines.push(line);
    }
    return { seq: message.seq, current: { ...delta.fields, lines }, changed: delta.lines };
  }

  let captionHeld = null;
  let lastCaptionResyncAt = -Infinity;

  function applyCaption(message) {
    if (!message) return;
    const next = applyCaptionMessage(captionHeld, message);
    if (!next) {
      // Missed a message: ask for a full one, at most once a second.
      const now = performance.now();
      if (now - lastCaptionResyncAt < 1000) return;
      lastCaptionResyncAt = now;
      chrome.runtime
        .sendMessage({ target: "background", type: "caption-resync" })
        .catch((error) => console.warn("声幕字幕重同步失败", error));
      return;
    }
    captionHeld = { seq: next.seq, current: next.current };
  }

  function withCaptions(next) {
    return { ...next, current: captionHeld?.current ?? next?.current ?? runtimeState?.current };
  }

  function setRuntimeState(next) {
    const previousSessionId = runtimeState?.sessionId || null;
    runtimeState = next;
    if ((runtimeState?.sessionId || null) !== previousSessionId) {
      resetSessionHistory();
    }
  }

  function applyMessage(message) {
    if (message.settings) {
      settings = { ...settings, ...message.settings };
    }
    applyCaption(message.caption || message.payload?.caption);
    if (message.state) {
      setRuntimeState(withCaptions(message.state));
    }
    if (message.type === "caption-state" && message.payload) {
      const { caption: _caption, ...meta } = message.payload;
      setRuntimeState(withCaptions({ ...(runtimeState || {}), ...meta }));
    }
    render();
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    // A retired instance keeps its listener for a moment after teardown; it
    // must not touch a stage that is already gone.
    if (!stage) return false;
    if (message?.target !== "content") return false;
    if (message.type === "init" || message.type === "caption-state") {
      applyMessage(message);
    } else if (message.type === "settings-changed") {
      applyMessage(message);
    } else if (message.type === "hide-overlay") {
      stage.hidden = true;
      closeScrollback();
    } else if (message.type === "session-state") {
      applyMessage(message);
    }
    sendResponse({ ok: true });
    return false;
  }

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  async function refresh() {
    if (!host || !host.isConnected) buildOverlay();
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "content-ready"
      });
      if (response?.ok) {
        if (response.settings) settings = { ...settings, ...response.settings };
        if (response.state) {
          // A full snapshot outside the delta sequence: render it, and let
          // the next delta's gap trigger a resync.
          if (!captionHeld && response.state.current) {
            captionHeld = { seq: Number.NaN, current: response.state.current };
          }
          setRuntimeState(withCaptions(response.state));
        }
        render();
      }
    } catch {
      // The background may be waking up; its normal broadcast will follow.
    }
  }

  // Counterpart of bindWindowListeners(): drop every listener this instance
  // owns so a re-injected overlay cannot answer the same wheel twice.
  function teardown() {
    if (windowListenersBound) {
      windowListenersBound = false;
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("pointermove", handlePointerMove, {
        capture: true
      });
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    }
    setWheelBinding(false);
    lastPointer = null;
    if (sizeObserver) {
      sizeObserver.disconnect();
      sizeObserver = null;
    }
    clearTimeout(idleTimer);
    idleTimer = null;
    clearTimeout(awaitingDotTimer);
    awaitingDotTimer = null;
    awaitingSince = 0;
    clearTimeout(shellShrinkTimer);
    shellShrinkTimer = 0;
    clearTimeout(shellShrinkTransitionTimer);
    shellShrinkTransitionTimer = 0;
    clearTimeout(shellResizeTimer);
    shellResizeTimer = 0;
    clearTimeout(shellWidthSettleTimer);
    shellWidthSettleTimer = 0;
    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    } catch {
      // The extension context may already be gone; nothing left to detach.
    }
    if (host) host.remove();
    host = null;
    shadow = null;
    stage = null;
    sourceElement = null;
    translationElement = null;
    previousElement = null;
    historyElement = null;
    historyListElement = null;
    chipElement = null;
    statusElement = null;
    modeButton = null;
    dragState = null;
    positionPending = false;
    shellWidthPx = 0;
    shellHeightPx = 0;
    stageRectCache = null;
    historyRectCache = null;
    scrollbackRows.length = 0;
    scrollBack = 0;
    wheelAccum = 0;
    syncedLinesRef = null;
    HISTORY_API.resetHistoryLog(historyLog);
    if (globalThis.__shengmuCaptionOverlay?.teardown === teardown) {
      delete globalThis.__shengmuCaptionOverlay;
    }
  }

  globalThis.__shengmuCaptionOverlay = {
    version: OVERLAY_VERSION,
    refresh,
    teardown,
    get state() {
      return runtimeState;
    },
    get settings() {
      return settings;
    },
    // Read-only diagnostics for the UI smoke harness.
    get history() {
      return { size: historyLog.entries.length, limit: historyLog.limit };
    }
  };

  buildOverlay();
  void loadPosition();
  void refresh();
})();
