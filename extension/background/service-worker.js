import {
  DEFAULT_SETTINGS,
  EMPTY_RUNTIME_STATE,
  HISTORY_CHANGED_KEY,
  SETTINGS_KEY,
  applyOverlayFailure,
  lineNeedsTranslation,
  migrateLegacySettings,
  normalizeSettings,
  normalizeWsUrl,
  sanitizeSettingsPatch,
  settingsForBroadcast,
  settingsForCaptions
} from "../lib/caption-utils.js";
import {
  buildAsrContextPrompt,
  resolveEffectiveGlossary
} from "../lib/glossary.js";
import {
  TRANSLATION_PROVIDERS,
  normalizeTranslationBaseUrl,
  normalizeTranslationProvider,
  resolveTranslationConfig,
  testTranslationConnection,
  translateTexts,
  translationConfigIssue
} from "../lib/translation-api.js";
import {
  countHistoryLines,
  createHistorySession,
  getHistoryLines,
  updateHistorySession,
  upsertHistoryLines
} from "../storage/history-db.js";
import { HistoryWriteQueue } from "../lib/history-write-queue.js";
import { createRuntimeStore, safeClone } from "./runtime-store.js";
import { rememberLine, reduceTranscriptUpdate } from "../lib/transcript-reducer.js";
import {
  TRANSLATION_STOP_TIMEOUT_MS,
  createTranslationScheduler
} from "../lib/translation-scheduler.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";
const MONITOR_URL = "subtitle/subtitle.html";
const LINE_FLUSH_DELAY_MS = 700;

let settingsCache = { ...DEFAULT_SETTINGS };
const store = createRuntimeStore();
let initializationPromise = null;
let finalizingPromise = null;
const knownLineSignatures = new Map();
let pendingStopDetail = "";
let lastHistoryWriteError = "";

function initialize() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const [localValues, restored] = await Promise.all([
      chrome.storage.local.get([SETTINGS_KEY]),
      store.rehydrate()
    ]);
    try {
      settingsCache = migrateLegacySettings(localValues[SETTINGS_KEY]);
      if (
        localValues[SETTINGS_KEY] &&
        localValues[SETTINGS_KEY].translationMode === undefined
      ) {
        await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
      }
    } catch {
      // Keep API keys and other valid fields if only one setting (usually the
      // legacy wsUrl) is malformed.
      settingsCache = normalizeSettings({
        ...(localValues[SETTINGS_KEY] || {}),
        wsUrl: DEFAULT_SETTINGS.wsUrl
      });
      await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
    }
    if (!localValues[SETTINGS_KEY]) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
    }
    if (restored) {
      scheduler.restore({
        usage: restored.translation?.usage,
        error: restored.translation?.error
      });
    }
    await updateBadge();
    if (store.state.active && !(await hasOffscreenDocument())) {
      await finalizeSession(
        "error",
        "浏览器后台采集页面已中断，请重新开始",
        { quiet: true }
      );
    } else if (store.state.active && apiTranslationActive()) {
      // The service worker can be recycled mid-session. Rebuild the pending
      // queue from the restored runtime lines; none of the queue/timers are
      // persisted in memory.
      scheduler.resume();
    }
  })();
  return initializationPromise;
}

async function getSettings() {
  await initialize();
  return { ...settingsCache };
}

