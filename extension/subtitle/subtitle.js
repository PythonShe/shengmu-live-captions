import {
  DEFAULT_SETTINGS,
  buildSrt,
  cleanText,
  formatClock,
  hostnameFromUrl,
  mergeCaptionLines,
  normalizeSettings,
  planTranscriptDiff,
  safeFileStem
} from "../lib/caption-utils.js";
import {
  clearHistory,
  deleteHistorySession,
  getHistoryLines,
  getHistorySession,
  listHistorySessions
} from "../storage/history-db.js";
import { createCaptionReceiver, upsertTailLines } from "../lib/caption-delta.js";
import {
  DISPLAY_MODE_LABELS,
  DISPLAY_MODE_ORDER,
  capturePresentation,
  formatDate,
  formatDuration,
  formatElapsed
} from "../lib/ui-model.js";

const PAGE_SIZE = 250;
const MAX_SEARCH_RESULTS = 1000;

const elements = {
  liveCard: document.querySelector("#liveCard"),
  liveDot: document.querySelector("#liveDot"),
  liveStatus: document.querySelector("#liveStatus"),
  liveTime: document.querySelector("#liveTime"),
  liveTitle: document.querySelector("#liveTitle"),
  liveDetail: document.querySelector("#liveDetail"),
  focusLiveTab: document.querySelector("#focusLiveTab"),
  sessionSearch: document.querySelector("#sessionSearch"),
  sessionList: document.querySelector("#sessionList"),
  clearHistory: document.querySelector("#clearHistory"),
  sessionTitle: document.querySelector("#sessionTitle"),
  sessionMeta: document.querySelector("#sessionMeta"),
  copyTranscript: document.querySelector("#copyTranscript"),
  exportSrt: document.querySelector("#exportSrt"),
  deleteSession: document.querySelector("#deleteSession"),
  captureDot: document.querySelector("#captureDot"),
  captureStatus: document.querySelector("#captureStatus"),
  captureDetail: document.querySelector("#captureDetail"),
  displayMode: document.querySelector("#displayMode"),
  transcriptSearch: document.querySelector("#transcriptSearch"),
  toggleOverlay: document.querySelector("#toggleOverlay"),
  stopCapture: document.querySelector("#stopCapture"),
  transcriptViewport: document.querySelector("#transcriptViewport"),
  welcomePanel: document.querySelector("#welcomePanel"),
  loadEarlier: document.querySelector("#loadEarlier"),
  transcriptList: document.querySelector("#transcriptList"),
  interimCard: document.querySelector("#interimCard"),
  interimSource: document.querySelector("#interimSource"),
  interimTranslation: document.querySelector("#interimTranslation"),
  emptyTranscript: document.querySelector("#emptyTranscript"),
  scrollLatest: document.querySelector("#scrollLatest"),
  lineCount: document.querySelector("#lineCount"),
  audioHealth: document.querySelector("#audioHealth"),
  translationWarning: document.querySelector("#translationWarning"),
  toast: document.querySelector("#toast"),
announcer: document.querySelector("#announcer")
};

let runtimeState = null;
let settings = normalizeSettings(DEFAULT_SETTINGS);
let sessions = [];
let selectedSessionId = null;
let selectedSession = null;
let allLines = [];
const captions = createCaptionReceiver({
  requestResync: () => {
    void chrome.runtime.sendMessage({ target: "background", type: "caption-resync" });
  }
});
let visibleCount = PAGE_SIZE;
let transcriptQuery = "";
let sessionQuery = "";
let loadToken = 0;
let followLatest = true;
let transcriptRenderTimer = null;
let toastTimer = null;
let searchTimer = null;
let sessionsRefreshTimer = null;

// Incremental transcript rendering state. Rebuilding the whole list on every
// caption message (every ~80 ms while live) replayed the entry animation and
// fought the scroll position, which is what made the page flicker.
const lineViews = new Map();
let renderedLineIds = [];
let renderedViewKey = "";
let followFrame = 0;
let sessionListSignature = "";

