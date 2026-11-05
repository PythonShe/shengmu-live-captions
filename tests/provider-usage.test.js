import assert from "node:assert/strict";
import test from "node:test";

import {
  deepseekOrigin,
  parseProviderUsage,
  providerUsageRequest
} from "../extension/lib/provider-usage.js";

test("DeepL usage is read from the host that matches the key", () => {
  const pro = providerUsageRequest({
    provider: "deepl",
    baseUrl: "https://api.deepl.com/v2",
    apiKey: "pro-key"
  });
  assert.equal(pro.url, "https://api.deepl.com/v2/usage");
  assert.equal(pro.headers.Authorization, "DeepL-Auth-Key pro-key");

  // A free key is served by the other host, so the usage call has to follow it.
  const free = providerUsageRequest({
    provider: "deepl",
    baseUrl: "https://api.deepl.com/v2",
    apiKey: "abc:fx"
  });
  assert.equal(free.url, "https://api-free.deepl.com/v2/usage");
  assert.deepEqual(parseProviderUsage("deepl", { character_count: 1234, character_limit: 500000 }), {
    kind: "characters",
    used: 1234,
    limit: 500000
  });
});

test("DeepSeek balance sits outside the OpenAI-compatible prefix", () => {
  assert.equal(deepseekOrigin("https://api.deepseek.com/v1"), "https://api.deepseek.com");
  assert.equal(deepseekOrigin("https://api.deepseek.com"), "https://api.deepseek.com");
  assert.equal(deepseekOrigin("https://api.deepseek.com/v1/"), "https://api.deepseek.com");
  assert.equal(deepseekOrigin("https://proxy.example.com/v1"), "");
  assert.equal(deepseekOrigin("not a url"), "");

  const request = providerUsageRequest({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk"
  });
  assert.equal(request.url, "https://api.deepseek.com/user/balance");
  assert.equal(request.headers.Authorization, "Bearer sk");

  const parsed = parseProviderUsage("deepseek", {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }
    ]
  });
  assert.deepEqual(parsed, {
    kind: "balance",
    available: true,
    currency: "CNY",
    total: 110,
    granted: 10,
    toppedUp: 100
  });
});

test("providers without a usage endpoint return nothing", () => {
  assert.equal(providerUsageRequest({ provider: "bailian", apiKey: "sk" }), null);
  assert.equal(providerUsageRequest({ provider: "openai", apiKey: "sk" }), null);
  assert.equal(providerUsageRequest({ provider: "chrome" }), null);
  // No key, no call: never send an empty Authorization header.
  assert.equal(providerUsageRequest({ provider: "deepl", baseUrl: "https://api.deepl.com/v2" }), null);
  assert.throws(() => parseProviderUsage("bailian", {}), /no usage endpoint/);
});