async function saveSettings(patch) {
  await initialize();
  const merged = { ...settingsCache, ...patch };
  if (patch.translationProvider) {
    // A provider switch must not inherit another provider's endpoint/model,
    // otherwise a DeepSeek key could be sent to a stale custom URL.
    const preset =
      TRANSLATION_PROVIDERS[
        normalizeTranslationProvider(patch.translationProvider)
      ];
    if (!("translationBaseUrl" in patch)) {
      merged.translationBaseUrl = preset.baseUrl;
    }
    if (!("translationModel" in patch)) {
      merged.translationModel = preset.model;
    }
  }
  if (
    patch.translationApiKeys &&
    typeof patch.translationApiKeys === "object"
  ) {
    merged.translationApiKeys = {
      ...settingsCache.translationApiKeys,
      ...patch.translationApiKeys
    };
  }
  if ("translationBaseUrl" in patch) {
    // An explicit endpoint edit must not silently reuse the old key on a new
    // host. Force the user to re-enter it unless this patch also supplies one
    // or the URL is the provider's official preset.
    const provider = normalizeTranslationProvider(
      merged.translationProvider
    );
    const preset = TRANSLATION_PROVIDERS[provider];
    let nextUrl;
    try {
      nextUrl = normalizeTranslationBaseUrl(
        patch.translationBaseUrl,
        merged.translationBaseUrl
      );
    } catch {
      nextUrl = merged.translationBaseUrl;
    }
    const providedKey =
      patch.translationApiKeys &&
      typeof patch.translationApiKeys === "object" &&
      provider in patch.translationApiKeys;
    if (
      !providedKey &&
      nextUrl !== preset.baseUrl &&
      settingsCache.translationBaseUrl !== nextUrl
    ) {
      merged.translationApiKeys = {
        ...merged.translationApiKeys,
        [provider]: ""
      };
    }
  }
  settingsCache = normalizeSettings(merged);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  await broadcastToExtension({
    type: "settings-changed",
    settings: settingsForBroadcast(settingsCache)
  });
  if (translationSettingsChanged(patch)) scheduler.handleConfigChanged();
  await applyOverlaySetting();
  return settingsForBroadcast(settingsCache);
}

function translationSettingsChanged(patch = {}) {
  return [
    "translationMode",
    "translationProvider",
    "translationBaseUrl",
    "translationModel",
    "translationApiKeys",
    "translationTranslatePartial",
    "translationTimeoutMs",
    "glossaryEnabled",
    "glossaryPresetIds",
    "glossaryDomainHint",
    "customGlossary"
  ].some((key) => key in patch);
}

async function updateBadge() {
  if (store.state.active) {
    await chrome.action.setBadgeBackgroundColor({ color: "#c6412c" });
    await chrome.action.setBadgeText({
      text: store.state.status === "reconnecting" ? "..." : "REC"
    });
    await chrome.action.setTitle({
      title: store.state.detail || "声幕正在采集标签页音频"
    });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "声幕 - 实时字幕翻译" });
  }
}

async function broadcastToExtension(message) {
  try {
    await chrome.runtime.sendMessage({
      target: "extension-view",
      ...message,
      state: store.snapshot()
    });
  } catch {
    // No extension view is open.
  }
}

async function sendToTab(message) {
  if (!store.state.tabId) return false;
  try {
    await chrome.tabs.sendMessage(store.state.tabId, {
      target: "content",
      ...message
    });
    return true;
  } catch {
    return false;
  }
}

async function broadcastCaptionState() {
  await sendToTab({
    type: "caption-state",
    payload: {
      active: store.state.active,
      status: store.state.status,
      detail: store.state.detail,
      lineCount: store.state.lineCount,
      wsConnected: store.state.wsConnected,
      updatedAt: store.state.updatedAt,
      overlayError: store.state.overlayError || "",
      current: safeClone(store.state.current)
    },
    settings: settingsForCaptions(settingsCache)
  });
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture one tab, play its audio, and stream PCM to local captions."
  });
  await delay(120);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function messageOffscreen(message) {
  await ensureOffscreenDocument();
  try {
    return await chrome.runtime.sendMessage({
      target: "offscreen",
      ...message
    });
  } catch (error) {
    throw new Error(`无法联系音频采集页面：${error?.message || error}`, { cause: error });
  }
}

