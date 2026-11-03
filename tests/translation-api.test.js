import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildTranslationRequestBody,
  chatCompletionsUrl,
  isSplittableTranslationError,
  mapHttpError,
  TranslationApiError,
  normalizeTranslationBaseUrl,
  MAX_RETRY_AFTER_MS,
  normalizeTranslationSettings,
  parseRetryAfter,
  parseTranslationOutput,
  recentTranslationContext,
  resetTranslationRequestShapeCache,
  resolveTranslationConfig,
  testTranslationConnection,
  translateTexts,
  translationConfigIssue
} from "../extension/lib/translation-api.js";

function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
    requests.push({ request, body, bodyText });
    try {
      await handler({ request, body, bodyText, response, requests });
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          })
      });
    });
  });
}

function customConfig(baseUrl, overrides = {}) {
  return resolveTranslationConfig({
    translationMode: "api",
    translationProvider: "custom",
    translationBaseUrl: baseUrl,
    translationModel: "mock-model",
    translationTranslatePartial: true,
    ...overrides
  });
}

function deepseekConfig(baseUrl, overrides = {}) {
  return resolveTranslationConfig({
    translationMode: "api",
    translationProvider: "deepseek",
    translationBaseUrl: baseUrl,
    translationModel: "deepseek-chat",
    translationApiKeys: { deepseek: "test-key" },
    ...overrides
  });
}

function successBody(translations, { usage = true, model = "mock-model" } = {}) {
  return JSON.stringify({
    model,
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify(translations)
        }
      }
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
          }
        }
      : {})
  });
}

