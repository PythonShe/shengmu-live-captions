import {
  EMPTY_RUNTIME_STATE,
  normalizeWsUrl,
  sanitizeSettingsPatch,
  settingsForBroadcast
} from "../lib/caption-utils.js";
import { translateTexts, translationConfigIssue } from "../lib/translation-api.js";
import { reduceTranscriptUpdate } from "../lib/transcript-reducer.js";
import {
  TRANSLATION_STOP_TIMEOUT_MS,
  createTranslationScheduler
} from "../lib/translation-scheduler.js";
import {
  probeServices,
  requireLocalTranslation,
  testTranslationApi
} from "./diagnostics.js";
import { createHistorySync } from "./history-sync.js";
import { OFFSCREEN_URL, createOffscreenClient } from "./offscreen-client.js";
import { createRuntimeStore, safeClone } from "./runtime-store.js";
import { createSettingsStore, translationSettingsChanged } from "./settings-store.js";
import { createViews } from "./views.js";

const store = createRuntimeStore();
const settings = createSettingsStore();
const offscreen = createOffscreenClient();
const views = createViews({ store, settings, ready: initialize });
const history = createHistorySync({ store, views });
let initializationPromise = null;
let finalizingPromise = null;
let pendingStopDetail = "";

// Persists and broadcasts the caption state after the scheduler patched it.
async function publishCaptionState() {
  await store.persist();
  await views.broadcastToExtension({
    type: "caption-state",
    current: safeClone(store.state.current),
    lineCount: store.state.lineCount
  });
  await views.broadcastCaptionState();
  await history.flush(false);
}

const scheduler = createTranslationScheduler({
  getState: () => store.state,
  getConfig: () => settings.translationConfig(),
  isApiEnabled: () => settings.apiTranslationActive(),
  partialEnabled: () => Boolean(settings.current.translationTranslatePartial),
  translateTexts,
  knownLines: history.knownLines,
  enqueueHistory: (lines) => history.enqueue(lines),
  publish: publishCaptionState
});

function initialize() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const [, restored] = await Promise.all([settings.load(), store.rehydrate()]);
    if (restored) {
      scheduler.restore({
        usage: restored.translation?.usage,
        error: restored.translation?.error
      });
    }
    await views.updateBadge();
    if (store.state.active && !(await offscreen.hasDocument())) {
      await finalizeSession(
        "error",
        "浏览器后台采集页面已中断，请重新开始",
        { quiet: true }
      );
    } else if (store.state.active && settings.apiTranslationActive()) {
      // The service worker can be recycled mid-session. Rebuild the pending
      // queue from the restored runtime lines; none of the queue/timers are
      // persisted in memory.
      scheduler.resume();
    }
  })();
  return initializationPromise;
}