async function injectOverlay(tabId = store.state.tabId) {
  if (!tabId) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/overlay-history.js", "content/content-overlay.js"]
    });
  } catch (error) {
    console.warn("声幕页面浮层注入失败", error);
    await reportOverlayFailure(error);
    return false;
  }
  try {
    // A content script that threw during startup has no listener yet; the
    // sendMessage rejection is the only signal the worker ever gets, so treat
    // it as an injection failure instead of swallowing it.
    const response = await chrome.tabs.sendMessage(tabId, {
      target: "content",
      type: "init",
      settings: settingsForCaptions(settingsCache),
      state: store.snapshot()
    });
    if (response && response.ok === false) {
      throw new Error(response.error || "浮层初始化被拒绝");
    }
  } catch (error) {
    console.warn("声幕页面浮层没有响应", error);
    await reportOverlayFailure(error);
    return false;
  }
  if (store.state.overlayError) await reportOverlayFailure(null);
  return true;
}

// Surfaced in the popup so a broken overlay never fails silently: the switch
// stays on while nothing appears, which reads as "the toggle does nothing".
async function reportOverlayFailure(error) {
  if (!applyOverlayFailure(store.state, error)) return;
  await store.persist(true);
  // Both audiences matter: the content script needs the caption state, and the
  // extension views need the new overlayError to show or clear the hint.
  await broadcastToExtension({ type: "status" });
  await broadcastCaptionState();
}

async function hideOverlay() {
  await sendToTab({ type: "hide-overlay" });
}

async function applyOverlaySetting() {
  if (!store.state.tabId) return;
  if (settingsCache.overlayEnabled) {
    // injectOverlay() records overlayError (and broadcasts) on its own, so a
    // failure must not trigger a second, identical broadcast here.
    const injected = await injectOverlay(store.state.tabId);
    if (injected) await broadcastCaptionState();
  } else {
    await hideOverlay();
  }
}

async function findMonitorTab() {
  const monitorUrl = chrome.runtime.getURL(MONITOR_URL);
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => (tab.url || "").startsWith(monitorUrl)) || null;
}

async function openMonitorWindow(options = {}) {
  await initialize();
  const query = options.welcome ? "?welcome=1" : "";
  const url = chrome.runtime.getURL(`${MONITOR_URL}${query}`);
  const existing = await findMonitorTab();
  if (existing?.id) {
    await chrome.windows.update(existing.windowId, { focused: true });
    if (existing.url !== url && existing.id) {
      await chrome.tabs.update(existing.id, { url, active: true });
    }
    return existing;
  }
  const bounds = { width: 1160, height: 760, left: 80, top: 60 };
  try {
    return await chrome.windows.create({ url, type: "popup", focused: true, ...bounds });
  } catch (error) {
    // Chrome rejects bounds that leave less than half the window on screen
    // (small or scaled displays); let it pick a placement instead.
    if (!/bounds/i.test(String(error?.message))) throw error;
    return chrome.windows.create({ url, type: "popup", focused: true });
  }
}

async function notifyHistoryChanged(sessionId) {
  await chrome.storage.local.set({ [HISTORY_CHANGED_KEY]: Date.now() });
  await broadcastToExtension({
    type: "history-changed",
    sessionId
  });
}

async function commitHistoryBatch(lines) {
  const bySession = new Map();
  for (const line of lines || []) {
    if (!line?.sessionId) continue;
    if (!bySession.has(line.sessionId)) bySession.set(line.sessionId, []);
    bySession.get(line.sessionId).push(line);
  }

  for (const [sessionId, sessionLines] of bySession) {
    await upsertHistoryLines(sessionLines);
    const count = await countHistoryLines(sessionId);
    const lastLine = [...sessionLines]
      .filter((line) => line.source || line.translation)
      .sort((left, right) => (left.order || 0) - (right.order || 0))
      .at(-1);
    const isCurrentSession = sessionId === store.state.sessionId;
    if (isCurrentSession) store.state.lineCount = count;
    const patch = {
      lineCount: count,
      preview: lastLine?.translation || lastLine?.source || ""
    };
    if (isCurrentSession) {
      patch.status = store.state.active ? "capturing" : store.state.status;
    }
    await updateHistorySession(sessionId, patch);
    if (isCurrentSession) {
      if (lastHistoryWriteError) {
        lastHistoryWriteError = "";
        if (store.state.detail.startsWith("字幕历史写入失败")) {
          store.state.detail = "字幕历史已恢复写入";
        }
      }
      await store.persist(true);
      await broadcastToExtension({ type: "line-count", lineCount: count });
    }
  }
}