elements.displayMode.replaceChildren(
  ...DISPLAY_MODE_ORDER.map((mode) => new Option(DISPLAY_MODE_LABELS[mode], mode))
);

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2600);
}

// The transcript list can hold up to 1000 rows and is rebuilt often, so it is
// not a live region; only short outcome messages go through this element.
function announce(message) {
  elements.announcer.textContent = "";
  requestAnimationFrame(() => {
    elements.announcer.textContent = message;
  });
}

function selectedIsLive() {
  return Boolean(
    runtimeState?.active &&
    selectedSessionId &&
    runtimeState.sessionId === selectedSessionId
  );
}

// Broadcast state carries no caption rows; they arrive as caption deltas.
function applyRuntimeState(nextState) {
  if (!nextState) return;
  runtimeState = { ...nextState, current: captions.current ?? runtimeState?.current };
}

function renderLiveCard() {
  const active = Boolean(runtimeState?.active);
  const presentation = capturePresentation(runtimeState);
  elements.liveDot.className = `live-dot ${presentation.dotClass}`.trim();
  elements.liveStatus.textContent = presentation.label;
  elements.liveTime.textContent = active ? formatElapsed(runtimeState.startedAt) : "";
  elements.liveTitle.textContent = active
    ? runtimeState.tabTitle || "当前直播"
    : selectedSession?.title || "当前没有字幕任务";
  elements.liveDetail.textContent = active
    ? runtimeState.detail || hostnameFromUrl(runtimeState.tabUrl)
    : "在直播页面点击扩展图标开始字幕。";
  elements.focusLiveTab.disabled = !active || !runtimeState.tabId;
  elements.focusLiveTab.style.opacity = elements.focusLiveTab.disabled ? "0.45" : "";
}

function renderControlDeck() {
  const presentation = capturePresentation(runtimeState);
  elements.captureDot.className = `capture-dot ${presentation.dotClass}`.trim();
  elements.captureStatus.textContent = presentation.label;
  elements.captureDetail.textContent = presentation.detail;
  elements.displayMode.value = settings.displayMode;
  elements.toggleOverlay.textContent = `浮层：${settings.overlayEnabled ? "开" : "关"}`;
  elements.stopCapture.disabled = !runtimeState?.active;

  const ratio = runtimeState?.audio?.deliveredRatio;
  elements.audioHealth.textContent = ratio
    ? `音频采集完整度 ${Math.round(ratio * 100)}%`
    : runtimeState?.active
      ? "等待音频统计"
      : "等待音频";
  const warning =
    runtimeState?.current?.translationError ||
    (["error", "incomplete"].includes(runtimeState?.status)
      ? runtimeState.detail
      : "");
  elements.translationWarning.textContent = warning || "";
  elements.translationWarning.title = warning || "";
}

function renderHeader() {
  const session = selectedSession;
  if (!session) {
    elements.sessionTitle.textContent = "实时字幕与翻译记录";
    elements.sessionMeta.textContent =
      "选择左侧场次查看历史，或开始一个新的直播字幕任务。";
    elements.deleteSession.hidden = true;
    return;
  }
  elements.sessionTitle.textContent = session.title || "未命名直播";
  const start = session.startedAt || 0;
  const end = session.endedAt || (selectedIsLive() ? Date.now() : start);
  const count = selectedIsLive()
    ? Math.max(allLines.length, runtimeState.lineCount || 0)
    : Math.max(allLines.length, session.lineCount || 0);
  const pieces = [
    hostnameFromUrl(session.url) || "本地页面",
    formatDate(start),
    formatDuration(Math.max(0, end - start)),
    `${count} 条字幕`
  ];
  if (session.translationMissing > 0) {
    pieces.push(`${session.translationMissing} 条缺译`);
  }
  elements.sessionMeta.textContent = pieces.filter(Boolean).join(" · ");
  elements.deleteSession.hidden = selectedIsLive();
}

