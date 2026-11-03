import { settingsForBroadcast } from "../lib/caption-utils.js";
import { translateTexts } from "../lib/translation-api.js";
import { createTranslationScheduler } from "../lib/translation-scheduler.js";
import { probeServices, testTranslationApi } from "./diagnostics.js";
import { createHistorySync } from "./history-sync.js";
import { createMessageDispatcher } from "./message-router.js";
import { createOffscreenClient } from "./offscreen-client.js";
import { createRuntimeStore } from "./runtime-store.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { createSettingsStore, translationSettingsChanged } from "./settings-store.js";
import { createViews } from "./views.js";

// Composition root: build the services, then register the chrome.* listeners.
const store = createRuntimeStore();
const settings = createSettingsStore();
const offscreen = createOffscreenClient();
const views = createViews({ store, settings, ready: initialize });
const history = createHistorySync({ store, views });
const scheduler = createTranslationScheduler({
  getState: () => store.state,
  getConfig: () => settings.translationConfig(),
  isApiEnabled: () => settings.apiTranslationActive(),
  partialEnabled: () => Boolean(settings.current.translationTranslatePartial),
  translateTexts,
  knownLines: history.knownLines,
  enqueueHistory: (lines) => history.enqueue(lines),
  publish: () => lifecycle.publishCaptions()
});
const lifecycle = createSessionLifecycle({
  store,
  settings,
  views,
  offscreen,
  history,
  scheduler,
  ready: initialize
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
    snapshot: () => store.snapshot(),
    publicSettings: () => settingsForBroadcast(settings.current),
    saveSettings,
    overlayEnabled: () => settings.current.overlayEnabled,
    testTranslationApi: () => testTranslationApi(settings.translationConfig()),
    openMonitorWindow: () => views.openMonitorWindow(),
    refreshOverlay: () => views.refreshOverlay(),
    acknowledgeContentReady: (sender) => views.acknowledgeContentReady(sender),
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
    void lifecycle.stop({ detail: "直播标签页已关闭" });
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
