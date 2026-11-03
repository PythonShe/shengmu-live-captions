import {
  HISTORY_CHANGED_KEY,
  applyOverlayFailure,
  settingsForCaptions
} from "../lib/caption-utils.js";
import { safeClone } from "./runtime-store.js";

export const MONITOR_URL = "subtitle/subtitle.html";
const MONITOR_BOUNDS = Object.freeze({ width: 1160, height: 760, left: 80, top: 60 });

/**
 * Everything the worker pushes outward: broadcasts to extension pages, the
 * caption overlay in the captured tab, the action badge and the monitor
 * window. Extension pages get the full snapshot; the tab only ever gets
 * settingsForCaptions, never the custom glossary or API keys.
 *
 * @param {{ store: any, settings: any, ready: () => Promise<void> }} deps
 */
export function createViews({ store, settings, ready }) {
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
    const state = store.state;
    await sendToTab({
      type: "caption-state",
      payload: {
        active: state.active,
        status: state.status,
        detail: state.detail,
        lineCount: state.lineCount,
        wsConnected: state.wsConnected,
        updatedAt: state.updatedAt,
        overlayError: state.overlayError || "",
        current: safeClone(state.current)
      },
      settings: settingsForCaptions(settings.current)
    });
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

  // Surfaced in the popup so a broken overlay never fails silently: the switch
  // stays on while nothing appears, which reads as "the toggle does nothing".
  async function reportOverlayFailure(error) {
    if (!applyOverlayFailure(store.state, error)) return;
    await store.persist(true);
    // Both audiences matter: the content script needs the caption state, and
    // the extension views need the new overlayError to show or clear the hint.
    await broadcastToExtension({ type: "status" });
    await broadcastCaptionState();
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
      // sendMessage rejection is the only signal the worker ever gets, so
      // treat it as an injection failure instead of swallowing it.
      const response = await chrome.tabs.sendMessage(tabId, {
        target: "content",
        type: "init",
        settings: settingsForCaptions(settings.current),
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

  async function applyOverlaySetting() {
    if (!store.state.tabId) return;
    if (settings.current.overlayEnabled) {
      // injectOverlay() records overlayError (and broadcasts) on its own, so a
      // failure must not trigger a second, identical broadcast here.
      const injected = await injectOverlay(store.state.tabId);
      if (injected) await broadcastCaptionState();
    } else {
      await sendToTab({ type: "hide-overlay" });
    }
  }

  /** The popup's "reload overlay" button. */
  async function refreshOverlay() {
    if (!store.state.active || !store.state.tabId) {
      return { ok: false, error: "当前没有正在采集的标签页" };
    }
    const injected = await injectOverlay();
    return {
      ok: injected,
      error: injected ? "" : store.state.overlayError || "页面浮层没有响应"
    };
  }

  /**
   * The content script finished initializing on its own: whatever init
   * handshake failed earlier is stale now.
   */
  async function acknowledgeContentReady(sender) {
    if (store.state.overlayError && sender?.tab?.id && sender.tab.id === store.state.tabId) {
      await reportOverlayFailure(null);
    }
  }

  async function findMonitorTab() {
    const monitorUrl = chrome.runtime.getURL(MONITOR_URL);
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => (tab.url || "").startsWith(monitorUrl)) || null;
  }

  async function openMonitorWindow(options = {}) {
    await ready();
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
    try {
      return await chrome.windows.create({ url, type: "popup", focused: true, ...MONITOR_BOUNDS });
    } catch (error) {
      // Chrome rejects bounds that leave less than half the window on screen
      // (small or scaled displays); let it pick a placement instead.
      if (!/bounds/i.test(String(error?.message))) throw error;
      return chrome.windows.create({ url, type: "popup", focused: true });
    }
  }

  async function notifyHistoryChanged(sessionId) {
    await chrome.storage.local.set({ [HISTORY_CHANGED_KEY]: Date.now() });
    await broadcastToExtension({ type: "history-changed", sessionId });
  }

  return {
    broadcastToExtension,
    broadcastCaptionState,
    updateBadge,
    reportOverlayFailure,
    injectOverlay,
    applyOverlaySetting,
    refreshOverlay,
    acknowledgeContentReady,
    openMonitorWindow,
    notifyHistoryChanged
  };
}