function handleHistoryWriteError(error) {
  lastHistoryWriteError = error?.message || String(error);
  console.error("声幕历史字幕写入失败", error);
  if (!store.state.active) return;
  store.state.detail = `字幕历史写入失败，正在重试：${lastHistoryWriteError}`;
  store.state.updatedAt = Date.now();
  void store.persist();
  void broadcastToExtension({
    type: "status",
    status: {
      state: store.state.status,
      detail: store.state.detail,
      wsConnected: store.state.wsConnected
    }
  });
}

const historyWriteQueue = new HistoryWriteQueue({
  writeBatch: commitHistoryBatch,
  debounceMs: LINE_FLUSH_DELAY_MS,
  onError: handleHistoryWriteError
});

async function flushPendingHistory(force = false) {
  if (!force) {
    historyWriteQueue.schedule();
    return;
  }
  await historyWriteQueue.flush({ drain: true });
}

async function summarizeHistorySession(sessionId) {
  const lines = await getHistoryLines(sessionId);
  const ordered = [...lines].sort(
    (left, right) => (left.order || 0) - (right.order || 0)
  );
  const lastLine = ordered.at(-1);
  return {
    lineCount: ordered.length,
    translationMissing: ordered.filter(lineNeedsTranslation).length,
    preview: lastLine?.translation || lastLine?.source || ""
  };
}

function translationConfig() {
  const base = resolveTranslationConfig(settingsCache);
  const glossary = resolveEffectiveGlossary(settingsCache);
  return {
    ...base,
    glossaryEntries: glossary.entries,
    domainHint: glossary.domainHint
  };
}

function buildSessionWsUrl(baseWsUrl, settings = settingsCache) {
  const url = new URL(baseWsUrl);
  const glossary = resolveEffectiveGlossary(settings);
  const asrContext = glossary.enabled
    ? buildAsrContextPrompt(glossary.asrEntries)
    : "";
  if (asrContext) {
    url.searchParams.set("context", asrContext);
  } else {
    url.searchParams.delete("context");
  }
  return url.toString();
}

function apiTranslationActive() {
  return translationConfig().enabled;
}

// Persists and broadcasts the caption state after the scheduler patched it.
async function publishCaptionState() {
  await store.persist();
  await broadcastToExtension({
    type: "caption-state",
    current: safeClone(store.state.current),
    lineCount: store.state.lineCount
  });
  await broadcastCaptionState();
  await flushPendingHistory(false);
}

const scheduler = createTranslationScheduler({
  getState: () => store.state,
  getConfig: translationConfig,
  isApiEnabled: apiTranslationActive,
  partialEnabled: () => Boolean(settingsCache.translationTranslatePartial),
  translateTexts,
  knownLines: knownLineSignatures,
  enqueueHistory: (lines) => historyWriteQueue.enqueue(lines),
  publish: publishCaptionState
});

async function testTranslationApi() {
  const config = translationConfig();
  if (config.mode !== "api") {
    throw new Error("当前翻译引擎是本地服务端，不需要测试 API");
  }
  const issue = translationConfigIssue(config);
  if (issue) throw new Error(issue);
  const result = await testTranslationConnection(config);
  return {
    ok: true,
    translation: result.translation,
    model: result.model,
    latencyMs: result.latencyMs
  };
}

async function resetSessionMemory() {
  knownLineSignatures.clear();
}

// Two start requests (double click, popup plus shortcut) would both pass the
// `active` check before either replaced the runtime state and leave an orphaned
// session, so starts run one at a time and the later one wins.
let startQueue = Promise.resolve();

function startSession(message) {
  const run = startQueue.then(() => startSessionNow(message));
  startQueue = run.catch(() => {});
  return run;
}