function renderSessionList() {
  const needle = sessionQuery.toLocaleLowerCase("zh-CN");
  const filtered = sessions.filter((session) => {
    if (!needle) return true;
    return `${session.title} ${session.preview} ${hostnameFromUrl(session.url)}`
      .toLocaleLowerCase("zh-CN")
      .includes(needle);
  });

  const signature = [
    needle,
    selectedSessionId || "",
    runtimeState?.active ? runtimeState.sessionId || "live" : "",
    filtered
      .map((session) =>
        [
          session.id,
          session.title,
          session.startedAt,
          session.lineCount,
          session.translationMissing,
          session.preview
        ].join("\u0001")
      )
      .join("\u0002")
  ].join("\u0003");
  if (signature === sessionListSignature) return;
  sessionListSignature = signature;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.textContent = sessions.length
      ? "没有匹配的场次。"
      : "还没有字幕记录。开始一次实时翻译后，场次会自动保存在这里。";
    elements.sessionList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const session of filtered) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "session-card";
    card.dataset.sessionId = session.id;
    if (session.id === selectedSessionId) {
      card.classList.add("active");
      card.setAttribute("aria-current", "true");
    }

    const head = document.createElement("span");
    head.className = "session-card-head";
    const title = document.createElement("strong");
    title.textContent = session.title || "未命名直播";
    const date = document.createElement("span");
    date.className = "session-card-date";
    date.textContent = formatDate(session.startedAt);
    head.append(title, date);

    const preview = document.createElement("p");
    preview.className = "session-card-preview";
    preview.textContent = session.preview || "尚无稳定字幕";

    const foot = document.createElement("span");
    foot.className = "session-card-foot";
    if (runtimeState?.active && runtimeState.sessionId === session.id) {
      const live = document.createElement("span");
      live.className = "mini-live";
      live.textContent = "LIVE";
      foot.append(live);
    }
    const count = document.createElement("span");
    count.textContent = `${session.lineCount || 0} 条`;
    const source = document.createElement("span");
    source.textContent = hostnameFromUrl(session.url) || "本地";
    foot.append(count);
    if (session.translationMissing > 0) {
      const missing = document.createElement("span");
      missing.className = "mini-warning";
      missing.textContent = `缺译 ${session.translationMissing}`;
      foot.append(missing);
    }
    foot.append(source);

    card.append(head, preview, foot);
    card.addEventListener("click", () => {
      if (card.dataset.sessionId !== selectedSessionId) {
        void selectSession(card.dataset.sessionId, { scrollToLatest: true });
      }
    });
    fragment.append(card);
  }
  elements.sessionList.replaceChildren(fragment);
}

function lineSignature(line, isLatest) {
  return [
    line.start || "",
    isLatest ? "1" : "0",
    line.translation || "",
    line.source || ""
  ].join("\u0001");
}

function createLineView(line, isLatest) {
  const article = document.createElement("article");
  article.className = "transcript-line";

  const time = document.createElement("span");
  time.className = "line-time";

  const content = document.createElement("div");
  content.className = "line-content";

  const translation = document.createElement("p");
  translation.className = "line-translation";

  const source = document.createElement("span");
  source.className = "line-source";

  content.append(translation, source);
  article.append(time, content);

  const view = { article, time, translation, source, signature: "" };
  updateLineView(view, line, isLatest);
  return view;
}

function updateLineView(view, line, isLatest) {
  const signature = lineSignature(line, isLatest);
  if (view.signature === signature) return false;
  view.signature = signature;
  view.time.textContent = line.start
    ? formatClock(line.start)
    : formatDate(line.updatedAt);
  view.translation.textContent = line.translation || line.source || "";
  view.source.textContent = line.source || "";
  view.article.classList.toggle("is-latest", Boolean(isLatest));
  return true;
}

function markIncomingLine(article) {
  if (!article) return;
  article.classList.add("is-new");
  article.addEventListener(
    "animationend",
    () => article.classList.remove("is-new"),
    { once: true }
  );
}

function transcriptViewKey() {
  return [
    selectedSessionId || "",
    transcriptQuery,
    settings.displayMode,
    visibleCount,
    selectedIsLive() ? "live" : "past"
  ].join("|");
}