test("chatCompletionsUrl accepts base URLs, /v1 and full endpoints", () => {
  assert.equal(
    chatCompletionsUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1/chat/completions"
  );
  assert.equal(
    chatCompletionsUrl("https://api.deepseek.com/v1/"),
    "https://api.deepseek.com/v1/chat/completions"
  );
  assert.equal(
    chatCompletionsUrl("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions"
  );
  assert.throws(() => chatCompletionsUrl(""));
});

test("normalizeTranslationBaseUrl adds a protocol and strips trailing slashes", () => {
  assert.equal(
    normalizeTranslationBaseUrl("api.deepseek.com/v1/"),
    "https://api.deepseek.com/v1"
  );
  assert.equal(
    normalizeTranslationBaseUrl("http://127.0.0.1:8000/v1"),
    "http://127.0.0.1:8000/v1"
  );
  assert.equal(
    normalizeTranslationBaseUrl("https://example.com/v1?key=secret#x"),
    "https://example.com/v1"
  );
  assert.throws(() => normalizeTranslationBaseUrl("ftp://example.com"));
  assert.throws(
    () => normalizeTranslationBaseUrl("https://user:pass@example.com/v1"),
    /用户名或密码/
  );
});

test("translation settings default to the built-in translator and keep per-provider keys", () => {
  const defaults = normalizeTranslationSettings({});
  assert.equal(defaults.mode, "api");
  assert.equal(defaults.provider, "chrome");
  assert.equal(defaults.model, "builtin");
  assert.equal(defaults.baseUrl, "");
  assert.equal(defaults.translatePartial, true);
  const builtin = resolveTranslationConfig({});
  assert.equal(builtin.enabled, true, "no key needed");
  assert.equal(builtin.builtin, true);
  const deepseek = normalizeTranslationSettings({ translationProvider: "deepseek" });
  assert.equal(deepseek.model, "deepseek-chat");
  assert.equal(deepseek.baseUrl, "https://api.deepseek.com/v1");

  const withKeys = normalizeTranslationSettings({
    translationApiKeys: {
      deepseek: "  dk  ",
      openai: "ok",
      unknown: "ignored"
    }
  });
  assert.deepEqual(withKeys.apiKeys, { chrome: "", deepseek: "dk", openai: "ok", bailian: "", custom: "" });
});

test("translationConfigIssue requires a key only for providers that need one", () => {
  const deepseek = resolveTranslationConfig({
    translationMode: "api",
    translationProvider: "deepseek"
  });
  assert.equal(deepseek.enabled, false);
  assert.match(translationConfigIssue(deepseek), /API Key/);

  const custom = resolveTranslationConfig({
    translationMode: "api",
    translationProvider: "custom",
    translationBaseUrl: "http://127.0.0.1:11434/v1",
    translationModel: "qwen"
  });
  assert.equal(custom.enabled, true);
  assert.equal(translationConfigIssue(custom), "");

  const server = resolveTranslationConfig({
    translationMode: "server",
    translationProvider: "deepseek"
  });
  assert.equal(server.enabled, false);

  const insecure = resolveTranslationConfig({
    translationMode: "api",
    translationProvider: "deepseek",
    translationBaseUrl: "http://example.com/v1",
    translationApiKeys: { deepseek: "secret" }
  });
  assert.equal(insecure.enabled, false);
  assert.match(insecure.issue, /http:/);

  const localHttp = resolveTranslationConfig({
    translationMode: "api",
    translationProvider: "custom",
    translationBaseUrl: "http://127.0.0.1:11434/v1",
    translationModel: "qwen",
    translationApiKeys: { custom: "secret" }
  });
  assert.equal(localHttp.enabled, true);
});

test("recentTranslationContext keeps the latest translated lines", () => {
  const context = recentTranslationContext(
    [
      { source: "one", translation: "一" },
      { source: "two", translation: "" },
      { source: "three", translation: "三" },
      { source: "four", translation: "四" },
      { source: "five", translation: "五" }
    ],
    2
  );
  assert.deepEqual(context, [
    { source: "four", translation: "四" },
    { source: "five", translation: "五" }
  ]);
});

test("recentTranslationContext keeps untranslated rows and skips the current batch", () => {
  const lines = [
    { id: "a", source: "and riddled with excitement", translation: "" },
    { id: "b", source: "he wants to learn", translation: "" },
    { id: "c", source: "how to merge modern Kalgurin techniques", translation: "" }
  ];
  // A pending row is the most useful context there is: dropping untranslated
  // rows made every batch look like the start of a conversation.
  const context = recentTranslationContext(lines, 4, new Set(["c"]));
  assert.deepEqual(context, [
    { source: "and riddled with excitement", translation: "" },
    { source: "he wants to learn", translation: "" }
  ]);
});

test("system prompt tells the model that segments are one continuous utterance", () => {
  const config = deepseekConfig("https://api.deepseek.com/v1");
  const body = buildTranslationRequestBody({ texts: ["one", "two"], config });
  const system = body.messages[0].content;
  assert.match(system, /相邻的片段来自同一段连续语音/);
  assert.match(system, /不要把上一片段的意思再译一遍/);
  assert.match(system, /context 是紧邻的前文/);
  assert.match(system, /7\. 输入中若有 partial 字段/);
  assert.match(system, /8\. 输入中若有 domain 字段/);
  assert.match(system, /9\. 输入中若有 glossary 字段/);
});

test("the system message is identical whatever partial, domain and glossary are", () => {
  const config = deepseekConfig("https://api.deepseek.com/v1");
  const glossaryEntries = [{ sources: ["Spirit"], target: "精魂" }];
  const a = buildTranslationRequestBody({ texts: ["Hi."], config });
  const b = buildTranslationRequestBody({
    texts: ["Your spirit is low."],
    config,
    partial: true,
    glossaryEntries,
    domainHint: "Path of Exile"
  });
  assert.equal(a.messages[0].content, b.messages[0].content);
  assert.notEqual(a.messages[1].content, b.messages[1].content);
});

test("custom provider pointed at DeepSeek also disables thinking", () => {
  const config = resolveTranslationConfig({
    translationProvider: "custom",
    translationBaseUrl: "https://api.deepseek.com/v1",
    translationModel: "deepseek-chat"
  });
  assert.equal(config.disableThinking, true);
  const body = buildTranslationRequestBody({ texts: ["Hi"], config });
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("buildTranslationRequestBody includes DeepSeek thinking-off and segments", () => {
  const config = deepseekConfig("https://api.deepseek.com/v1");
  const body = buildTranslationRequestBody({
    texts: ["Hello.", "Good morning."],
    context: [{ source: "Hi", translation: "嗨" }],
    config
  });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.model, "deepseek-chat");
  assert.equal(body.stream, false);
  assert.equal(
    JSON.parse(body.messages.at(-1).content).segments.length,
    2
  );

  const withoutThinking = buildTranslationRequestBody({
    texts: ["Hello."],
    config,
    includeThinking: false
  });
  assert.equal("thinking" in withoutThinking, false);
});

test("buildTranslationRequestBody injects only matched glossary terms and domain hint", () => {
  const config = deepseekConfig("https://api.deepseek.com/v1");
  const glossaryEntries = [
    { sources: ["Path of Exile", "Path of Excel"], target: "流放之路" },
    { sources: ["Spirit"], target: "精魂" },
    { sources: ["Chaos Orb"], target: "混沌石" }
  ];

  // Unmatched segments with no domain hint leave the request payload untouched.
  const plain = buildTranslationRequestBody({
    texts: ["Yes, wait a second."],
    context: [{ source: "Spirit is full", translation: "精魂满了" }],
    config,
    glossaryEntries
  });
  const plainPayload = JSON.parse(plain.messages[1].content);
  assert.equal("glossary" in plainPayload, false);
  assert.equal("domain" in plainPayload, false);
  assert.equal("partial" in plainPayload, false);

  // Matched segments inject only the hit entries (keyed by the ASR spelling)
  // and add the partial/domain fields to the user payload.
  const matched = buildTranslationRequestBody({
    texts: ["Welcome to path of excel, your spirit is low."],
    config,
    partial: true,
    glossaryEntries,
    domainHint: "Path of Exile (流放之路) 游戏直播"
  });
  const matchedPayload = JSON.parse(matched.messages[1].content);
  assert.deepEqual(matchedPayload.glossary, {
    "path of excel": "流放之路",
    spirit: "精魂"
  });
  assert.equal("Chaos Orb" in matchedPayload.glossary, false);
  assert.match(matchedPayload.partial, /尚未定稿的半句/);
  assert.equal(matchedPayload.domain, "Path of Exile (流放之路) 游戏直播");
  assert.equal(matched.messages[0].content, plain.messages[0].content);
});

test("parseTranslationOutput rejects JSON with extra non-empty items", () => {
  assert.throws(
    () => parseTranslationOutput('["你好","世界","多余"]', 2),
    (error) => error.code === "count_mismatch"
  );
  assert.deepEqual(parseTranslationOutput('["你好","世界",""]', 2), ["你好", "世界"]);
});

test("parseTranslationOutput handles JSON, code fences, objects and numbered lines", () => {
  assert.deepEqual(parseTranslationOutput('["你好","再见"]', 2), ["你好", "再见"]);
  assert.deepEqual(
    parseTranslationOutput('```json\n["你好"]\n```', 1),
    ["你好"]
  );
  assert.deepEqual(
    parseTranslationOutput('[{"translation":"你好"}]', 1),
    ["你好"]
  );
  assert.deepEqual(parseTranslationOutput('["你好",""]', 2), ["你好", ""]);
  assert.deepEqual(
    parseTranslationOutput('{"translations":["你好","再见"]}', 2),
    ["你好", "再见"]
  );
  assert.deepEqual(
    parseTranslationOutput("1. 你好\n2. 再见", 2),
    ["你好", "再见"]
  );
  assert.deepEqual(
    parseTranslationOutput("[1] 你好\n[2] 再见", 2),
    ["你好", "再见"]
  );
  assert.throws(
    () => parseTranslationOutput("1. 你好\n2. 再见\n注意：这是解释", 2),
    /条数不匹配/
  );
  assert.throws(
    () => parseTranslationOutput('["只有一条"]', 2),
    /条数不匹配/
  );
  assert.throws(
    () => parseTranslationOutput('["译A","译C"]', 3),
    /条数不匹配/
  );
  assert.throws(
    () => parseTranslationOutput('[ "你好", "今天', 2),
    /JSON 不完整/
  );
  assert.deepEqual(parseTranslationOutput("not a translation", 1), [
    "not a translation"
  ]);
  assert.throws(() => parseTranslationOutput("", 1), /空内容/);
  assert.throws(() => parseTranslationOutput("   ", 1), /空内容/);
});

test("mapHttpError produces actionable Chinese messages", () => {
  assert.match(mapHttpError(401, "{}", "DeepSeek").message, /Key 无效/);
  assert.equal(mapHttpError(402, "{}", "DeepSeek").code, "balance");
  assert.equal(mapHttpError(429, "{}", "DeepSeek").code, "rate_limit");
  assert.equal(mapHttpError(400, "{}", "DeepSeek").code, "bad_request");
  assert.equal(mapHttpError(503, "{}", "DeepSeek").code, "server");
});

test("translateTexts sends an OpenAI-compatible request and returns usage", async () => {
  const server = await startServer(({ response, body }) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      successBody(
        body.messages.at(-1).content.includes("Good morning")
          ? ["你好。", "早上好。"]
          : ["你好。"]
      )
    );
  });
  try {
    const config = deepseekConfig(server.url);
    const result = await translateTexts({
      texts: ["Hello.", "Good morning."],
      context: [{ source: "Hi", translation: "嗨" }],
      config
    });
    assert.deepEqual(result.translations, ["你好。", "早上好。"]);
    assert.equal(result.usage.promptTokens, 11);
    assert.equal(result.usage.completionTokens, 7);
    assert.equal(result.model, "mock-model");

    const request = server.requests[0];
    assert.equal(
      request.request.headers.authorization,
      "Bearer test-key"
    );
    assert.equal(request.body.model, "deepseek-chat");
    assert.deepEqual(request.body.thinking, { type: "disabled" });
    assert.equal(request.body.messages[0].role, "system");
  } finally {
    await server.close();
  }
});