async function startSessionNow(message) {
  await initialize();
  if (store.state.active) {
    await stopSession({ quiet: true });
  }

  let wsUrl;
  try {
    wsUrl = normalizeWsUrl(message.wsUrl || settingsCache.wsUrl);
  } catch (error) {
    throw new Error(error?.message || String(error), { cause: error });
  }
  settingsCache = normalizeSettings({ ...settingsCache, wsUrl });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });

  const translation = translationConfig();
  if (translation.mode === "api") {
    const issue = translationConfigIssue(translation);
    if (issue) {
      throw new Error(
        `${issue}。请在扩展控制面板的“翻译引擎”中完成配置，或切换为本地服务端。`
      );
    }
  } else {
    try {
      const response = await fetch("http://127.0.0.1:8013/health", {
        signal: AbortSignal.timeout(1600)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      throw new Error(
        "本地服务端翻译不可用（127.0.0.1:8013）。如果只想跑 ASR，请把翻译引擎切换为 API。"
      );
    }
  }

  const sessionId = crypto.randomUUID();
  const startedAt = Date.now();
  const metadata = {
    id: sessionId,
    startedAt,
    title: message.tabTitle || "未命名直播",
    url: message.tabUrl || "",
    tabId: message.targetTabId ?? null,
    wsUrl,
    translationMode: translation.mode,
    translationProvider: translation.mode === "api" ? translation.provider : "",
    translationModel: translation.mode === "api" ? translation.model : "",
    status: "starting",
    lineCount: 0,
    preview: ""
  };
  await resetSessionMemory();
  scheduler.reset();
  await createHistorySession(metadata);
  pendingStopDetail = "";

  store.replace({
    active: true,
    status: "starting",
    detail: "正在建立音频采集",
    sessionId,
    tabId: message.targetTabId ?? null,
    tabTitle: metadata.title,
    tabUrl: metadata.url,
    startedAt,
    updatedAt: startedAt,
    current: structuredClone(EMPTY_RUNTIME_STATE.current)
  });
  scheduler.refreshSummary();
  await store.persist(true);
  await updateBadge();
  await broadcastToExtension({
    type: "session-state",
    session: metadata
  });
  await notifyHistoryChanged(sessionId);

  let result;
  try {
    result = await messageOffscreen({
      type: "start-capture",
      sessionId,
      targetTabId: message.targetTabId,
      streamId: message.streamId,
      wsUrl: buildSessionWsUrl(wsUrl, settingsCache)
    });
    if (!result?.ok) throw new Error(result?.error || "音频采集启动失败");
  } catch (error) {
    await finalizeSession("error", error?.message || String(error), {
      quiet: true
    });
    throw error;
  }

  if (settingsCache.overlayEnabled) {
    await injectOverlay(store.state.tabId);
  }
  let warning = "";
  if (settingsCache.openPanelOnStart) {
    try {
      await openMonitorWindow();
    } catch (error) {
      warning = `字幕窗口未能自动打开：${error?.message || error}`;
      store.state.detail = warning;
      store.state.updatedAt = Date.now();
      await store.persist(true);
      await broadcastToExtension({ type: "session-state" });
    }
  }
  return { ok: true, sessionId, warning };
}

async function finalizeSession(status, detail, options = {}) {
  if (finalizingPromise) return finalizingPromise;
  finalizingPromise = (async () => {
    const sessionId = store.state.sessionId;
    let finalStatus = status;
    let finalDetail = detail || store.state.detail;
    let lineCount = store.state.lineCount || 0;
    let translationMissing = 0;
    let preview =
      store.state.current?.lines?.at(-1)?.translation ||
      store.state.current?.lines?.at(-1)?.source ||
      "";

    try {
      try {
        await scheduler.settle(
          finalStatus === "error" ? 2500 : TRANSLATION_STOP_TIMEOUT_MS
        );
        // Invalidate any request that outlived the stop deadline so it cannot
        // write history after the final flush/summary.
        scheduler.invalidate();
        await flushPendingHistory(true);
      } catch (error) {
        finalStatus = "error";
        finalDetail = `字幕历史写入失败：${error?.message || error}`;
      }

      if (sessionId) {
        try {
          const summary = await summarizeHistorySession(sessionId);
          lineCount = summary.lineCount;
          translationMissing = summary.translationMissing;
          preview = summary.preview || preview;
          if (translationMissing > 0 && finalStatus === "stopped") {
            finalStatus = "incomplete";
            finalDetail =
              `${finalDetail}；${translationMissing} 条字幕缺少译文`;
          }
          await updateHistorySession(sessionId, {
            endedAt: Date.now(),
            status: finalStatus,
            lineCount,
            translationMissing,
            preview
          });
        } catch (error) {
          finalStatus = "error";
          finalDetail = `字幕历史收尾失败：${error?.message || error}`;
        }
      }
    } finally {
      store.state.active = false;
      store.state.status = finalStatus;
      store.state.detail = finalDetail || store.state.detail;
      // The overlay failure belongs to the session that just ended; keeping it
      // would leave a stale warning in the popup and a tabId to re-inject into.
      store.state.overlayError = "";
      store.state.wsConnected = false;
      store.state.lineCount = lineCount;
      store.state.translationMissing = translationMissing;
      store.state.updatedAt = Date.now();
      try {
        await store.persist(true);
        await updateBadge();
      } catch (error) {
        console.error("声幕运行状态收尾失败", error);
      }
      if (!options.quiet) {
        await broadcastToExtension({
          type: "session-ended",
          status: finalStatus,
          detail: store.state.detail
        });
        await broadcastCaptionState();
      }
      if (sessionId) await notifyHistoryChanged(sessionId);
      scheduler.reset({ keepUsage: true });
      pendingStopDetail = "";
    }
  })();
  try {
    return await finalizingPromise;
  } finally {
    finalizingPromise = null;
  }
}

async function stopSession(options = {}) {
  await initialize();
  if (!store.state.active && !(await hasOffscreenDocument())) {
    return { ok: true, alreadyStopped: true };
  }
  if (store.state.active) {
    pendingStopDetail = options.detail || "标签页音频采集已停止";
  }
  try {
    if (await hasOffscreenDocument()) {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "stop-capture",
        quiet: true
      });
    }
  } catch (error) {
    console.warn("声幕停止采集时出现错误", error);
  }
  await finalizeSession(
    options.status || "stopped",
    pendingStopDetail || options.detail || "标签页音频采集已停止",
    { quiet: options.quiet === true }
  );
  return { ok: true };
}