function lineKey(line, index) {
  return line.id || `idx-${index}`;
}

// Appends only genuinely new rows and patches rows whose text changed. The
// visible list is otherwise left untouched so scrolling stays stable.
function syncTranscriptLines(visibleLines, isLive, latestId) {
  const list = elements.transcriptList;
  const viewKey = transcriptViewKey();
  // Rows without a stable id (should not happen with history rows) cannot be
  // diffed safely, so they always take the rebuild path.
  const hasAnonymous = visibleLines.some((line) => !line.id);
  const nextIds = visibleLines.map((line, index) => lineKey(line, index));
  const prevIds = renderedLineIds;
  const diff = hasAnonymous
    ? { rebuild: true, drop: 0 }
    : planTranscriptDiff(prevIds, nextIds);
  const canAppend = viewKey === renderedViewKey && !diff.rebuild;

  if (!canAppend) {
    const fragment = document.createDocumentFragment();
    lineViews.clear();
    visibleLines.forEach((line, index) => {
      const isLatest =
        isLive && line.id === latestId && index === visibleLines.length - 1;
      const view = createLineView(line, isLatest);
      lineViews.set(lineKey(line, index), view);
      fragment.append(view.article);
    });
    list.replaceChildren(fragment);
    renderedLineIds = nextIds;
    renderedViewKey = viewKey;
    return;
  }

  for (let index = 0; index < diff.drop; index += 1) {
    const view = lineViews.get(prevIds[index]);
    if (view) view.article.remove();
    lineViews.delete(prevIds[index]);
  }

  const appended = [];
  visibleLines.forEach((line, index) => {
    const key = lineKey(line, index);
    const isLatest =
      isLive && line.id === latestId && index === visibleLines.length - 1;
    const existing = lineViews.get(key);
    if (existing) {
      updateLineView(existing, line, isLatest);
      return;
    }
    const view = createLineView(line, isLatest);
    lineViews.set(key, view);
    list.append(view.article);
    appended.push(view.article);
  });
  renderedLineIds = nextIds;
  markIncomingLine(appended.at(-1));
}

function scheduleFollowScroll() {
  elements.scrollLatest.hidden = true;
  if (followFrame) cancelAnimationFrame(followFrame);
  followFrame = requestAnimationFrame(() => {
    followFrame = 0;
    if (!followLatest) return;
    const viewport = elements.transcriptViewport;
    const target = viewport.scrollHeight;
    if (Math.abs(viewport.scrollTop + viewport.clientHeight - target) > 2) {
      viewport.scrollTop = target;
    }
  });
}

function filteredTranscriptLines() {
  const needle = transcriptQuery.toLocaleLowerCase("zh-CN");
  if (!needle) return allLines;
  return allLines.filter((line) =>
    `${line.translation} ${line.source}`
      .toLocaleLowerCase("zh-CN")
      .includes(needle)
  );
}

function isNearBottom() {
  const viewport = elements.transcriptViewport;
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 90;
}

