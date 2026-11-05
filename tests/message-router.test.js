import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTENSION_ONLY_ERROR,
  MESSAGE_ROUTES,
  SENDER_POLICIES,
  createMessageDispatcher,
  isExtensionPageSender
} from "../extension/background/message-router.js";
import { i18nMock, zh } from "./helpers/i18n.js";

// The router renders its errors with chrome.i18n.
globalThis.chrome = { i18n: i18nMock };

const EXTENSION_ID = "test-extension";
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const runtime = { id: EXTENSION_ID, getURL: (path) => `${ORIGIN}${path}` };

// The sender policy every message type had in the if/else chain this table
// replaced. Changing a line here widens or narrows who may call what.
const EXPECTED_POLICIES = {
  "status-report": "offscreen",
  "transcript-update": "offscreen",
  "audio-stats": "offscreen",
  "offscreen-ready": "offscreen",
  "start-capture": "extension-page",
  "stop-capture": "extension-page",
  "test-translation-api": "extension-page",
  "get-usage": "extension-page",
  "refresh-overlay": "extension-page",
  "get-state": "any",
  "get-settings": "any",
  "save-settings": "any",
  "open-monitor": "any",
  "toggle-overlay": "any",
  "show-overlay": "any",
  "hide-overlay": "any",
  "content-ready": "any",
  "caption-resync": "any",
  "probe-services": "any"
};

// The service each route must reach when it is allowed.
const ROUTE_SERVICE = {
  "status-report": "handleStatusReport",
  "transcript-update": "handleTranscriptUpdate",
  "audio-stats": "handleAudioStats",
  "offscreen-ready": "offscreenReady",
  "start-capture": "startSession",
  "stop-capture": "stopSession",
  "test-translation-api": "testTranslationApi",
  "get-usage": "getUsage",
  "refresh-overlay": "refreshOverlay",
  "get-state": "snapshot",
  "get-settings": "publicSettings",
  "save-settings": "saveSettings",
  "open-monitor": "openMonitorWindow",
  "toggle-overlay": "saveSettings",
  "show-overlay": "saveSettings",
  "hide-overlay": "saveSettings",
  "content-ready": "acknowledgeContentReady",
  "caption-resync": "resyncCaptions",
  "probe-services": "probeServices"
};

const SENDERS = {
  popup: { sender: { url: `${ORIGIN}popup/popup.html` }, page: true },
  subtitle: { sender: { url: `${ORIGIN}subtitle/subtitle.html` }, page: true },
  // An extension context without a URL and without a tab is an extension page.
  extensionNoUrl: { sender: { id: EXTENSION_ID }, page: true },
  // The capture document without the offscreen tag counts as an extension page.
  offscreenUntagged: { sender: { url: `${ORIGIN}offscreen/offscreen.html` }, page: true },
  webPage: { sender: { url: "https://example.com/live", tab: { id: 7 } }, page: false },
  // Our own content script: same extension id, but it runs in a tab.
  contentScript: { sender: { id: EXTENSION_ID, tab: { id: 7 } }, page: false },
  offscreen: { sender: { url: `${ORIGIN}offscreen/offscreen.html` }, page: false, offscreen: true }
};

function recordingServices(results = {}) {
  const calls = [];
  const services = new Proxy(
    {},
    {
      get: (target, name) =>
        (...args) => {
          calls.push({ name, args });
          return results[name];
        }
    }
  );
  return { calls, services };
}

function dispatcherWith(results) {
  const recorder = recordingServices(results);
  const dispatch = createMessageDispatcher({ services: recorder.services, runtime });
  return { ...recorder, dispatch };
}

test("every message type declares the sender policy it had before the table", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(MESSAGE_ROUTES).map(([type, route]) => [type, route.allow])),
    EXPECTED_POLICIES
  );
  for (const route of Object.values(MESSAGE_ROUTES)) {
    assert.ok(SENDER_POLICIES.includes(route.allow));
    assert.equal(typeof route.handler, "function");
  }
  assert.equal(MESSAGE_ROUTES["refresh-overlay"].allow, "extension-page");
  assert.deepEqual(
    Object.keys(MESSAGE_ROUTES).filter((type) => MESSAGE_ROUTES[type].sanitizeSettings),
    ["save-settings"]
  );
});

