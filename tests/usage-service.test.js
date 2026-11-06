import assert from "node:assert/strict";
import test from "node:test";

import { createUsageService } from "../extension/background/usage-service.js";

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

const CONFIG = {
  bailian: { provider: "bailian", model: "qwen-mt-flash", apiKey: "sk" },
  deepl: { provider: "deepl", model: "", apiKey: "abc:fx", baseUrl: "https://api.deepl.com/v2" },
  deepseek: { provider: "deepseek", model: "deepseek-flash", apiKey: "sk2", baseUrl: "https://api.deepseek.com/v1" }
};

test("recorded usage lands in the ledger after a flush", async () => {
  const storage = fakeStorage();
  const service = createUsageService({
    getConfig: () => CONFIG.bailian,
    storage,
    fetchImpl: async () => ({ ok: false, status: 500 }),
    now: () => new Date(2026, 10, 5, 12).getTime(),
    setTimeout: (callback) => setTimeout(callback, 0),
    clearTimeout: (handle) => clearTimeout(handle)
  });
  service.record({ requests: 1, promptTokens: 100, completionTokens: 40 }, CONFIG.bailian);
  service.record({ requests: 1, promptTokens: 20, completionTokens: 10 }, CONFIG.bailian);
  await service.flush();

  const day = storage.data.usageLedger.days["2026-11-05"];
  assert.deepEqual(day["bailian:qwen-mt-flash"], {
    requests: 2,
    promptTokens: 120,
    completionTokens: 50,
    billedCharacters: 0
  });

  const snapshot = await service.snapshot();
  assert.equal(snapshot.today.requests, 2);
  assert.equal(snapshot.month.requests, 2);
});

test("the remote cache is not shared between providers", async () => {
  let config = CONFIG.deepl;
  const service = createUsageService({
    getConfig: () => config,
    storage: fakeStorage(),
    now: () => 1000,
    fetchImpl: async (url) => {
      if (url.includes("deepl")) {
        return { ok: true, json: async () => ({ character_count: 10, character_limit: 500000 }) };
      }
      return {
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "5.00", granted_balance: "0", topped_up_balance: "5" }]
        })
      };
    }
  });

  const deepl = await service.snapshot();
  assert.deepEqual(deepl.remote, { provider: "deepl", kind: "characters", used: 10, limit: 500000 });

  // Switching providers inside the cache window must not hand back DeepL's
  // numbers. The cache used to be keyed by time only, so it did.
  config = CONFIG.deepseek;
  const swapped = await service.snapshot();
  assert.equal(swapped.remote.kind, "balance");
  assert.equal(swapped.remote.total, 5);

  // Same provider again: the cached answer is reused (no second request).
  const again = await service.snapshot();
  assert.deepEqual(again.remote, swapped.remote);
});

test("providers without an endpoint say why rather than showing nothing", async () => {
  const service = createUsageService({
    getConfig: () => CONFIG.bailian,
    storage: fakeStorage(),
    fetchImpl: async () => {
      throw new Error("must not be called");
    }
  });
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.remote, {
    provider: "bailian",
    kind: "unavailable",
    reason: "console_only"
  });
});