function renderTranscript() {
  transcriptRenderTimer = null;
  const filtered = filteredTranscriptLines();
  const welcomeVisible = sessions.length === 0 && !runtimeState?.active && !selectedSession;
  elements.welcomePanel.hidden = !welcomeVisible;
  elements.transcriptList.hidden = welcomeVisible;

  if (welcomeVisible) {
    elements.loadEarlier.hidden = true;
    elements.emptyTranscript.hidden = true;
    elements.interimCard.hidden = true;
    elements.scrollLatest.hidden = true;
    return;
  }

  const shouldFollow = followLatest || isNearBottom();
  elements.transcriptList.className = `transcript-list display-${settings.displayMode}`;
  const resultLimit = transcriptQuery ? MAX_SEARCH_RESULTS : visibleCount;
  const visibleLines = filtered.slice(-resultLimit);
  const latestId = allLines.at(-1)?.id || null;

  syncTranscriptLines(visibleLines, selectedIsLive(), latestId);
  elements.loadEarlier.hidden =
    Boolean(transcriptQuery) || filtered.length <= visibleCount;
  elements.loadEarlier.textContent = `载入更早的字幕（还有 ${Math.max(
    0,
    filtered.length - visibleCount
  )} 条）`;

  const bufferSource = cleanText(runtimeState?.current?.bufferSource);
  const bufferTranslation = cleanText(runtimeState?.current?.bufferTranslation);
  const bufferIdle = !bufferSource && !bufferTranslation;
  // Keep the listening card mounted for the whole live session. Hiding it on
  // every buffer flap changed the scroll height each time and dragged the
  // whole transcript up and down.
  elements.interimCard.hidden = !selectedIsLive();
  elements.interimCard.classList.toggle("is-idle", bufferIdle);
  elements.interimSource.textContent = bufferSource;
  elements.interimTranslation.textContent = bufferTranslation;
  if (bufferIdle) {
    if (settings.displayMode === "english") {
      elements.interimSource.textContent = "等待下一句…";
    } else {
      elements.interimTranslation.textContent = "等待下一句…";
    }
  }
  const sourceVisible =
    settings.displayMode === "bilingual" || settings.displayMode === "english";
  elements.interimSource.hidden =
    !sourceVisible || !elements.interimSource.textContent;
  elements.interimTranslation.hidden = !elements.interimTranslation.textContent;

  elements.emptyTranscript.hidden = filtered.length > 0 || !elements.interimCard.hidden;
  if (!elements.emptyTranscript.hidden) {
    elements.emptyTranscript.querySelector("span").textContent = transcriptQuery
      ? "没有匹配字幕"
      : "暂无字幕";
    elements.emptyTranscript.querySelector("p").textContent = transcriptQuery
      ? "换一个关键词，或清空搜索查看整场记录。"
      : "当前场次还没有稳定句子。语音开始后，字幕会自动出现在这里。";
  }

  elements.lineCount.textContent =
    transcriptQuery && filtered.length > MAX_SEARCH_RESULTS
      ? `显示最近 ${MAX_SEARCH_RESULTS} / ${filtered.length} 条匹配`
      : `${filtered.length} 条字幕`;
  if (shouldFollow) {
    followLatest = true;
    scheduleFollowScroll();
  } else {
    elements.scrollLatest.hidden = false;
  }
}

function scheduleTranscriptRender(delay = 90) {
  if (transcriptRenderTimer) return;
  transcriptRenderTimer = setTimeout(renderTranscript, delay);
}

function renderAll() {
  renderLiveCard();
  renderControlDeck();
  renderHeader();
  renderSessionList();
  scheduleTranscriptRender(0);
}

// `changed` is the delta's changed rows: in a long session the full merge
// re-sorts up to 20000 rows on every caption message, the tail upsert only
// touches the rows that moved.
function mergeRuntimeTranscript(changed = null) {
  if (!selectedIsLive() || !runtimeState?.current) return;
  const lines = runtimeState.current.lines || [];
  const upserted = Boolean(changed) && upsertTailLines(allLines, changed, 20000);
  if (!upserted && lines.length > 0) {
    allLines = mergeCaptionLines(allLines, lines, 20000);
  }
  if (selectedSession) {
    selectedSession.lineCount = Math.max(
      runtimeState.lineCount || 0,
      allLines.length
    );
    const lastLine = allLines.at(-1);
    selectedSession.preview =
      lastLine?.translation || lastLine?.source || selectedSession.preview;
  }
}

