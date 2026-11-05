import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEPL_GLOSSARY_STORAGE_KEY,
  createDeepLGlossaryService
} from "../extension/background/deepl-glossary-service.js";

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) {
      return typeof key === "string" ? { [key]: data[key] } : { ...data };
    },
    async set(patch) {
      Object.assign(data, patch);
    }
  };
}

const ENTRIES = [
  { sources: ["Spirit"], target: "精魂" },
  { sources: ["Orb of Augmentation"], target: "增幅之球" }
];

function deeplConfig(overrides = {}) {
  return {
    provider: "deepl",
    protocol: "deepl",
    apiKey: "key:fx",
    baseUrl: "https://api-free.deepl.com/v2",
    glossaryEntries: ENTRIES,
    ...overrides
  };
}

/** Routes on method + path, records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${method} ${new URL(url).pathname}`];
    if (!handler) {
      return { ok: false, status: 404, text: async () => "{}", json: async () => ({}) };
    }
    return handler({ url, init });
  };
  return { calls, fetchImpl };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

test("the first sync creates one glossary and a repeat reuses it", async () => {
  const storage = fakeStorage();
  const { calls, fetchImpl } = fakeFetch({
    "POST /v2/glossaries": () =>
      jsonResponse(201, { glossary_id: "g-1", entry_count: 4 })
  });
  const service = createDeepLGlossaryService({
    getConfig: () => deeplConfig(),
    storage,
    fetchImpl
  });
  await service.load();

  const first = await service.sync();
  assert.deepEqual(first, { created: true, count: 4, stale: false });
  assert.equal(service.currentId(), "g-1");
  assert.equal(storage.data[DEEPL_GLOSSARY_STORAGE_KEY].glossaryId, "g-1");

  // The body carries the TSV with the lowercase variants and root ZH.
  const body = calls[0].body;
  assert.equal(body.entries_format, "tsv");
  assert.equal(body.source_lang, "EN");
  assert.equal(body.target_lang, "ZH");
  assert.equal(body.entries, "Spirit\t精魂\nspirit\t精魂\nOrb of Augmentation\t增幅之球\norb of augmentation\t增幅之球");

  const second = await service.sync();
  assert.deepEqual(second, { created: false, count: 4, stale: false });
  assert.equal(calls.length, 1, "an unchanged term base sends nothing");
});

test("a changed term base deletes the only glossary before recreating it", async () => {
  const storage = fakeStorage();
  const { calls, fetchImpl } = fakeFetch({
    "POST /v2/glossaries": () => jsonResponse(201, { glossary_id: "g-2", entry_count: 2 }),
    "DELETE /v2/glossaries/g-1": () => jsonResponse(204, {})
  });
  const service = createDeepLGlossaryService({
    getConfig: () => deeplConfig({ glossaryEntries: ENTRIES }),
    storage,
    fetchImpl
  });
  await service.load();
  storage.data[DEEPL_GLOSSARY_STORAGE_KEY] = {
    glossaryId: "g-1",
    fingerprint: "old",
    count: 2,
    updatedAt: "2026-11-01T00:00:00.000Z"
  };
  await service.load();

  const result = await service.sync();
  assert.equal(result.created, true);
  assert.deepEqual(calls.map((call) => call.method), ["DELETE", "POST"]);
  assert.equal(service.currentId(), "g-2");
});

test("status reports a stale glossary without touching the network", async () => {
  const storage = fakeStorage();
  const { calls, fetchImpl } = fakeFetch({});
  const service = createDeepLGlossaryService({
    getConfig: () => deeplConfig(),
    storage,
    fetchImpl
  });
  await service.load();
  assert.equal(service.status().stale, true, "nothing synced yet");
  assert.equal(service.status().entryCount, 4);

  // A stored fingerprint that no longer matches the term base is what the
  // panel shows as "pending": no request is made to find that out.
  storage.data[DEEPL_GLOSSARY_STORAGE_KEY] = {
    glossaryId: "g-1",
    fingerprint: "different",
    count: 4,
    updatedAt: "2026-11-05T00:00:00.000Z"
  };
  await service.load();
  assert.equal(service.status().stale, true);
  assert.equal(calls.length, 0);
});

test("a second glossary on a free account surfaces as a quota error", async () => {
  const { fetchImpl } = fakeFetch({
    "POST /v2/glossaries": () => jsonResponse(456, { message: "Too many glossaries" })
  });
  const service = createDeepLGlossaryService({
    getConfig: () => deeplConfig(),
    storage: fakeStorage(),
    fetchImpl
  });
  await service.load();
  await assert.rejects(
    service.sync(),
    // The server's own wording rides along as a message parameter so the panel
    // can show why (usually "Too many glossaries" on a Free account).
    (error) =>
      error.code === "glossary_quota" &&
      error.status === 456 &&
      error.localMessage?.params?.[1] === "Too many glossaries"
  );
});

test("only DeepL can own a glossary, and an empty term base is refused", async () => {
  const service = createDeepLGlossaryService({
    getConfig: () => deeplConfig({ provider: "openai", protocol: "openai" }),
    storage: fakeStorage(),
    fetchImpl: async () => jsonResponse(500, {})
  });
  await service.load();
  await assert.rejects(service.sync(), (error) => error.code === "config");

  const empty = createDeepLGlossaryService({
    getConfig: () => deeplConfig({ glossaryEntries: [] }),
    storage: fakeStorage(),
    fetchImpl: async () => jsonResponse(500, {})
  });
  await empty.load();
  await assert.rejects(empty.sync(), (error) => error.code === "config");
});

test("a failed recreate drops the deleted id instead of keeping a dead one", async () => {
  const storage = fakeStorage();
  const { fetchImpl } = fakeFetch({
    "DELETE /v2/glossaries/g-1": () => jsonResponse(204, {}),
    "POST /v2/glossaries": () => jsonResponse(500, { message: "boom" })
  });
  const service = createDeepLGlossaryService({
    getConfig: () => deeplConfig(),
    storage,
    fetchImpl
  });
  await service.load();
  storage.data[DEEPL_GLOSSARY_STORAGE_KEY] = {
    glossaryId: "g-1",
    fingerprint: "old",
    count: 2,
    updatedAt: "2026-11-01T00:00:00.000Z"
  };
  await service.load();
  assert.equal(service.currentId(), "g-1");

  await assert.rejects(service.sync(), (error) => error.code === "glossary_create_failed");
  // Translations must stop carrying an id that no longer exists: the next
  // request would otherwise fail once and only then retry without it.
  assert.equal(service.currentId(), "");
  assert.equal(storage.data[DEEPL_GLOSSARY_STORAGE_KEY].glossaryId, "");
  assert.equal(service.status().synced, false);
});