test("the dispatcher enforces each policy for every kind of sender", async () => {
  for (const [type, policy] of Object.entries(EXPECTED_POLICIES)) {
    for (const [kind, { sender, page, offscreen }] of Object.entries(SENDERS)) {
      const { calls, dispatch } = dispatcherWith();
      const message = { target: "background", type, ...(offscreen ? { source: "offscreen" } : {}) };
      const response = await dispatch(message, sender);
      const reached = calls.some((call) => call.name === ROUTE_SERVICE[type]);
      const allowed = offscreen
        ? policy === "offscreen"
        : policy === "any" || (policy === "extension-page" && page);
      assert.equal(reached, allowed, `${type} from ${kind}`);

      if (offscreen) {
        assert.deepEqual(response, { ok: true }, `${type} from ${kind}`);
      } else if (policy === "offscreen") {
        assert.deepEqual(response, { ok: false, error: `未知消息：${type}` }, `${type} from ${kind}`);
      } else if (!allowed) {
        assert.deepEqual(response, { ok: false, error: zh(EXTENSION_ONLY_ERROR) }, `${type} from ${kind}`);
      }
    }
  }
});

test("a web page that claims to be the offscreen document is not trusted", async () => {
  const { calls, dispatch } = dispatcherWith();
  const response = await dispatch(
    { target: "background", source: "offscreen", type: "transcript-update", data: {} },
    SENDERS.webPage.sender
  );
  assert.deepEqual(response, { ok: false, error: "未知消息：transcript-update" });
  assert.equal(calls.length, 0);
});

test("settings from a web page are reduced to display fields before saving", async () => {
  const settings = {
    displayMode: "chinese",
    translationBaseUrl: "https://attacker.example/v1",
    translationApiKeys: { deepseek: "stolen" }
  };
  const fromPage = dispatcherWith({ saveSettings: { saved: true } });
  const pageResponse = await fromPage.dispatch(
    { target: "background", type: "save-settings", settings },
    SENDERS.webPage.sender
  );
  assert.deepEqual(pageResponse, { ok: true, settings: { saved: true } });
  assert.deepEqual(fromPage.calls[0].args, [{ displayMode: "chinese" }]);

  const fromPopup = dispatcherWith();
  await fromPopup.dispatch({ target: "background", type: "save-settings", settings }, SENDERS.popup.sender);
  assert.deepEqual(fromPopup.calls[0].args, [settings]);
});

test("unknown, inherited and missing types are rejected; other targets are answered", async () => {
  const { calls, dispatch } = dispatcherWith();
  for (const type of ["no-such-type", "toString", "__proto__", "constructor", undefined]) {
    const response = await dispatch({ target: "background", type }, SENDERS.popup.sender);
    assert.deepEqual(response, { ok: false, error: `未知消息：${type}` });
  }
  // Offscreen traffic of an unknown type is acknowledged and ignored.
  assert.deepEqual(
    await dispatch({ target: "background", source: "offscreen", type: "toString" }, SENDERS.offscreen.sender),
    { ok: true }
  );
  assert.deepEqual(await dispatch({ target: "content", type: "caption-state" }, SENDERS.popup.sender), { ok: true });
  assert.deepEqual(await dispatch({ target: "extension-view", type: "status" }, SENDERS.popup.sender), { ok: false });
  assert.deepEqual(await dispatch(null, SENDERS.popup.sender), { ok: false });
  assert.equal(calls.length, 0);
});

test("handler failures become error responses and responses are shaped per route", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failing = createMessageDispatcher({
    runtime,
    services: {
      startSession: async () => {
        throw new Error("tab capture refused");
      },
      testTranslationApi: async () => {
        throw new Error("bad key");
      }
    }
  });
  assert.deepEqual(
    await failing({ target: "background", type: "start-capture" }, SENDERS.popup.sender),
    { ok: false, error: "tab capture refused" }
  );
  assert.equal(logged.mock.callCount(), 1);
  // The API test reports its own failure without going through the catch-all.
  assert.deepEqual(
    await failing({ target: "background", type: "test-translation-api" }, SENDERS.popup.sender),
    { ok: false, error: "bad key" }
  );
  assert.equal(logged.mock.callCount(), 1);

  const { dispatch } = dispatcherWith({ overlayEnabled: true, saveSettings: { overlayEnabled: false } });
  assert.deepEqual(
    await dispatch({ target: "background", type: "toggle-overlay" }, SENDERS.webPage.sender),
    { ok: true, settings: { overlayEnabled: false }, enabled: false }
  );
});

test("every message waits for the worker to initialize", async () => {
  const order = [];
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const dispatch = createMessageDispatcher({
    runtime,
    ready: () => ready.then(() => order.push("ready")),
    services: { publicSettings: () => order.push("handler") }
  });
  const response = dispatch({ target: "background", type: "get-settings" }, SENDERS.popup.sender);
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  await response;
  assert.deepEqual(order, ["ready", "handler"]);
  assert.equal(isExtensionPageSender(SENDERS.contentScript.sender, runtime), false);
});