async function loadSessions(options = {}) {
  const token = loadToken;
  sessions = await listHistorySessions();
  if (token !== loadToken) return;
  if (
    runtimeState?.active &&
    runtimeState.sessionId &&
    !sessions.some((session) => session.id === runtimeState.sessionId)
  ) {
    sessions.unshift({
      id: runtimeState.sessionId,
      startedAt: runtimeState.startedAt,
      endedAt: null,
      title: runtimeState.tabTitle || "当前直播",
      url: runtimeState.tabUrl,
      lineCount: runtimeState.lineCount || 0,
      preview: "",
      status: runtimeState.status
    });
  }

  if (!selectedSessionId && sessions.length > 0) {
    selectedSessionId =
      (runtimeState?.active && runtimeState.sessionId) || sessions[0].id;
    await selectSession(selectedSessionId, {
      scrollToLatest: options.scrollToLatest !== false
    });
    return;
  }

  if (
    selectedSessionId &&
    !sessions.some((session) => session.id === selectedSessionId) &&
    !selectedIsLive()
  ) {
    selectedSessionId = sessions[0]?.id || null;
    if (selectedSessionId) {
      await selectSession(selectedSessionId, { scrollToLatest: true });
      return;
    }
  }

  selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ||
    selectedSession;
  renderAll();
}

async function selectSession(sessionId, options = {}) {
  if (!sessionId) return;
  const token = ++loadToken;
  selectedSessionId = sessionId;
  const session = await getHistorySession(sessionId);
  if (token !== loadToken || selectedSessionId !== sessionId) return;
  let nextSession = session;
  if (!nextSession) {
    nextSession = sessions.find((item) => item.id === sessionId) || null;
  }
  const lines = await getHistoryLines(sessionId);
  if (token !== loadToken || selectedSessionId !== sessionId) return;
  selectedSession = nextSession;
  allLines = lines;
  visibleCount = PAGE_SIZE;
  transcriptQuery = "";
  elements.transcriptSearch.value = "";
  mergeRuntimeTranscript();
  followLatest = true;
  renderAll();
  announce(`已打开场次：${nextSession?.title || "未命名直播"}，${allLines.length} 条字幕`);
  if (options.scrollToLatest !== false) {
    requestAnimationFrame(() => {
      elements.transcriptViewport.scrollTop =
        elements.transcriptViewport.scrollHeight;
    });
  }
}

// Translations that land during finalize (up to 15 s after stop) are written
// to IndexedDB after the live merge stopped, so a finished session has to be
// re-read; unlike selectSession this keeps the search query and scroll.
async function reloadSelectedLines() {
  if (!selectedSessionId || selectedIsLive()) return;
  const sessionId = selectedSessionId;
  const token = loadToken;
  const lines = await getHistoryLines(sessionId);
  if (token !== loadToken || selectedSessionId !== sessionId) return;
  allLines = lines;
  scheduleTranscriptRender(0);
}

async function refreshSelectedSessionSummary() {
  if (!selectedSessionId) return;
  const sessionId = selectedSessionId;
  const token = loadToken;
  const latest = await getHistorySession(sessionId);
  if (token !== loadToken || selectedSessionId !== sessionId) return;
  if (!latest) return;
  selectedSession = latest;
  const existingIndex = sessions.findIndex(
    (session) => session.id === sessionId
  );
  if (existingIndex >= 0) sessions[existingIndex] = latest;
  renderHeader();
  renderSessionList();
}

function scheduleSessionsRefresh() {
  if (sessionsRefreshTimer) return;
  sessionsRefreshTimer = setTimeout(() => {
    sessionsRefreshTimer = null;
    void refreshSelectedSessionSummary();
  }, 900);
}

async function stopCapture() {
  elements.stopCapture.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "stop-capture"
    });
    if (!response?.ok) throw new Error(response?.error || "停止失败");
    showToast("已停止当前字幕采集。");
    await loadSessions();
  } catch (error) {
    showToast(error?.message || String(error));
    elements.stopCapture.disabled = !runtimeState?.active;
  }
}

async function focusLiveTab() {
  if (!runtimeState?.tabId) return;
  try {
    const tab = await chrome.tabs.get(runtimeState.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    showToast("直播标签页已关闭或无法访问。");
  }
}

async function saveDisplayMode(value) {
  settings = { ...settings, displayMode: value };
  renderAll();
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "save-settings",
    settings: { displayMode: value }
  });
  if (response?.settings) {
    settings = normalizeSettings(response.settings);
    renderAll();
  }
}