async function handleStatusReport(message) {
  if (
    message.sessionId &&
    store.state.sessionId &&
    message.sessionId !== store.state.sessionId
  ) {
    return;
  }
  const status = message.status || {};
  if (!store.state.active) return;
  store.state.status = status.state || store.state.status;
  store.state.detail = status.detail || store.state.detail;
  store.state.wsConnected = Boolean(status.wsConnected);
  store.state.audio = status.audio || store.state.audio;
  store.state.captureInfo = status.captureInfo || store.state.captureInfo;
  store.state.updatedAt = status.updatedAt || Date.now();
  await store.persist();
  await updateBadge();
  await broadcastToExtension({ type: "status", status: safeClone(status) });
  await broadcastCaptionState();

  if (status.state === "error" && status.fatal && store.state.active) {
    await stopSession({
      status: "error",
      detail: status.detail || "字幕服务发生致命错误"
    });
    return;
  }
  if (status.state === "stopped" && store.state.active) {
    await finalizeSession(
      "stopped",
      pendingStopDetail || status.detail || "采集已停止"
    );
  }
}

async function refreshSourceMetadata(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const title = String(tab.title || store.state.tabTitle || "未命名直播");
  const url = String(tab.url || store.state.tabUrl || "");
  if (title === store.state.tabTitle && url === store.state.tabUrl) return;

  store.state.tabTitle = title;
  store.state.tabUrl = url;
  store.state.updatedAt = Date.now();
  if (store.state.sessionId) {
    await updateHistorySession(store.state.sessionId, {
      title,
      url,
      updatedAt: store.state.updatedAt
    });
  }
  await store.persist(true);
  await broadcastToExtension({ type: "session-state" });
}

