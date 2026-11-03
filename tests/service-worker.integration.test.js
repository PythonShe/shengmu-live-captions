import assert from "node:assert/strict";
import test from "node:test";

import { CONTENT_SENDER, installChromeMock } from "./helpers/chrome-mock.js";
import { startMockApi } from "./helpers/mock-translation-api.js";

const mock = installChromeMock();
const { sendToBackground } = mock;

await import("../extension/background/service-worker.js");
await new Promise((resolve) => {
  setTimeout(resolve, 30);
});

test("background defaults to the built-in translator and never broadcasts API keys", async () => {
  const state = await sendToBackground({ target: "background", type: "get-state" });
  assert.equal(state.ok, true);
  assert.equal(state.settings.translationMode, "api");
  assert.equal(state.settings.translationProvider, "chrome");
  assert.equal(state.settings.asrBackend, "chrome");
  assert.equal("translationApiKeys" in state.settings, false);
  assert.deepEqual(state.settings.translationApiKeyConfigured, {
    chrome: false,
    deepseek: false,
    openai: false,
    bailian: false,
    custom: false
  });
});

test("content scripts cannot change translation endpoints or keys", async () => {
  const api = await startMockApi();
  try {
    const saved = await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: {
        translationMode: "api",
        translationProvider: "custom",
        translationBaseUrl: api.url,
        translationModel: "mock-translate",
        translationApiKeys: { custom: "secret-key" }
      }
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.translationBaseUrl, api.url);
    assert.equal(saved.settings.translationApiKeyConfigured.custom, true);

    const contentSave = await sendToBackground(
      {
        target: "background",
        type: "save-settings",
        settings: {
          displayMode: "chinese",
          translationMode: "server",
          translationBaseUrl: "https://attacker.example/v1",
          translationApiKeys: { deepseek: "stolen" }
        }
      },
      CONTENT_SENDER
    );
    assert.equal(contentSave.ok, true);
    assert.equal(contentSave.settings.displayMode, "chinese");
    assert.equal(contentSave.settings.translationMode, "api");
    assert.equal(contentSave.settings.translationBaseUrl, api.url);
    assert.equal("translationApiKeys" in contentSave.settings, false);

    const state = await sendToBackground({
      target: "background",
      type: "get-state"
    });
    assert.equal(state.settings.translationMode, "api");
    assert.equal(state.settings.translationBaseUrl, api.url);
    assert.equal(state.settings.translationApiKeyConfigured.custom, true);
    assert.equal("translationApiKeys" in state.settings, false);

    const switched = await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: { translationProvider: "deepseek" }
    });
    assert.equal(switched.settings.translationBaseUrl, "https://api.deepseek.com/v1");
    assert.equal(switched.settings.translationModel, "deepseek-chat");
    assert.equal(switched.settings.translationApiKeyConfigured.custom, true);

    // Restore the custom endpoint for the next test.
    await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: {
        translationProvider: "custom",
        translationBaseUrl: api.url,
        translationModel: "mock-translate"
      }
    });

    const contentTest = await sendToBackground(
      { target: "background", type: "test-translation-api" },
      CONTENT_SENDER
    );
    assert.equal(contentTest.ok, false);
    assert.match(contentTest.error, /扩展界面/);
  } finally {
    await api.close();
  }
});

test("editing the endpoint clears the stored key for that provider", async () => {
  const api = await startMockApi();
  try {
    await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: {
        translationProvider: "custom",
        translationBaseUrl: api.url,
        translationModel: "mock-translate",
        translationApiKeys: { custom: "secret-key" }
      }
    });
    const changed = await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: { translationBaseUrl: `${api.url}/v2` }
    });
    assert.equal(changed.settings.translationApiKeyConfigured.custom, false);
    await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: {
        translationProvider: "custom",
        translationBaseUrl: api.url,
        translationModel: "mock-translate",
        translationApiKeys: { custom: "secret-key" }
      }
    });
  } finally {
    await api.close();
  }
});

test("extension UI can test the configured translation API", async () => {
  const api = await startMockApi();
  try {
    await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: {
        translationProvider: "custom",
        translationBaseUrl: api.url,
        translationModel: "mock-translate",
        translationApiKeys: { custom: "secret-key" }
      }
    });
    const response = await sendToBackground({
      target: "background",
      type: "test-translation-api"
    });
    assert.equal(response.ok, true);
    assert.equal(response.result.translation.includes("译:"), true);
    assert.equal(response.result.model, "mock-translate");
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].authorization, "Bearer secret-key");
  } finally {
    await api.close();
  }
});

test("refresh-overlay refuses to inject without an active capture", async () => {
  const response = await sendToBackground({
    target: "background",
    type: "refresh-overlay"
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /没有正在采集的标签页/);
});

test("content scripts cannot force overlay re-injection", async () => {
  const response = await sendToBackground(
    { target: "background", type: "refresh-overlay" },
    CONTENT_SENDER
  );
  assert.equal(response.ok, false);
  assert.match(response.error, /扩展界面|拒绝/);
});

test("service worker injects active glossary and domain hint into API requests", async () => {
  const api = await startMockApi();
  try {
    await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: {
        translationMode: "api",
        translationProvider: "custom",
        translationBaseUrl: api.url,
        translationModel: "mock-translate",
        translationApiKeys: { custom: "secret-key" },
        glossaryEnabled: true,
        glossaryPresetIds: ["poe"],
        glossaryDomainHint: "",
        customGlossary: "live stream -> 直播间"
      }
    });
    const response = await sendToBackground({
      target: "background",
      type: "test-translation-api"
    });
    assert.equal(response.ok, true);
    assert.equal(api.requests.length, 1);
    const [systemMsg, userMsg] = api.requests[0].body.messages;
    const userPayload = JSON.parse(userMsg.content);
    assert.match(userPayload.domain, /Path of Exile \(流放之路\) 游戏直播/);
    assert.deepEqual(userPayload.glossary, { "live stream": "直播间" });

    await sendToBackground({
      target: "background",
      type: "save-settings",
      settings: { glossaryEnabled: false }
    });
    const disabledResp = await sendToBackground({
      target: "background",
      type: "test-translation-api"
    });
    assert.equal(disabledResp.ok, true);
    assert.equal(api.requests.length, 2);
    const [disabledSys, disabledUser] = api.requests[1].body.messages;
    assert.equal(disabledSys.content, systemMsg.content);
    assert.equal("domain" in JSON.parse(disabledUser.content), false);
    assert.equal("glossary" in JSON.parse(disabledUser.content), false);
  } finally {
    await api.close();
  }
});
