import { sanitizeSettingsPatch, settingsForBroadcast } from "../lib/caption-utils.js";
import { translateTexts } from "../lib/translation-api.js";
import { createTranslationScheduler } from "../lib/translation-scheduler.js";
import { probeServices, testTranslationApi } from "./diagnostics.js";
import { createHistorySync } from "./history-sync.js";
import { OFFSCREEN_URL, createOffscreenClient } from "./offscreen-client.js";
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
          await lifecycle.handleStatusReport(message);
        } else if (message.type === "transcript-update") {
          await lifecycle.handleTranscriptUpdate(message);
        } else if (message.type === "audio-stats") {
          await lifecycle.handleAudioStats(message);
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
        sendResponse(await lifecycle.start(message));
      } else if (message.type === "stop-capture") {
        if (!isExtensionPageSender(sender)) {
          rejectNonExtensionSender(sendResponse);
          return;
        }
        sendResponse(await lifecycle.stop());
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