async function handleTranscriptUpdate(message) {
  if (!store.state.active || message.sessionId !== store.state.sessionId) return;
  const apiConfig = translationConfig();
  const useApi = apiConfig.mode === "api" && apiConfig.enabled;
  const next = reduceTranscriptUpdate(store.state, message, {
    knownLines: knownLineSignatures,
    useApi,
    apiError: scheduler.lastError,
    now: Date.now()
  });
  for (const line of next.historyLines) {
    knownLineSignatures.set(line.id, rememberLine(line));
  }
  if (next.historyLines.length > 0) historyWriteQueue.enqueue(next.historyLines);
  Object.assign(store.state, next.patch);
  scheduler.refreshSummary();

  if (useApi && next.bufferChanged) scheduler.abortStaleBuffer();

  await store.persist();
  await broadcastToExtension({
    type: "caption-state",
    current: safeClone(store.state.current),
    epochId: message.epochId,
    lineCount: store.state.lineCount
  });
  await broadcastCaptionState();
  await flushPendingHistory(false);

  if (useApi) {
    scheduler.scheduleLines();
    scheduler.scheduleBuffer();
  }
}

async function handleAudioStats(message) {
  if (message.sessionId && message.sessionId !== store.state.sessionId) return;
  store.state.audio = message.audio || store.state.audio;
  store.state.updatedAt = Date.now();
  await broadcastToExtension({
    type: "audio-stats",
    audio: safeClone(store.state.audio)
  });
  await store.persist();
}

async function probeServices() {
  const settings = await getSettings();
  const translation = resolveTranslationConfig(settings);
  let wsHost = "127.0.0.1";
  let wsPort = "8010";
  let healthProtocol = "http:";
  try {
    const wsUrl = new URL(settings.wsUrl);
    wsHost = wsUrl.hostname;
    wsPort = wsUrl.port || (wsUrl.protocol === "wss:" ? "443" : "80");
    healthProtocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
  } catch {
    // Keep local defaults; settings validation normally prevents this path.
  }
  const services = [];
  try {
    const response = await fetch(`${healthProtocol}//${wsHost}:${wsPort}/health`, {
      signal: AbortSignal.timeout(1600)
    });
    services.push({
      key: "asr",
      ok: response.ok,
      detail: response.ok ? "ASR 服务在线" : `HTTP ${response.status}`
    });
  } catch {
    services.push({ key: "asr", ok: false, detail: "未连接" });
  }

  if (translation.mode === "server") {
    try {
      const response = await fetch("http://127.0.0.1:8013/health", {
        signal: AbortSignal.timeout(1600)
      });
      services.push({
        key: "translation",
        ok: response.ok,
        detail: response.ok ? "本地翻译服务在线" : `HTTP ${response.status}`
      });
    } catch {
      services.push({ key: "translation", ok: false, detail: "未连接" });
    }
  } else {
    services.push({
      key: "translation",
      ok: Boolean(translation.enabled),
      detail: translation.enabled
        ? `${translation.providerLabel} 已配置（点“测试翻译 API”验证）`
        : translation.issue || "尚未配置翻译 API"
    });
  }
  return services;
}

function isExtensionPageSender(sender) {
  const url = String(sender?.url || "");
  if (url) return url.startsWith(chrome.runtime.getURL(""));
  return sender?.id === chrome.runtime.id && !sender?.tab;
}

function rejectNonExtensionSender(sendResponse) {
  sendResponse({ ok: false, error: "此操作只能从声幕扩展界面发起" });
}