async function saveSettings(patch) {
  await initialize();
  const saved = await settings.applyPatch(patch);
  await views.broadcastToExtension({
    type: "settings-changed",
    settings: settingsForBroadcast(saved)
  });
  if (translationSettingsChanged(patch)) scheduler.handleConfigChanged();
  await views.applyOverlaySetting();
  return settingsForBroadcast(settings.current);
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
    wsUrl = normalizeWsUrl(message.wsUrl || settings.current.wsUrl);
  } catch (error) {
    throw new Error(error?.message || String(error), { cause: error });
  }
  await settings.update({ wsUrl });

  const translation = settings.translationConfig();
  if (translation.mode === "api") {
    const issue = translationConfigIssue(translation);
    if (issue) {
      throw new Error(
        `${issue}。请在扩展控制面板的“翻译引擎”中完成配置，或切换为本地服务端。`
      );
    }
  } else {
    await requireLocalTranslation();
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
  history.resetSession();
  scheduler.reset();
  await history.createSession(metadata);
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
  await views.updateBadge();
  await views.broadcastToExtension({
    type: "session-state",
    session: metadata
  });
  await views.notifyHistoryChanged(sessionId);

  let result;
  try {
    result = await offscreen.send({
      type: "start-capture",
      sessionId,
      targetTabId: message.targetTabId,
      streamId: message.streamId,
      wsUrl: settings.sessionWsUrl(wsUrl)
    });
    if (!result?.ok) throw new Error(result?.error || "音频采集启动失败");
  } catch (error) {
    await finalizeSession("error", error?.message || String(error), {
      quiet: true
    });
    throw error;
  }

  if (settings.current.overlayEnabled) {
    await views.injectOverlay(store.state.tabId);
  }
  let warning = "";
  if (settings.current.openPanelOnStart) {
    try {
      await views.openMonitorWindow();
    } catch (error) {
      warning = `字幕窗口未能自动打开：${error?.message || error}`;
      store.state.detail = warning;
      store.state.updatedAt = Date.now();
      await store.persist(true);
      await views.broadcastToExtension({ type: "session-state" });
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
        await history.flush(true);
      } catch (error) {
        finalStatus = "error";
        finalDetail = `字幕历史写入失败：${error?.message || error}`;
      }

      if (sessionId) {
        try {
          const summary = await history.summarize(sessionId);
          lineCount = summary.lineCount;
          translationMissing = summary.translationMissing;
          preview = summary.preview || preview;
          if (translationMissing > 0 && finalStatus === "stopped") {
            finalStatus = "incomplete";
            finalDetail =
              `${finalDetail}；${translationMissing} 条字幕缺少译文`;
          }
          await history.updateSession(sessionId, {
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
        await views.updateBadge();
      } catch (error) {
        console.error("声幕运行状态收尾失败", error);
      }
      if (!options.quiet) {
        await views.broadcastToExtension({
          type: "session-ended",
          status: finalStatus,
          detail: store.state.detail
        });
        await views.broadcastCaptionState();
      }
      if (sessionId) await views.notifyHistoryChanged(sessionId);
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
  if (!store.state.active && !(await offscreen.hasDocument())) {
    return { ok: true, alreadyStopped: true };
  }
  if (store.state.active) {
    pendingStopDetail = options.detail || "标签页音频采集已停止";
  }
  await offscreen.stopCapture();
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
  await views.updateBadge();
  await views.broadcastToExtension({ type: "status", status: safeClone(status) });
  await views.broadcastCaptionState();

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
    await history.updateSession(store.state.sessionId, {
      title,
      url,
      updatedAt: store.state.updatedAt
    });
  }
  await store.persist(true);
  await views.broadcastToExtension({ type: "session-state" });
}

async function handleTranscriptUpdate(message) {
  if (!store.state.active || message.sessionId !== store.state.sessionId) return;
  const apiConfig = settings.translationConfig();
  const useApi = apiConfig.mode === "api" && apiConfig.enabled;
  const next = reduceTranscriptUpdate(store.state, message, {
    knownLines: history.knownLines,
    useApi,
    apiError: scheduler.lastError,
    now: Date.now()
  });
  history.record(next.historyLines);
  Object.assign(store.state, next.patch);
  scheduler.refreshSummary();

  if (useApi && next.bufferChanged) scheduler.abortStaleBuffer();

  await store.persist();
  await views.broadcastToExtension({
    type: "caption-state",
    current: safeClone(store.state.current),
    epochId: message.epochId,
    lineCount: store.state.lineCount
  });
  await views.broadcastCaptionState();
  await history.flush(false);

  if (useApi) {
    scheduler.scheduleLines();
    scheduler.scheduleBuffer();
  }
}

async function handleAudioStats(message) {
  if (message.sessionId && message.sessionId !== store.state.sessionId) return;
  store.state.audio = message.audio || store.state.audio;
  store.state.updatedAt = Date.now();
  await views.broadcastToExtension({
    type: "audio-stats",
    audio: safeClone(store.state.audio)
  });
  await store.persist();
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
      await views.openMonitorWindow({ welcome: true });
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
          settings: settingsForBroadcast(settings.current)
        });
      } else if (message.type === "get-settings") {
        sendResponse({
          ok: true,
          settings: settingsForBroadcast(settings.current)
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
          sendResponse({
            ok: true,
            result: await testTranslationApi(settings.translationConfig())
          });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error?.message || String(error)
          });
        }
      } else if (message.type === "open-monitor") {
        await views.openMonitorWindow();
        sendResponse({ ok: true });
      } else if (message.type === "toggle-overlay") {
        const next = !settings.current.overlayEnabled;
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
        sendResponse(await views.refreshOverlay());
      } else if (message.type === "content-ready") {
        await views.acknowledgeContentReady(sender);
        sendResponse({
          ok: true,
          state: store.snapshot(),
          settings: settingsForBroadcast(settings.current)
        });
      } else if (message.type === "probe-services") {
        await initialize();
        sendResponse({ ok: true, services: await probeServices({ ...settings.current }) });
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
    void views.openMonitorWindow();
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
      if (settings.current.overlayEnabled) {
        await views.injectOverlay(tabId);
      }
      await views.broadcastCaptionState();
    }
  })();
});

void initialize();