test("translateTexts omits Authorization when no key is configured", async () => {
  const server = await startServer(({ response }) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(successBody(["你好。"]));
  });
  try {
    await translateTexts({
      texts: ["Hello."],
      config: customConfig(server.url)
    });
    assert.equal(server.requests[0].request.headers.authorization, undefined);
  } finally {
    await server.close();
  }
});

test("translateTexts retries once without thinking when the endpoint rejects it", async () => {
  const server = await startServer(({ response, body, requests }) => {
    if (requests.length === 1) {
      assert.deepEqual(body.thinking, { type: "disabled" });
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "unknown parameter: thinking" }
        })
      );
      return;
    }
    assert.equal("thinking" in body, false);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(successBody(["你好。"]));
  });
  try {
    const result = await translateTexts({
      texts: ["Hello."],
      config: deepseekConfig(server.url)
    });
    assert.deepEqual(result.translations, ["你好。"]);
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("translateTexts retries with max_completion_tokens when an endpoint rejects max_tokens", async () => {
  const server = await startServer(({ response, body, requests }) => {
    if (requests.length === 1) {
      assert.equal(body.max_tokens, 192);
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Unsupported parameter: max_tokens" }
        })
      );
      return;
    }
    assert.equal("max_tokens" in body, false);
    assert.equal(body.max_completion_tokens, 192);
    assert.equal("temperature" in body, false);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(successBody(["你好。"]));
  });
  try {
    const result = await translateTexts({
      texts: ["Hello."],
      config: customConfig(server.url)
    });
    assert.deepEqual(result.translations, ["你好。"]);
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("translateTexts retries without temperature when an endpoint rejects it", async () => {
  const server = await startServer(({ response, body, requests }) => {
    if (requests.length === 1) {
      assert.equal(body.temperature, 0.2);
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "temperature is not supported" } })
      );
      return;
    }
    assert.equal("temperature" in body, false);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(successBody(["你好。"]));
  });
  try {
    const result = await translateTexts({
      texts: ["Hello."],
      config: customConfig(server.url)
    });
    assert.deepEqual(result.translations, ["你好。"]);
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("translateTexts rejects a length-truncated completion", async () => {
  const server = await startServer(({ response }) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        model: "mock-model",
        choices: [
          {
            message: { role: "assistant", content: '["你好。", "早上"' },
            finish_reason: "length"
          }
        ]
      })
    );
  });
  try {
    await assert.rejects(
      translateTexts({ texts: ["Hello.", "Good morning."], config: customConfig(server.url) }),
      (error) => {
        assert.equal(error.code, "truncated");
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("translateTexts reports auth and malformed responses", async () => {
  const authServer = await startServer(({ response }) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid key" } }));
  });
  try {
    await assert.rejects(
      translateTexts({
        texts: ["Hello."],
        config: deepseekConfig(authServer.url)
      }),
      (error) => {
        assert.equal(error.code, "auth");
        assert.match(error.message, /Key 无效/);
        return true;
      }
    );
  } finally {
    await authServer.close();
  }

  const badServer = await startServer(({ response }) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
  });
  try {
    await assert.rejects(
      translateTexts({
        texts: ["Hello."],
        config: customConfig(badServer.url)
      }),
      /空内容/
    );
  } finally {
    await badServer.close();
  }
});

test("translateTexts turns a slow request into a timeout error", async () => {
  const server = await startServer(({ response }) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(successBody(["你好。"]));
    }, 300);
  });
  try {
    const config = { ...customConfig(server.url), timeoutMs: 60 };
    await assert.rejects(
      translateTexts({ texts: ["Hello."], config }),
      (error) => {
        assert.equal(error.code, "timeout");
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("translateTexts times out when the response body stalls after headers", async () => {
  const server = await startServer(({ response }) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders?.();
    // Intentionally never end the body.
  });
  try {
    const config = { ...customConfig(server.url), timeoutMs: 80 };
    await assert.rejects(
      translateTexts({ texts: ["Hello."], config }),
      (error) => {
        assert.equal(error.code, "timeout");
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("translateTexts can be aborted by the caller", async () => {
  const server = await startServer(({ response }) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(successBody(["你好。"]));
    }, 300);
  });
  try {
    const controller = new AbortController();
    const pending = translateTexts({
      texts: ["Hello."],
      config: customConfig(server.url),
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, "aborted");
      return true;
    });
  } finally {
    await server.close();
  }
});

test("testTranslationConnection performs a real round trip", async () => {
  const server = await startServer(({ response }) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(successBody(["你好，欢迎来到今天的直播。"]));
  });
  try {
    const result = await testTranslationConnection(customConfig(server.url));
    assert.equal(result.ok, true);
    assert.equal(result.translation, "你好，欢迎来到今天的直播。");
    assert.ok(result.latencyMs >= 0);
  } finally {
    await server.close();
  }
});

test("translateTexts learns the request shape and skips failed round trips next time", async () => {
  resetTranslationRequestShapeCache();
  // Rejects thinking, then temperature, then max_tokens, one field per call.
  const server = await startServer(({ response, body }) => {
    const reject = (message) => {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message } }));
    };
    if ("thinking" in body) return reject("unknown parameter: thinking");
    if ("temperature" in body) return reject("temperature is not supported");
    if ("max_tokens" in body) return reject("use max_completion_tokens instead of max_tokens");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(successBody(["你好。"]));
  });
  try {
    const first = await translateTexts({
      texts: ["Hello."],
      config: deepseekConfig(server.url)
    });
    assert.deepEqual(first.translations, ["你好。"]);
    assert.equal(server.requests.length, 4);

    // Same endpoint and model with a different key still reuses the shape.
    await translateTexts({
      texts: ["Hello."],
      config: deepseekConfig(server.url, {
        translationApiKeys: { deepseek: "another-key" }
      })
    });
    assert.equal(server.requests.length, 5);
    const last = server.requests.at(-1).body;
    assert.equal("thinking" in last, false);
    assert.equal("max_tokens" in last, false);
    assert.equal("temperature" in last, false);
    assert.ok(last.max_completion_tokens);

    resetTranslationRequestShapeCache();
    await translateTexts({
      texts: ["Hello."],
      config: deepseekConfig(server.url)
    });
    assert.equal(server.requests.length, 9);
  } finally {
    resetTranslationRequestShapeCache();
    await server.close();
  }
});