chrome.runtime.onInstalled.addListener((details) => {
  void initialize().then(async () => {
    if (details.reason === "install") {
      await openMonitorWindow({ welcome: true });
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    try {
      await initialize();
      const fromOffscreen =
        message?.source === "offscreen" &&
        String(sender?.url || "").startsWith(
          chrome.runtime.getURL(OFFSCREEN_URL)
        );
      const toBackground = message?.target === "background";
      const toContent = message?.target === "content";

      if (fromOffscreen) {
        if (message.type === "status-report") {
          await handleStatusReport(message);
        } else if (message.type === "transcript-update") {
          await handleTranscriptUpdate(message);
        } else if (message.type === "audio-stats") {
          await handleAudioStats(message);
        }
        sendResponse({ ok: true });
        return;
      }

      if (toContent) {
        sendResponse({ ok: true });
        return;
      }

      if (!toBackground) {
        sendResponse({ ok: false });
        return;
      }

      if (message.type === "start-capture") {
        if (!isExtensionPageSender(sender)) {
          rejectNonExtensionSender(sendResponse);
          return;
        }
        sendResponse(await startSession(message));
      } else if (message.type === "stop-capture") {
        if (!isExtensionPageSender(sender)) {
          rejectNonExtensionSender(sendResponse);
          return;
        }
        sendResponse(await stopSession());
      } else if (message.type === "get-state") {
        sendResponse({
          ok: true,
          state: store.snapshot(),
          settings: settingsForBroadcast(settingsCache)
        });
      } else if (message.type === "get-settings") {
        sendResponse({
          ok: true,
          settings: settingsForBroadcast(settingsCache)
        });
      } else if (message.type === "save-settings") {
        sendResponse({
          ok: true,
          settings: await saveSettings(
            sanitizeSettingsPatch(message.settings, {
              fromExtensionPage: isExtensionPageSender(sender)
            })
          )
        });
      } else if (message.type === "test-translation-api") {
        if (!isExtensionPageSender(sender)) {
          rejectNonExtensionSender(sendResponse);
          return;
        }
        try {
          sendResponse({ ok: true, result: await testTranslationApi() });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error?.message || String(error)
          });
        }
      } else if (message.type === "open-monitor") {
        await openMonitorWindow();
        sendResponse({ ok: true });
      } else if (message.type === "toggle-overlay") {
        const next = !settingsCache.overlayEnabled;
        const saved = await saveSettings({ overlayEnabled: next });
        sendResponse({ ok: true, settings: saved, enabled: next });
      } else if (message.type === "show-overlay") {
        const saved = await saveSettings({ overlayEnabled: true });
        sendResponse({ ok: true, settings: saved });
      } else if (message.type === "hide-overlay") {
        const saved = await saveSettings({ overlayEnabled: false });
        sendResponse({ ok: true, settings: saved });
      } else if (message.type === "refresh-overlay") {
        if (!isExtensionPageSender(sender)) {
          rejectNonExtensionSender(sendResponse);
          return;
        }
        if (!store.state.active || !store.state.tabId) {
          sendResponse({ ok: false, error: "当前没有正在采集的标签页" });
          return;
        }
        const injected = await injectOverlay();
        sendResponse({
          ok: injected,
          error: injected
            ? ""
            : store.state.overlayError || "页面浮层没有响应"
        });
      } else if (message.type === "content-ready") {
        // The content script finished initializing on its own: whatever init
        // handshake failed earlier is stale now.
        if (
          store.state.overlayError &&
          sender?.tab?.id &&
          sender.tab.id === store.state.tabId
        ) {
          await reportOverlayFailure(null);
        }
        sendResponse({
          ok: true,
          state: store.snapshot(),
          settings: settingsForBroadcast(settingsCache)
        });
      } else if (message.type === "probe-services") {
        sendResponse({ ok: true, services: await probeServices() });
      } else {
        sendResponse({ ok: false, error: `未知消息：${message.type}` });
      }
    } catch (error) {
      console.error("声幕后台错误", error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open_caption_window") {
    void openMonitorWindow();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (store.state.active && tabId === store.state.tabId) {
    void stopSession({ detail: "直播标签页已关闭" });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== store.state.tabId || !store.state.active) return;
  if (
    !changeInfo.title &&
    !changeInfo.url &&
    changeInfo.status !== "complete"
  ) {
    return;
  }
  void (async () => {
    await refreshSourceMetadata(tabId);
    if (changeInfo.status === "complete") {
      if (settingsCache.overlayEnabled) {
        await injectOverlay(tabId);
      }
      await broadcastCaptionState();
    }
  })();
});

void initialize();