async function toggleOverlay() {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "toggle-overlay"
  });
  if (!response?.ok) {
    showToast(response?.error || "无法切换页面浮层。");
    return;
  }
  settings = normalizeSettings(response.settings);
  renderControlDeck();
  showToast(response.enabled ? "页面浮层已开启。" : "页面浮层已隐藏。");
}

function transcriptPlainText() {
  return [...allLines]
    .sort((left, right) => (left.order || 0) - (right.order || 0))
    .map((line) => {
      const time = line.start ? `[${formatClock(line.start)}] ` : "";
      if (settings.displayMode === "english") {
        return `${time}${line.source || line.translation || ""}`;
      }
      if (settings.displayMode === "bilingual") {
        return `${time}${line.translation || ""}\n${line.source || ""}`.trim();
      }
      return `${time}${line.translation || line.source || ""}`;
    })
    .filter((line) => line.replace(/\[[^\]]+\]/g, "").trim())
    .join("\n\n");
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function copyTranscript() {
  const text = transcriptPlainText();
  if (!text) {
    showToast("当前场次没有可复制的字幕。");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    showToast("字幕已复制到剪贴板。");
  } catch {
    fallbackCopy(text);
    showToast("字幕已复制到剪贴板。");
  }
}

async function exportSrt() {
  if (!selectedSession || allLines.length === 0) {
    showToast("当前场次没有可导出的字幕。");
    return;
  }
  const content = buildSrt(allLines);
  if (!content) {
    showToast("字幕内容为空，无法导出。");
    return;
  }
  const blob = new Blob([content], { type: "application/x-subrip;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const filename = `${safeFileStem(selectedSession.title)}-${safeFileStem(
    formatDate(selectedSession.startedAt)
  )}.srt`;
  if (chrome.downloads?.download) {
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      if (Number.isInteger(downloadId)) {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        showToast("SRT 字幕已保存到下载目录。");
        return;
      }
    } catch {
      // Fall back to the anchor download path below.
    }
  }
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  showToast("SRT 字幕已导出。");
}

async function removeSelectedSession() {
  if (!selectedSessionId || selectedIsLive()) return;
  const sessionId = selectedSessionId;
  const title = selectedSession?.title || "这个场次";
  if (!confirm(`删除「${title}」及其全部字幕记录？此操作不可撤销。`)) return;
  if (selectedSessionId !== sessionId) return;
  await deleteHistorySession(sessionId);
  if (selectedSessionId !== sessionId) return;
  selectedSessionId = null;
  selectedSession = null;
  allLines = [];
  await loadSessions();
  showToast("场次已删除。");
}

async function clearAllHistory() {
  if (runtimeState?.active) {
    showToast("请先停止当前字幕，再清空历史。");
    return;
  }
  if (!sessions.length) return;
  if (!confirm("清空全部字幕场次？此操作不可撤销。")) return;
  await clearHistory();
  sessions = [];
  selectedSessionId = null;
  selectedSession = null;
  allLines = [];
  renderAll();
  showToast("全部字幕历史已清空。");
}

function showWelcomeIfEmpty() {
  const empty = sessions.length === 0 && !runtimeState?.active && !selectedSession;
  elements.welcomePanel.hidden = !empty;
}

elements.focusLiveTab.addEventListener("click", focusLiveTab);
elements.stopCapture.addEventListener("click", stopCapture);
elements.displayMode.addEventListener("change", () => {
  void saveDisplayMode(elements.displayMode.value);
});
elements.toggleOverlay.addEventListener("click", () => {
  void toggleOverlay();
});
elements.copyTranscript.addEventListener("click", () => {
  void copyTranscript();
});
elements.exportSrt.addEventListener("click", exportSrt);
elements.deleteSession.addEventListener("click", () => {
  void removeSelectedSession();
});
elements.clearHistory.addEventListener("click", () => {
  void clearAllHistory();
});
elements.loadEarlier.addEventListener("click", () => {
  const previousHeight = elements.transcriptViewport.scrollHeight;
  visibleCount += PAGE_SIZE;
  renderTranscript();
  requestAnimationFrame(() => {
    const addedHeight = elements.transcriptViewport.scrollHeight - previousHeight;
    elements.transcriptViewport.scrollTop += Math.max(0, addedHeight);
  });
});
elements.scrollLatest.addEventListener("click", () => {
  followLatest = true;
  elements.transcriptViewport.scrollTo({
    top: elements.transcriptViewport.scrollHeight,
    behavior: "smooth"
  });
  elements.scrollLatest.hidden = true;
});
elements.transcriptViewport.addEventListener("scroll", () => {
  const nearBottom = isNearBottom();
  followLatest = nearBottom;
  elements.scrollLatest.hidden = nearBottom;
});
elements.sessionSearch.addEventListener("input", () => {
  sessionQuery = cleanText(elements.sessionSearch.value);
  renderSessionList();
});
elements.transcriptSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    transcriptQuery = cleanText(elements.transcriptSearch.value);
    visibleCount = PAGE_SIZE;
    followLatest = true;
    scheduleTranscriptRender(0);
    if (transcriptQuery) {
      const matches = filteredTranscriptLines().length;
      announce(matches ? `找到 ${matches} 条匹配字幕` : "没有匹配字幕");
    }
  }, 120);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "extension-view") return;
  if (message.settings) {
    settings = normalizeSettings(message.settings);
  }
  // Every broadcast type carries the caption stream, so rows that changed
  // under a status or audio-stats message must be merged here too.
  const changedLines = captions.apply(message.caption);
  if (message.state) {
    applyRuntimeState(message.state);
  }
  if (changedLines?.length && message.type !== "caption-state") {
    mergeRuntimeTranscript(changedLines);
    scheduleTranscriptRender(80);
  }

  if (message.type === "caption-state") {
    if (changedLines) {
      runtimeState = {
        ...(runtimeState || {}),
        current: captions.current,
        wsConnected: true,
        status: runtimeState?.active ? "capturing" : runtimeState?.status
      };
    }
    mergeRuntimeTranscript(changedLines);
    renderLiveCard();
    renderControlDeck();
    renderHeader();
    scheduleTranscriptRender(80);
    scheduleSessionsRefresh();
    if (!selectedSessionId && runtimeState?.active) {
      void loadSessions();
    }
  } else if (message.type === "session-state") {
    const liveSessionId = message.state?.sessionId;
    renderAll();
    void (async () => {
      await loadSessions({ scrollToLatest: true });
      if (
        liveSessionId &&
        runtimeState?.active &&
        selectedSessionId !== liveSessionId
      ) {
        await selectSession(liveSessionId, { scrollToLatest: true });
      }
    })();
  } else if (message.type === "session-ended") {
    renderAll();
    void loadSessions().then(reloadSelectedLines);
    showToast(message.detail || "字幕采集已结束。");
  } else if (message.type === "history-changed") {
    void loadSessions().then(reloadSelectedLines);
  } else if (message.type === "line-count") {
    if (runtimeState) runtimeState.lineCount = message.lineCount;
    renderHeader();
    scheduleSessionsRefresh();
  } else if (["status", "audio-stats", "settings-changed"].includes(message.type)) {
    renderLiveCard();
    renderControlDeck();
    renderHeader();
    scheduleTranscriptRender(100);
  }
});

// Fire-and-forget IndexedDB and runtime calls (`void loadSessions()`, export,
// delete) must not fail silently; surface them like the popup does.
window.addEventListener("unhandledrejection", (event) => {
  showToast(event.reason?.message || String(event.reason));
});

async function initializeView() {
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "get-state"
    });
    if (response?.state) {
      runtimeState = response.state;
      captions.seed(response.state.current);
    }
    if (response?.settings) settings = normalizeSettings(response.settings);
    await loadSessions();
    showWelcomeIfEmpty();
    renderAll();
  } catch (error) {
    showToast(`无法读取字幕状态：${error?.message || error}`);
  }
}

setInterval(() => {
  if (runtimeState?.active) {
    renderLiveCard();
    renderHeader();
  }
}, 1000);

void initializeView();
