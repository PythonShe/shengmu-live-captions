import { settingsForBroadcast } from "../lib/caption-utils.js";
import { msg } from "../lib/i18n-message.js";
import { TranslationApiError, translateTexts } from "../lib/translation-api.js";
import { createTranslationScheduler } from "../lib/translation-scheduler.js";
import { createAsrAuth } from "./asr-auth.js";
import { probeServices, testTranslationApi } from "./diagnostics.js";
import { errorText, t } from "./i18n.js";
import { createHistorySync } from "./history-sync.js";
import { createMessageDispatcher } from "./message-router.js";
import { createOffscreenClient } from "./offscreen-client.js";
import { createRuntimeStore } from "./runtime-store.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { createSettingsStore, translationSettingsChanged } from "./settings-store.js";
import { createUsageService } from "./usage-service.js";
import { createViews } from "./views.js";

// Composition root: build the services, then register the chrome.* listeners.
const store = createRuntimeStore();
const settings = createSettingsStore();
const offscreen = createOffscreenClient();
const views = createViews({ store, settings, ready: initialize });
const asrAuth = createAsrAuth();

/** Chrome's built-in Translator runs in the offscreen document only. */
async function builtinTranslate(texts) {
  const response = await offscreen.send({ type: "builtin-translate", texts });
  if (!response?.ok) {
    throw new TranslationApiError(response?.error || msg("translation_builtin_failed"), {
      code: response?.code || "builtin_unavailable"
    });
  }
  return response.translations;
}
const history = createHistorySync({ store, views });
const usage = createUsageService({ getConfig: () => settings.translationConfig() });
const scheduler = createTranslationScheduler({
  getState: () => store.state,
  getConfig: () => settings.translationConfig(),
  isApiEnabled: () => settings.apiTranslationActive(),
  translateTexts: (options) => translateTexts({ ...options, builtinTranslate }),
  recordUsage: (delta, config) => usage.record(delta, config),
  knownLines: history.knownLines,
  enqueueHistory: (lines) => history.enqueue(lines),
  publish: () => lifecycle.publishCaptions(),
  describeError: errorText
});
const lifecycle = createSessionLifecycle({
  store,
  settings,
  views,
  offscreen,
  history,
  scheduler,
  ready: initialize,
  asrAuth
});

let initializationPromise = null;

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
    await lifecycle.recover();
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

const dispatch = createMessageDispatcher({
  ready: initialize,
  services: {
    startSession: (message) => lifecycle.start(message),
    stopSession: () => lifecycle.stop(),
    handleStatusReport: (message) => lifecycle.handleStatusReport(message),
    handleTranscriptUpdate: (message) => lifecycle.handleTranscriptUpdate(message),
    handleAudioStats: (message) => lifecycle.handleAudioStats(message),
    offscreenReady: () => offscreen.markReady(),
    snapshot: () => store.snapshot(),
    publicSettings: () => settingsForBroadcast(settings.current),
    saveSettings,
    overlayEnabled: () => settings.current.overlayEnabled,
    testTranslationApi: () => testTranslationApi(settings.translationConfig(), { builtinTranslate }),
    getUsage: () => usage.snapshot(),
    openMonitorWindow: () => views.openMonitorWindow(),
    refreshOverlay: () => views.refreshOverlay(),
    acknowledgeContentReady: (sender) => views.acknowledgeContentReady(sender),
    resyncCaptions: (request) => views.resyncCaptions(request),
    probeServices: () => probeServices({ ...settings.current })
  }
});

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
  // The offscreen document answers its own requests; replying here too would
  // race it for the single response.
  if (message?.target === "offscreen") return false;
  void dispatch(message, sender).then(sendResponse);
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open_caption_window") {
    void views.openMonitorWindow();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (store.state.active && tabId === store.state.tabId) {
    void lifecycle.stop({ detail: t("session_tab_closed") });
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
    await lifecycle.refreshSourceMetadata(tabId);
    if (changeInfo.status === "complete") {
      if (settings.current.overlayEnabled) {
        await views.injectOverlay(tabId);
      }
      await views.broadcastCaptionState();
    }
  })();
});

void initialize();