test("the learned request shape is per endpoint and model", async () => {
  resetTranslationRequestShapeCache();
  const server = await startServer(({ response, body }) => {
    if ("thinking" in body) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unknown parameter: thinking" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(successBody(["你好。"]));
  });
  try {
    await translateTexts({ texts: ["Hi."], config: deepseekConfig(server.url) });
    assert.equal(server.requests.length, 2);
    // A different model on the same endpoint starts from the defaults again.
    await translateTexts({
      texts: ["Hi."],
      config: deepseekConfig(server.url, { translationModel: "other-model" })
    });
    assert.equal(server.requests.length, 4);
  } finally {
    resetTranslationRequestShapeCache();
    await server.close();
  }
});

test("parseRetryAfter reads seconds and HTTP dates and clamps the result", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter(" 1.5 ", now), 1500);
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now), 0);
  assert.equal(parseRetryAfter("86400", now), MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter("", now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter("soon", now), null);
  assert.equal(parseRetryAfter("-5", now), null);
});

test("mapHttpError exposes retryAfterMs only for 429 and 503", () => {
  assert.equal(mapHttpError(429, "{}", "X", "3").retryAfterMs, 3000);
  assert.equal(mapHttpError(503, "{}", "X", "4").retryAfterMs, 4000);
  assert.equal(mapHttpError(500, "{}", "X", "4").retryAfterMs, null);
  assert.equal(mapHttpError(429, "{}", "X").retryAfterMs, null);
});

