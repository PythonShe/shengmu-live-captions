// A stateful stand-in for the chrome.* surface the service worker touches.
// Every call that reaches the outside world is recorded so tests can assert on
// broadcasts, tab messages and offscreen traffic without a browser.

export const EXTENSION_ID = "test-extension";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const POPUP_SENDER = Object.freeze({ url: `${EXTENSION_ORIGIN}popup/popup.html` });
export const OFFSCREEN_SENDER = Object.freeze({ url: `${EXTENSION_ORIGIN}offscreen/offscreen.html` });
export const CONTENT_SENDER = Object.freeze({
  url: "https://example.com/live",
  tab: { id: 7 }
});

function pick(store, keys) {
  return Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(store[key])])
  );
}

export function createChromeMock() {
  const listeners = {};
  const storage = { local: {}, session: {} };
  // Every chrome.runtime.sendMessage payload, in order.
  const sent = [];
  // Every chrome.tabs.sendMessage call as { tabId, message }.
  const tabMessages = [];
  const injections = [];
  const createdDocuments = [];
  const state = { offscreenOpen: false };
  // Tests swap these to change how the "browser" answers.
  const hooks = {
    offscreen: async () => ({ ok: true }),
    executeScript: async () => {},
    tabMessage: async () => undefined,
    createDocument: async () => {}
  };

  const addListener = (name) => (listener) => {
    listeners[name] = listener;
  };

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path) => `${EXTENSION_ORIGIN}${path}`,
      getContexts: async ({ contextTypes = [] } = {}) =>
        state.offscreenOpen && contextTypes.includes("OFFSCREEN_DOCUMENT")
          ? [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: `${EXTENSION_ORIGIN}offscreen/offscreen.html` }]
          : [],
      sendMessage: async (message) => {
        sent.push(structuredClone(message));
        if (message?.target === "offscreen") return hooks.offscreen(message);
        return { ok: true };
      },
      onInstalled: { addListener: addListener("installed") },
      onStartup: { addListener: addListener("startup") },
      onMessage: { addListener: addListener("message") }
    },
    storage: {
      local: {
        get: async (keys) => pick(storage.local, keys),
        set: async (values) => {
          Object.assign(storage.local, structuredClone(values));
        }
      },
      session: {
        get: async (keys) => pick(storage.session, keys),
        set: async (values) => {
          Object.assign(storage.session, structuredClone(values));
        }
      }
    },
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {}
    },
    commands: { onCommand: { addListener: addListener("command") } },
    tabs: {
      onRemoved: { addListener: addListener("tabRemoved") },
      onUpdated: { addListener: addListener("tabUpdated") },
      sendMessage: async (tabId, message) => {
        tabMessages.push({ tabId, message: structuredClone(message) });
        return hooks.tabMessage(tabId, message);
      },
      query: async () => [],
      get: async (tabId) => ({ id: tabId }),
      update: async () => ({})
    },
    windows: { create: async () => ({}), update: async () => ({}) },
    offscreen: {
      createDocument: async (options) => {
        createdDocuments.push(options);
        await hooks.createDocument(options);
        state.offscreenOpen = true;
      }
    },
    scripting: {
      executeScript: async (details) => {
        injections.push(details);
        return hooks.executeScript(details);
      }
    }
  };

  function dispatch(message, sender) {
    return new Promise((resolve) => {
      listeners.message(message, sender, resolve);
    });
  }

  return {
    chrome,
    listeners,
    storage,
    sent,
    tabMessages,
    injections,
    createdDocuments,
    state,
    hooks,
    sendToBackground: (message, sender = POPUP_SENDER) => dispatch(message, sender),
    sendFromOffscreen: (message) =>
      dispatch({ target: "background", source: "offscreen", ...message }, OFFSCREEN_SENDER),
    broadcasts: (type) =>
      sent.filter((message) => message?.target === "extension-view" && (!type || message.type === type)),
    contentMessages: (type) =>
      tabMessages.filter(({ message }) => !type || message?.type === type)
  };
}

export function installChromeMock() {
  const mock = createChromeMock();
  globalThis.chrome = mock.chrome;
  return mock;
}

export async function waitFor(probe, { timeoutMs = 4000, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}
