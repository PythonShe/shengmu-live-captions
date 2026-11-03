import { sanitizeSettingsPatch } from "../lib/caption-utils.js";
import { OFFSCREEN_URL } from "./offscreen-client.js";

/**
 * Who may send a message type:
 * - "extension-page": popup, subtitle window and other pages of this extension
 * - "any": also content scripts in web pages (display-only operations)
 * - "offscreen": only the capture document, tagged `source: "offscreen"`
 */
export const SENDER_POLICIES = Object.freeze(["extension-page", "any", "offscreen"]);

export const EXTENSION_ONLY_ERROR = "此操作只能从声幕扩展界面发起";

/**
 * @typedef {object} RouteContext
 * @property {any} message
 * @property {any} sender
 * @property {any} services The worker's operations (see service-worker.js).
 * @property {boolean} fromExtensionPage
 * @property {any} [settingsPatch] message.settings after sanitizeSettingsPatch,
 *   for routes that declare `sanitizeSettings`.
 */

/**
 * @typedef {object} Route
 * @property {"extension-page" | "any" | "offscreen"} allow
 * @property {boolean} [sanitizeSettings] A web page may only change display settings.
 * @property {(context: RouteContext) => any} handler Returns the response;
 *   offscreen routes always answer `{ ok: true }`.
 */

async function saveOverlay(services, overlayEnabled) {
  return services.saveSettings({ overlayEnabled });
}

/** @type {Readonly<Record<string, Route>>} */
export const MESSAGE_ROUTES = Object.freeze({
  "status-report": {
    allow: "offscreen",
    handler: ({ services, message }) => services.handleStatusReport(message)
  },
  "transcript-update": {
    allow: "offscreen",
    handler: ({ services, message }) => services.handleTranscriptUpdate(message)
  },
  "audio-stats": {
    allow: "offscreen",
    handler: ({ services, message }) => services.handleAudioStats(message)
  },
  // The capture document's message listener is registered; see
  // offscreen-client.js ensureDocument.
  "offscreen-ready": {
    allow: "offscreen",
    handler: ({ services }) => services.offscreenReady()
  },
  "start-capture": {
    allow: "extension-page",
    handler: ({ services, message }) => services.startSession(message)
  },
  "stop-capture": {
    allow: "extension-page",
    handler: ({ services }) => services.stopSession()
  },
  "test-translation-api": {
    allow: "extension-page",
    handler: async ({ services }) => {
      try {
        return { ok: true, result: await services.testTranslationApi() };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    }
  },
  // Re-injecting scripts into the captured tab is not a display setting: a
  // page must not be able to trigger it.
  "refresh-overlay": {
    allow: "extension-page",
    handler: ({ services }) => services.refreshOverlay()
  },
  "get-state": {
    allow: "any",
    handler: ({ services }) => ({
      ok: true,
      state: services.snapshot(),
      settings: services.publicSettings()
    })
  },
  "get-settings": {
    allow: "any",
    handler: ({ services }) => ({ ok: true, settings: services.publicSettings() })
  },
  "save-settings": {
    allow: "any",
    sanitizeSettings: true,
    handler: async ({ services, settingsPatch }) => ({
      ok: true,
      settings: await services.saveSettings(settingsPatch)
    })
  },
  "open-monitor": {
    allow: "any",
    handler: async ({ services }) => {
      await services.openMonitorWindow();
      return { ok: true };
    }
  },
  "toggle-overlay": {
    allow: "any",
    handler: async ({ services }) => {
      const next = !services.overlayEnabled();
      const saved = await saveOverlay(services, next);
      return { ok: true, settings: saved, enabled: next };
    }
  },
  "show-overlay": {
    allow: "any",
    handler: async ({ services }) => ({ ok: true, settings: await saveOverlay(services, true) })
  },
  "hide-overlay": {
    allow: "any",
    handler: async ({ services }) => ({ ok: true, settings: await saveOverlay(services, false) })
  },
  "content-ready": {
    allow: "any",
    handler: async ({ services, sender }) => {
      await services.acknowledgeContentReady(sender);
      return { ok: true, state: services.snapshot(), settings: services.publicSettings() };
    }
  },
  "probe-services": {
    allow: "any",
    handler: async ({ services }) => ({ ok: true, services: await services.probeServices() })
  }
});

export function isExtensionPageSender(sender, runtime = chrome.runtime) {
  const url = String(sender?.url || "");
  if (url) return url.startsWith(runtime.getURL(""));
  return sender?.id === runtime.id && !sender?.tab;
}

export function isOffscreenSender(message, sender, runtime = chrome.runtime) {
  return (
    message?.source === "offscreen" &&
    String(sender?.url || "").startsWith(runtime.getURL(OFFSCREEN_URL))
  );
}

// Own properties only: a type like "toString" must not find Object.prototype.
function findRoute(routes, type) {
  return typeof type === "string" && Object.hasOwn(routes, type) ? routes[type] : null;
}

/**
 * @typedef {object} DispatcherOptions
 * @property {any} services
 * @property {Readonly<Record<string, Route>>} [routes]
 * @property {() => Promise<void>} [ready] Awaited before every message.
 * @property {any} [runtime] chrome.runtime, for the sender checks.
 */

/**
 * One entry point for chrome.runtime.onMessage. Resolves to the response;
 * it never rejects.
 *
 * @param {DispatcherOptions} options
 */
export function createMessageDispatcher({
  services,
  routes = MESSAGE_ROUTES,
  ready = async () => {},
  runtime = chrome.runtime
}) {
  return async function dispatch(message, sender) {
    try {
      await ready();
      if (isOffscreenSender(message, sender, runtime)) {
        const route = findRoute(routes, message.type);
        if (route?.allow === "offscreen") {
          await route.handler({ message, sender, services, fromExtensionPage: false });
        }
        return { ok: true };
      }
      if (message?.target === "content") return { ok: true };
      if (message?.target !== "background") return { ok: false };

      const route = findRoute(routes, message.type);
      if (!route || route.allow === "offscreen") {
        return { ok: false, error: `未知消息：${message.type}` };
      }
      const fromExtensionPage = isExtensionPageSender(sender, runtime);
      if (route.allow === "extension-page" && !fromExtensionPage) {
        return { ok: false, error: EXTENSION_ONLY_ERROR };
      }
      const settingsPatch = route.sanitizeSettings
        ? sanitizeSettingsPatch(message.settings, { fromExtensionPage })
        : undefined;
      return await route.handler({ message, sender, services, fromExtensionPage, settingsPatch });
    } catch (error) {
      console.error("声幕后台错误", error);
      return { ok: false, error: error?.message || String(error) };
    }
  };
}