test("translateTexts surfaces the Retry-After header on a 429", async () => {
  resetTranslationRequestShapeCache();
  const server = await startServer(({ response }) => {
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "7"
    });
    response.end(JSON.stringify({ error: { message: "slow down" } }));
  });
  try {
    await assert.rejects(
      translateTexts({ texts: ["Hi."], config: customConfig(server.url) }),
      (error) =>
        error.code === "rate_limit" &&
        error.status === 429 &&
        error.retryAfterMs === 7000
    );
  } finally {
    await server.close();
  }
});

test("isSplittableTranslationError flags only batch-shape failures", () => {
  const codeOf = (code) => new TranslationApiError("x", { code });
  assert.equal(isSplittableTranslationError(codeOf("count_mismatch"), 4), true);
  assert.equal(isSplittableTranslationError(codeOf("parse_error"), 2), true);
  assert.equal(isSplittableTranslationError(codeOf("truncated")), true);
  assert.equal(isSplittableTranslationError(codeOf("count_mismatch"), 1), false);
  for (const code of ["auth", "rate_limit", "timeout", "network", "aborted", "empty_response"]) {
    assert.equal(isSplittableTranslationError(codeOf(code), 4), false, code);
  }
  assert.equal(isSplittableTranslationError(new Error("boom"), 4), false);
});

test("parseTranslationOutput keeps stable codes and the exact-count rule", () => {
  const codeOf = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.code;
    }
    return null;
  };
  assert.equal(codeOf(() => parseTranslationOutput('["a","b","c"]', 2)), "count_mismatch");
  assert.equal(codeOf(() => parseTranslationOutput('["a"]', 2)), "count_mismatch");
  assert.equal(codeOf(() => parseTranslationOutput('["a", ', 2)), "parse_error");
  assert.deepEqual(parseTranslationOutput('["a","b",""]', 2), ["a", "b"]);
});
