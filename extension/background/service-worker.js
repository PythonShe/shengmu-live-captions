import {
  DEFAULT_SETTINGS,
  EMPTY_RUNTIME_STATE,
  HISTORY_CHANGED_KEY,
  RUNTIME_STATE_KEY,
  SETTINGS_KEY,
  applyOverlayFailure,
  getTranslationText,
  lineChanged,
  lineNeedsTranslation,
  mergeCaptionFragments,
  mergeCaptionLines,
  migrateLegacySettings,
  normalizeCaptionLines,
  normalizeSettings,
  normalizeWsUrl,
  sanitizeSettingsPatch,
  selectDisplayCaption,
  settingsForBroadcast,
  settingsForCaptions
} from "../lib/caption-utils.js";
import {
  buildAsrContextPrompt,
  resolveEffectiveGlossary
} from "../lib/glossary.js";
import {
  TRANSLATION_PROVIDERS,
  isAbortError,
  normalizeTranslationBaseUrl,
  normalizeTranslationProvider,
  recentTranslationContext,
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
import { polishTranslation, stripSpeechFillers } from "../lib/speech-cleanup.js";
import { planTranslationBatch } from "../lib/utterance.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";
const MONITOR_URL = "subtitle/subtitle.html";
const LINE_FLUSH_DELAY_MS = 700;
const STATE_PERSIST_DELAY_MS = 350;
const TRANSLATION_LINE_DEBOUNCE_MS = 160;
const TRANSLATION_LINE_BATCH_SIZE = 6;
const TRANSLATION_LINE_MAX_ATTEMPTS = 3;
const TRANSLATION_LINE_RETRY_DELAYS_MS = [1200, 3000];
const TRANSLATION_BUFFER_DEBOUNCE_MS = 450;
const TRANSLATION_BUFFER_MIN_INTERVAL_MS = 1200;
const TRANSLATION_STOP_TIMEOUT_MS = 15000;

let settingsCache = { ...DEFAULT_SETTINGS };
let runtimeState = structuredClone(EMPTY_RUNTIME_STATE);
let initializationPromise = null;
let currentEpochLines = [];
let statePersistTimer = null;
let finalizingPromise = null;
let knownLineSignatures = new Map();
let pendingStopDetail = "";
let lastHistoryWriteError = "";

let translationPending = new Map();
let translationFailed = new Map();
let translationFlushTimer = null;
let translationFlushPromise = null;
let translationRetryTimer = null;
let translationBufferTimer = null;
let translationBufferInFlight = false;
let translationBufferAbort = null;
let translationLineAbort = null;
let translationBufferRequestedText = "";
let translationBufferLastRequestAt = 0;
let translationUsage = { requests: 0, promptTokens: 0, completionTokens: 0 };
let translationLastError = "";
let translationGeneration = 0;

function safeClone(value) {
  return value == null ? value : structuredClone(value);
}

function compactRuntimeState() {
  return {
    ...safeClone(runtimeState),
    current: {
      ...safeClone(runtimeState.current),
      lines: (runtimeState.current?.lines || []).slice(-120)
    }
  };
}

function initialize() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const [localValues, sessionValues] = await Promise.all([
      chrome.storage.local.get([SETTINGS_KEY]),
      chrome.storage.session.get([RUNTIME_STATE_KEY])
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
    if (sessionValues[RUNTIME_STATE_KEY]) {
      runtimeState = {
        ...structuredClone(EMPTY_RUNTIME_STATE),
        ...sessionValues[RUNTIME_STATE_KEY],
        current: {
          ...structuredClone(EMPTY_RUNTIME_STATE.current),
          ...(sessionValues[RUNTIME_STATE_KEY].current || {})
        }
      };
      const storedUsage = runtimeState.translation?.usage;
      if (storedUsage) {
        translationUsage = {
          requests: Number(storedUsage.requests) || 0,
          promptTokens: Number(storedUsage.promptTokens) || 0,
          completionTokens: Number(storedUsage.completionTokens) || 0
        };
      }
      translationLastError = runtimeState.translation?.error || "";
    }
    await updateBadge();
    if (runtimeState.active && !(await hasOffscreenDocument())) {
      await finalizeSession(
        "error",
        "浏览器后台采集页面已中断，请重新开始",
        { quiet: true }
      );
    } else if (runtimeState.active && apiTranslationActive()) {
      // The service worker can be recycled mid-session. Rebuild the pending
      // queue from the restored runtime lines; none of the queue/timers are
      // persisted in memory.
      scheduleLineTranslations(0);
      scheduleBufferTranslation();
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
    let nextUrl = merged.translationBaseUrl;
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
  if (translationSettingsChanged(patch)) {
    translationFailed.clear();
    translationLastError = "";
    clearTimeout(translationRetryTimer);
    translationRetryTimer = null;
    cancelBufferTranslation();
    translationBufferRequestedText = "";
    if (runtimeState.active && apiTranslationActive()) {
      scheduleLineTranslations(0);
      scheduleBufferTranslation();
    }
  }
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

async function persistRuntimeState(immediate = false) {
  if (!immediate) {
    clearTimeout(statePersistTimer);
    statePersistTimer = setTimeout(() => {
      statePersistTimer = null;
      void chrome.storage.session.set({
        [RUNTIME_STATE_KEY]: compactRuntimeState()
      });
    }, STATE_PERSIST_DELAY_MS);
    return;
  }
  clearTimeout(statePersistTimer);
  statePersistTimer = null;
  await chrome.storage.session.set({
    [RUNTIME_STATE_KEY]: compactRuntimeState()
  });
}

async function updateBadge() {
  if (runtimeState.active) {
    await chrome.action.setBadgeBackgroundColor({ color: "#c6412c" });
    await chrome.action.setBadgeText({
      text: runtimeState.status === "reconnecting" ? "..." : "REC"
    });
    await chrome.action.setTitle({
      title: runtimeState.detail || "声幕正在采集标签页音频"
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
      state: compactRuntimeState()
    });
  } catch {
    // No extension view is open.
  }
}

async function sendToTab(message) {
  if (!runtimeState.tabId) return false;
  try {
    await chrome.tabs.sendMessage(runtimeState.tabId, {
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
      active: runtimeState.active,
      status: runtimeState.status,
      detail: runtimeState.detail,
      lineCount: runtimeState.lineCount,
      wsConnected: runtimeState.wsConnected,
      updatedAt: runtimeState.updatedAt,
      overlayError: runtimeState.overlayError || "",
      current: safeClone(runtimeState.current)
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
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function messageOffscreen(message) {
  await ensureOffscreenDocument();
  try {
    return await chrome.runtime.sendMessage({
      target: "offscreen",
      ...message
    });
  } catch (error) {
    throw new Error(`无法联系音频采集页面：${error?.message || error}`);
  }
}

async function injectOverlay(tabId = runtimeState.tabId) {
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
      state: compactRuntimeState()
    });
    if (response && response.ok === false) {
      throw new Error(response.error || "浮层初始化被拒绝");
    }
  } catch (error) {
    console.warn("声幕页面浮层没有响应", error);
    await reportOverlayFailure(error);
    return false;
  }
  if (runtimeState.overlayError) await reportOverlayFailure(null);
  return true;
}

// Surfaced in the popup so a broken overlay never fails silently: the switch
// stays on while nothing appears, which reads as "the toggle does nothing".
async function reportOverlayFailure(error) {
  if (!applyOverlayFailure(runtimeState, error)) return;
  await persistRuntimeState(true);
  // Both audiences matter: the content script needs the caption state, and the
  // extension views need the new overlayError to show or clear the hint.
  await broadcastToExtension({ type: "status" });
  await broadcastCaptionState();
}

async function hideOverlay() {
  await sendToTab({ type: "hide-overlay" });
}

async function applyOverlaySetting() {
  if (!runtimeState.tabId) return;
  if (settingsCache.overlayEnabled) {
    // injectOverlay() records overlayError (and broadcasts) on its own, so a
    // failure must not trigger a second, identical broadcast here.
    const injected = await injectOverlay(runtimeState.tabId);
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
  const created = await chrome.windows.create({
    url,
    type: "popup",
    width: 1160,
    height: 760,
    left: 80,
    top: 60,
    focused: true
  });
  return created;
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
    const isCurrentSession = sessionId === runtimeState.sessionId;
    if (isCurrentSession) runtimeState.lineCount = count;
    const patch = {
      lineCount: count,
      preview: lastLine?.translation || lastLine?.source || ""
    };
    if (isCurrentSession) {
      patch.status = runtimeState.active ? "capturing" : runtimeState.status;
    }
    await updateHistorySession(sessionId, patch);
    if (isCurrentSession) {
      if (lastHistoryWriteError) {
        lastHistoryWriteError = "";
        if (runtimeState.detail.startsWith("字幕历史写入失败")) {
          runtimeState.detail = "字幕历史已恢复写入";
        }
      }
      await persistRuntimeState(true);
      await broadcastToExtension({ type: "line-count", lineCount: count });
    }
  }
}

function handleHistoryWriteError(error) {
  lastHistoryWriteError = error?.message || String(error);
  console.error("声幕历史字幕写入失败", error);
  if (!runtimeState.active) return;
  runtimeState.detail = `字幕历史写入失败，正在重试：${lastHistoryWriteError}`;
  runtimeState.updatedAt = Date.now();
  void persistRuntimeState();
  void broadcastToExtension({
    type: "status",
    status: {
      state: runtimeState.status,
      detail: runtimeState.detail,
      wsConnected: runtimeState.wsConnected
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

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

function refreshTranslationSummary() {
  const config = translationConfig();
  runtimeState.translation = {
    mode: config.mode,
    provider: config.provider,
    providerLabel: config.providerLabel,
    model: config.model,
    enabled: config.enabled,
    usage: { ...translationUsage },
    error: translationLastError
  };
}

function abortLineTranslation() {
  if (!translationLineAbort) return;
  try {
    translationLineAbort.abort();
  } catch {
    // Ignore abort races.
  }
  translationLineAbort = null;
}

function resetTranslationMemory({ keepUsage = false } = {}) {
  translationGeneration += 1;
  clearTimeout(translationFlushTimer);
  clearTimeout(translationRetryTimer);
  translationFlushTimer = null;
  translationRetryTimer = null;
  translationFlushPromise = null;
  abortLineTranslation();
  translationPending.clear();
  translationFailed.clear();
  translationLastError = "";
  cancelBufferTranslation();
  translationBufferRequestedText = "";
  translationBufferLastRequestAt = 0;
  if (!keepUsage) {
    translationUsage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  }
  refreshTranslationSummary();
}

function addTranslationUsage(usage) {
  translationUsage.requests += 1;
  translationUsage.promptTokens += Number(usage?.promptTokens) || 0;
  translationUsage.completionTokens += Number(usage?.completionTokens) || 0;
}

function shouldRetryTranslationError(error) {
  return ![
    "auth",
    "balance",
    "config",
    "bad_request",
    "thinking_only",
    "empty_translation",
    "truncated"
  ].includes(error?.code);
}

function updateRuntimeLine(lineId, patch) {
  const lines = runtimeState.current?.lines || [];
  const line = lines.find((item) => item?.id === lineId);
  if (line) Object.assign(line, patch);
  const epochLine = currentEpochLines.find((item) => item?.id === lineId);
  if (epochLine) Object.assign(epochLine, patch);
  return line || null;
}

function markLineTranslationFailed(lineId) {
  const patch = { translationPending: false, translationFailed: true };
  const line =
    updateRuntimeLine(lineId, patch) || knownLineSignatures.get(lineId);
  if (!line) return;
  const updated = { ...line, ...patch };
  knownLineSignatures.set(lineId, updated);
  historyWriteQueue.enqueue([updated]);
}

async function broadcastCaptionUpdate() {
  if (!runtimeState.current) return;
  if (translationConfig().mode === "api") {
    runtimeState.current.translationError = translationLastError;
  }
  runtimeState.current.displayCaption = selectDisplayCaption(
    runtimeState.current
  );
  refreshTranslationSummary();
  await persistRuntimeState();
  await broadcastToExtension({
    type: "caption-state",
    current: safeClone(runtimeState.current),
    lineCount: runtimeState.lineCount
  });
  await broadcastCaptionState();
  await flushPendingHistory(false);
}

async function applyLineTranslations(entries, translations, fallback = false) {
  const generation = translationGeneration;
  const applied = [];
  const emptyEntries = [];
  let sourceChanged = false;
  for (let index = 0; index < entries.length; index += 1) {
    if (generation !== translationGeneration) {
      return { applied: 0, sourceChanged, emptyEntries };
    }
    const [lineId, entry] = entries[index];
    const runtimeLine = (runtimeState.current?.lines || []).find(
      (item) => item?.id === lineId
    );
    // A slow response may arrive after the line fell out of the 120-line
    // runtime window. Keep translating it into history from the last known
    // copy instead of silently losing a final subtitle.
    const line = runtimeLine || knownLineSignatures.get(lineId);
    if (!line || line.source !== entry.source) {
      const pending = translationPending.get(lineId);
      if (pending && line?.source) {
        pending.source = line.source;
        pending.attempts = 0;
        pending.fallback = compactText(line.fallbackTranslation);
        sourceChanged = true;
      } else {
        translationPending.delete(lineId);
      }
      continue;
    }
    const text = polishTranslation(compactText(translations[index]));
    if (!text) {
      // The model returned an empty slot. Count it so one untranslatable
      // marker cannot be retried forever and starve later lines.
      emptyEntries.push([lineId, entry]);
      continue;
    }
    const patch = {
      translation: text,
      translationPending: false,
      translationFailed: false,
      translationFallback: fallback
    };
    if (runtimeLine) updateRuntimeLine(lineId, patch);
    const updated = {
      ...line,
      ...patch,
      signature: `${line.source}\u0000${text}`
    };
    knownLineSignatures.set(lineId, updated);
    historyWriteQueue.enqueue([updated]);
    translationPending.delete(lineId);
    applied.push(updated);
  }
  if (applied.length > 0) await broadcastCaptionUpdate();
  return { applied: applied.length, sourceChanged, emptyEntries };
}

async function applyPendingFallbacks() {
  const fallbacks = [];
  for (const [lineId, entry] of [...translationPending.entries()]) {
    if (entry.fallback) {
      fallbacks.push([lineId, entry]);
    } else {
      translationPending.delete(lineId);
      translationFailed.set(lineId, entry.source);
      markLineTranslationFailed(lineId);
    }
  }
  if (fallbacks.length > 0) {
    await applyLineTranslations(
      fallbacks,
      fallbacks.map(([, entry]) => entry.fallback),
      true
    );
  }
}

function collectPendingLineTranslations() {
  if (!apiTranslationActive()) return;
  const lines = runtimeState.current?.lines || [];
  for (const line of lines) {
    if (!line?.id || !line.source || line.translation) continue;
    if (translationFailed.get(line.id) === line.source) continue;
    const existing = translationPending.get(line.id);
    if (existing) {
      if (existing.source !== line.source) {
        existing.source = line.source;
        existing.attempts = 0;
      }
      existing.promptText = stripSpeechFillers(line.source);
      existing.fallback =
        compactText(line.fallbackTranslation) || existing.fallback;
      continue;
    }
    translationPending.set(line.id, {
      source: line.source,
      // Only what leaves for the API is cleaned; the displayed transcript keeps
      // the verbatim ASR text.
      promptText: stripSpeechFillers(line.source),
      attempts: 0,
      fallback: compactText(line.fallbackTranslation),
      // queuedAt lets planTranslationBatch decide when a trailing fragment has
      // waited long enough for the row that would complete its sentence.
      queuedAt: Date.now()
    });
  }
}

function scheduleLineTranslations(delay = TRANSLATION_LINE_DEBOUNCE_MS) {
  if (!apiTranslationActive() || !runtimeState.active) return;
  collectPendingLineTranslations();
  if (translationPending.size === 0) return;
  if (translationRetryTimer) return;
  if (translationFlushTimer || translationFlushPromise) return;
  translationFlushTimer = setTimeout(() => {
    translationFlushTimer = null;
    void flushLineTranslations();
  }, Math.max(0, delay));
}

async function handleTranslationFailure(entries, error) {
  const generation = translationGeneration;
  const message = compactText(error?.message || error);
  translationLastError = message;
  const retryable = shouldRetryTranslationError(error);
  const fallbacks = [];
  let nextRetryAttempts = Infinity;
  for (const [lineId, entry] of entries) {
    if (generation !== translationGeneration) return;
    entry.attempts += 1;
    if (!retryable || entry.attempts >= TRANSLATION_LINE_MAX_ATTEMPTS) {
      if (entry.fallback) {
        fallbacks.push([lineId, entry]);
      } else {
        translationFailed.set(lineId, entry.source);
        markLineTranslationFailed(lineId);
      }
      translationPending.delete(lineId);
    } else {
      nextRetryAttempts = Math.min(nextRetryAttempts, entry.attempts);
    }
  }
  if (fallbacks.length > 0) {
    await applyLineTranslations(
      fallbacks,
      fallbacks.map(([, entry]) => entry.fallback),
      true
    );
  } else {
    await broadcastCaptionUpdate();
  }
  if (
    retryable &&
    Number.isFinite(nextRetryAttempts) &&
    runtimeState.active &&
    generation === translationGeneration
  ) {
    const delay =
      TRANSLATION_LINE_RETRY_DELAYS_MS[
        Math.min(nextRetryAttempts - 1, TRANSLATION_LINE_RETRY_DELAYS_MS.length - 1)
      ];
    clearTimeout(translationRetryTimer);
    translationRetryTimer = setTimeout(() => {
      translationRetryTimer = null;
      scheduleLineTranslations(0);
    }, delay);
  }
}

async function flushLineTranslations() {
  if (translationFlushPromise) return translationFlushPromise;
  const generation = translationGeneration;
  const promise = (async () => {
    for (let round = 0; round < 12; round += 1) {
      if (
        !runtimeState.active ||
        generation !== translationGeneration ||
        !apiTranslationActive()
      ) {
        return;
      }
      collectPendingLineTranslations();
      if (translationPending.size === 0) return;
      // Fragments are translated together with the rows that complete them; a
      // trailing fragment is held briefly instead of becoming an orphan
      // sentence ("他找到了。" with no object on screen).
      const plan = planTranslationBatch([...translationPending.entries()], {
        maxLines: TRANSLATION_LINE_BATCH_SIZE,
        now: Date.now()
      });
      const entries = plan.batch;
      if (entries.length === 0) return;
      const batchIds = new Set(entries.map(([lineId]) => lineId));
      const config = translationConfig();
      if (!config.enabled) {
        const error = new Error(config.issue || "翻译 API 未启用");
        error.code = "config";
        await handleTranslationFailure(entries, error);
        return;
      }
      let result;
      const controller = new AbortController();
      translationLineAbort = controller;
      try {
        result = await translateTexts({
          texts: entries.map(([, entry]) => entry.promptText || entry.source),
          context: recentTranslationContext(
            runtimeState.current?.lines || [],
            undefined,
            batchIds
          ),
          config,
          signal: controller.signal
        });
      } catch (error) {
        if (isAbortError(error)) return;
        await handleTranslationFailure(entries, error);
        return;
      } finally {
        if (translationLineAbort === controller) {
          translationLineAbort = null;
        }
      }
      if (generation !== translationGeneration) return;
      translationLastError = "";
      addTranslationUsage(result.usage);
      const outcome = await applyLineTranslations(
        entries,
        result.translations
      );
      if (outcome.emptyEntries.length > 0) {
        const error = new Error("翻译 API 返回了空译文");
        error.code = "empty_translation";
        await handleTranslationFailure(outcome.emptyEntries, error);
        if (
          translationPending.size > 0 &&
          runtimeState.active &&
          !translationRetryTimer
        ) {
          scheduleLineTranslations(250);
        }
        return;
      }
      if (outcome.applied === 0) {
        if (outcome.sourceChanged) {
          // The ASR row grew while the request was in flight. Retranslate the
          // newest source on the next loop instead of counting it as missing.
          continue;
        }
        const error = new Error("翻译 API 没有返回对应译文");
        error.code = "empty_translation";
        await handleTranslationFailure(entries, error);
        return;
      }
    }
  })();
  translationFlushPromise = promise;
  try {
    await promise;
  } finally {
    if (translationFlushPromise === promise) translationFlushPromise = null;
    if (
      translationPending.size > 0 &&
      runtimeState.active &&
      !translationRetryTimer &&
      generation === translationGeneration
    ) {
      scheduleLineTranslations(250);
    }
  }
  return promise;
}

function cancelBufferTranslation() {
  clearTimeout(translationBufferTimer);
  translationBufferTimer = null;
  if (translationBufferAbort) {
    try {
      translationBufferAbort.abort();
    } catch {
      // Ignore abort races.
    }
    translationBufferAbort = null;
  }
  translationBufferInFlight = false;
}

function scheduleBufferTranslation() {
  if (
    !apiTranslationActive() ||
    !settingsCache.translationTranslatePartial ||
    !runtimeState.active
  ) {
    return;
  }
  const text = compactText(runtimeState.current?.bufferSource);
  if (!text) {
    cancelBufferTranslation();
    translationBufferRequestedText = "";
    return;
  }
  if (text === translationBufferRequestedText) return;
  // Do not restart the debounce on every partial update: live buffers change
  // several times per second, and a reset-on-change timer would never fire.
  if (translationBufferTimer) return;
  const wait = Math.max(
    TRANSLATION_BUFFER_DEBOUNCE_MS,
    translationBufferLastRequestAt + TRANSLATION_BUFFER_MIN_INTERVAL_MS - Date.now()
  );
  translationBufferTimer = setTimeout(() => {
    translationBufferTimer = null;
    void flushBufferTranslation();
  }, wait);
}

async function flushBufferTranslation() {
  const generation = translationGeneration;
  if (
    !runtimeState.active ||
    generation !== translationGeneration ||
    !apiTranslationActive()
  ) {
    return;
  }
  const text = compactText(runtimeState.current?.bufferSource);
  if (!text) return;
  // The half-sentence on screen matters more than the backlog: waiting for the
  // whole line queue to drain starved the buffer translation completely, so the
  // reader kept seeing the previous sentence while finished rows queued up.
  if (translationPending.size > 2 || translationFlushPromise) {
    translationBufferTimer = setTimeout(() => {
      translationBufferTimer = null;
      void flushBufferTranslation();
    }, 300);
    return;
  }
  if (translationBufferInFlight) {
    translationBufferTimer = setTimeout(() => {
      translationBufferTimer = null;
      void flushBufferTranslation();
    }, 300);
    return;
  }
  if (text === translationBufferRequestedText) return;
  const config = translationConfig();
  if (!config.enabled) return;

  translationBufferInFlight = true;
  translationBufferRequestedText = text;
  translationBufferLastRequestAt = Date.now();
  const controller = new AbortController();
  translationBufferAbort = controller;
  try {
    const result = await translateTexts({
      texts: [stripSpeechFillers(text)],
      context: recentTranslationContext(runtimeState.current?.lines || []),
      config,
      partial: true,
      signal: controller.signal
    });
    if (generation !== translationGeneration || !runtimeState.active) return;
    addTranslationUsage(result.usage);
    translationLastError = "";
    if (compactText(runtimeState.current?.bufferSource) === text) {
      runtimeState.current.bufferTranslation = polishTranslation(
        compactText(result.translations[0])
      );
      await broadcastCaptionUpdate();
    }
  } catch (error) {
    if (generation !== translationGeneration || isAbortError(error)) return;
    translationLastError = compactText(error?.message || error);
    if (shouldRetryTranslationError(error)) {
      translationBufferRequestedText = "";
    } else {
      // A bad key or balance problem will not fix itself for this text.
      translationBufferRequestedText = text;
      await broadcastCaptionUpdate();
    }
  } finally {
    // An external abort (new buffer text, cancel) already released the slot and
    // a newer request may own it now; only the owner may clear the flags.
    if (generation === translationGeneration && translationBufferAbort === controller) {
      translationBufferInFlight = false;
      translationBufferAbort = null;
      if (runtimeState.active) {
        const currentText = compactText(runtimeState.current?.bufferSource);
        if (currentText && currentText !== text) {
          scheduleBufferTranslation();
        } else if (
          currentText &&
          currentText === text &&
          !translationBufferRequestedText
        ) {
          scheduleBufferTranslation();
        }
      }
    }
  }
}

async function settleTranslations(timeoutMs = TRANSLATION_STOP_TIMEOUT_MS) {
  if (!apiTranslationActive()) {
    await applyPendingFallbacks();
    return;
  }
  cancelBufferTranslation();
  const generation = translationGeneration;
  const deadline = Date.now() + timeoutMs;
  collectPendingLineTranslations();
  while (
    Date.now() < deadline &&
    generation === translationGeneration &&
    apiTranslationActive()
  ) {
    collectPendingLineTranslations();
    if (translationPending.size === 0 && !translationFlushPromise) break;
    const remaining = Math.max(0, deadline - Date.now());
    await Promise.race([
      translationFlushPromise || flushLineTranslations(),
      new Promise((resolve) =>
        setTimeout(resolve, Math.min(remaining, 600))
      )
    ]);
    if (translationPending.size === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const inFlight = translationFlushPromise;
  if (inFlight) {
    await Promise.race([
      inFlight,
      new Promise((resolve) => setTimeout(resolve, 1200))
    ]);
  }
  if (translationFlushPromise) {
    // Abort a request that outlived the stop deadline; otherwise it could
    // finish after the summary and be discarded.
    abortLineTranslation();
    await Promise.race([
      translationFlushPromise,
      new Promise((resolve) => setTimeout(resolve, 500))
    ]);
  }
  if (generation === translationGeneration) await applyPendingFallbacks();
}

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
  currentEpochLines = [];
  knownLineSignatures.clear();
}

// Two start requests (double click, popup plus shortcut) would both pass the
// `active` check before either replaced runtimeState and leave an orphaned
// session, so starts run one at a time and the later one wins.
let startQueue = Promise.resolve();

function startSession(message) {
  const run = startQueue.then(() => startSessionNow(message));
  startQueue = run.catch(() => {});
  return run;
}

async function startSessionNow(message) {
  await initialize();
  if (runtimeState.active) {
    await stopSession({ quiet: true });
  }

  let wsUrl;
  try {
    wsUrl = normalizeWsUrl(message.wsUrl || settingsCache.wsUrl);
  } catch (error) {
    throw new Error(error?.message || String(error));
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
  resetTranslationMemory();
  await createHistorySession(metadata);
  pendingStopDetail = "";

  runtimeState = {
    ...structuredClone(EMPTY_RUNTIME_STATE),
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
  };
  refreshTranslationSummary();
  await persistRuntimeState(true);
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
    await injectOverlay(runtimeState.tabId);
  }
  let warning = "";
  if (settingsCache.openPanelOnStart) {
    try {
      await openMonitorWindow();
    } catch (error) {
      warning = `字幕窗口未能自动打开：${error?.message || error}`;
      runtimeState.detail = warning;
      runtimeState.updatedAt = Date.now();
      await persistRuntimeState(true);
      await broadcastToExtension({ type: "session-state" });
    }
  }
  return { ok: true, sessionId, warning };
}

async function finalizeSession(status, detail, options = {}) {
  if (finalizingPromise) return finalizingPromise;
  finalizingPromise = (async () => {
    const sessionId = runtimeState.sessionId;
    let finalStatus = status;
    let finalDetail = detail || runtimeState.detail;
    let lineCount = runtimeState.lineCount || 0;
    let translationMissing = 0;
    let preview =
      runtimeState.current?.lines?.at(-1)?.translation ||
      runtimeState.current?.lines?.at(-1)?.source ||
      "";

    try {
      try {
        await settleTranslations(
          finalStatus === "error" ? 2500 : TRANSLATION_STOP_TIMEOUT_MS
        );
        // Invalidate any request that outlived the stop deadline so it cannot
        // write history after the final flush/summary.
        translationGeneration += 1;
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
      runtimeState.active = false;
      runtimeState.status = finalStatus;
      runtimeState.detail = finalDetail || runtimeState.detail;
      // The overlay failure belongs to the session that just ended; keeping it
      // would leave a stale warning in the popup and a tabId to re-inject into.
      runtimeState.overlayError = "";
      runtimeState.wsConnected = false;
      runtimeState.lineCount = lineCount;
      runtimeState.translationMissing = translationMissing;
      runtimeState.updatedAt = Date.now();
      try {
        await persistRuntimeState(true);
        await updateBadge();
      } catch (error) {
        console.error("声幕运行状态收尾失败", error);
      }
      if (!options.quiet) {
        await broadcastToExtension({
          type: "session-ended",
          status: finalStatus,
          detail: runtimeState.detail
        });
        await broadcastCaptionState();
      }
      if (sessionId) await notifyHistoryChanged(sessionId);
      resetTranslationMemory({ keepUsage: true });
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
  if (!runtimeState.active && !(await hasOffscreenDocument())) {
    return { ok: true, alreadyStopped: true };
  }
  if (runtimeState.active) {
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
    runtimeState.sessionId &&
    message.sessionId !== runtimeState.sessionId
  ) {
    return;
  }
  const status = message.status || {};
  if (!runtimeState.active) return;
  runtimeState.status = status.state || runtimeState.status;
  runtimeState.detail = status.detail || runtimeState.detail;
  runtimeState.wsConnected = Boolean(status.wsConnected);
  runtimeState.audio = status.audio || runtimeState.audio;
  runtimeState.captureInfo = status.captureInfo || runtimeState.captureInfo;
  runtimeState.updatedAt = status.updatedAt || Date.now();
  await persistRuntimeState();
  await updateBadge();
  await broadcastToExtension({ type: "status", status: safeClone(status) });
  await broadcastCaptionState();

  if (status.state === "error" && status.fatal && runtimeState.active) {
    await stopSession({
      status: "error",
      detail: status.detail || "字幕服务发生致命错误"
    });
    return;
  }
  if (status.state === "stopped" && runtimeState.active) {
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
  const title = String(tab.title || runtimeState.tabTitle || "未命名直播");
  const url = String(tab.url || runtimeState.tabUrl || "");
  if (title === runtimeState.tabTitle && url === runtimeState.tabUrl) return;

  runtimeState.tabTitle = title;
  runtimeState.tabUrl = url;
  runtimeState.updatedAt = Date.now();
  if (runtimeState.sessionId) {
    await updateHistorySession(runtimeState.sessionId, {
      title,
      url,
      updatedAt: runtimeState.updatedAt
    });
  }
  await persistRuntimeState(true);
  await broadcastToExtension({ type: "session-state" });
}

async function handleTranscriptUpdate(message) {
  if (!runtimeState.active || message.sessionId !== runtimeState.sessionId) return;
  const updatedAt = Date.now();
  const normalized = normalizeCaptionLines(message.data, {
    sessionId: message.sessionId,
    epochId: message.epochId,
    epochStartedAt: message.epochStartedAt,
    sessionStartedAt: runtimeState.startedAt,
    updatedAt
  });
  // In API mode the extension translates the rows itself, so ASR fragments are
  // joined first and the overlay, history and SRT all work on whole sentences.
  // In server mode WhisperLiveKit already returned translations aligned to its
  // own segments; merging the rows there would throw those translations away.
  const apiConfig = translationConfig();
  const useApi = apiConfig.mode === "api" && apiConfig.enabled;
  if (useApi) {
    normalized.lines = mergeCaptionFragments(normalized.lines);
  }
  const previousLines = new Map(
    (runtimeState.current?.lines || []).map((line) => [line.id, line])
  );
  const lines = normalized.lines.map((rawLine) => {
    const previous =
      previousLines.get(rawLine.id) || knownLineSignatures.get(rawLine.id);
    const serverTranslation = polishTranslation(getTranslationText(rawLine));
    let translation = useApi ? "" : serverTranslation;
    let fallbackTranslation = useApi ? serverTranslation : "";
    if (
      !translation &&
      previous?.translation &&
      previous.source === rawLine.source
    ) {
      translation = previous.translation;
    }
    if (
      !fallbackTranslation &&
      previous?.fallbackTranslation &&
      previous.source === rawLine.source
    ) {
      fallbackTranslation = previous.fallbackTranslation;
    }
    return {
      ...rawLine,
      translation,
      fallbackTranslation,
      translationPending: Boolean(rawLine.source && !translation),
      translationFailed: Boolean(
        !translation &&
        previous?.source === rawLine.source &&
        previous?.translationFailed
      )
    };
  });
  currentEpochLines = lines;

  for (const line of lines) {
    const previous = knownLineSignatures.get(line.id);
    const signature = `${line.source}\u0000${line.translation}`;
    if (lineChanged(previous, line) || previous?.signature !== signature) {
      historyWriteQueue.enqueue([line]);
      knownLineSignatures.set(line.id, { ...line, signature });
    }
  }

  runtimeState.status =
    runtimeState.status === "reconnecting" ? "capturing" : runtimeState.status;
  runtimeState.wsConnected = true;
  runtimeState.updatedAt = updatedAt;
  const previousBufferSource = compactText(runtimeState.current?.bufferSource);
  const bufferChanged = previousBufferSource !== normalized.bufferSource;
  const bufferTranslation = useApi
    ? bufferChanged
      ? ""
      : compactText(runtimeState.current?.bufferTranslation)
    : normalized.bufferTranslation;
  const currentCaption = {
    lines: mergeCaptionLines([], lines, 120),
    bufferSource: normalized.bufferSource,
    bufferTranslation,
    translationError: useApi
      ? translationLastError
      : normalized.translationError,
    epochId: message.epochId || null
  };
  runtimeState.current = {
    ...currentCaption,
    displayCaption: selectDisplayCaption(currentCaption)
  };
  refreshTranslationSummary();

  if (useApi && bufferChanged && translationBufferAbort) {
    // Abort a stale half-sentence request, but keep the debounce timer: live
    // buffers change several times per second and must not reset it forever.
    try {
      translationBufferAbort.abort();
    } catch {
      // Ignore abort races.
    }
    translationBufferAbort = null;
    translationBufferInFlight = false;
    translationBufferRequestedText = "";
  }

  await persistRuntimeState();
  await broadcastToExtension({
    type: "caption-state",
    current: safeClone(runtimeState.current),
    epochId: message.epochId,
    lineCount: runtimeState.lineCount
  });
  await broadcastCaptionState();
  await flushPendingHistory(false);

  if (useApi) {
    scheduleLineTranslations();
    scheduleBufferTranslation();
  }
}

async function handleAudioStats(message) {
  if (message.sessionId && message.sessionId !== runtimeState.sessionId) return;
  runtimeState.audio = message.audio || runtimeState.audio;
  runtimeState.updatedAt = Date.now();
  await broadcastToExtension({
    type: "audio-stats",
    audio: safeClone(runtimeState.audio)
  });
  await persistRuntimeState();
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
          state: compactRuntimeState(),
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
        if (!runtimeState.active || !runtimeState.tabId) {
          sendResponse({ ok: false, error: "当前没有正在采集的标签页" });
          return;
        }
        const injected = await injectOverlay();
        sendResponse({
          ok: injected,
          error: injected
            ? ""
            : runtimeState.overlayError || "页面浮层没有响应"
        });
      } else if (message.type === "content-ready") {
        // The content script finished initializing on its own: whatever init
        // handshake failed earlier is stale now.
        if (
          runtimeState.overlayError &&
          sender?.tab?.id &&
          sender.tab.id === runtimeState.tabId
        ) {
          await reportOverlayFailure(null);
        }
        sendResponse({
          ok: true,
          state: compactRuntimeState(),
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
  if (runtimeState.active && tabId === runtimeState.tabId) {
    void stopSession({ detail: "直播标签页已关闭" });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== runtimeState.tabId || !runtimeState.active) return;
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
