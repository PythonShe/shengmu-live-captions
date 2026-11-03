#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock for testing 声幕's translation API client
 * without a real DeepSeek/OpenAI key.
 *
 *   node paseo/mock-openai-server.mjs
 *   # in the extension: engine=API, provider=自定义兼容 API
 *   # API 地址 http://127.0.0.1:8787/v1, 模型 mock-translate
 *
 * Environment:
 *   PORT=8787           listen port
 *   MOCK_DELAY_MS=0     artificial response delay
 *   MOCK_STATUS=200     force an HTTP error status (401/402/429/400/500...)
 *   MOCK_THINKING=0     if 1, reject requests that contain thinking
 */

import http from "node:http";

const port = Number(process.env.PORT) || 8787;
const delayMs = Number(process.env.MOCK_DELAY_MS) || 0;
const forcedStatus = Number(process.env.MOCK_STATUS) || 200;
const rejectThinking = process.env.MOCK_THINKING === "1";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { status: "ok", mode: "mock-openai" });
    return;
  }
  if (
    request.method !== "POST" ||
    !/\/chat\/completions$/.test(url.pathname)
  ) {
    send(response, 404, { error: { message: "not found" } });
    return;
  }

  const raw = await readBody(request);
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    send(response, 400, { error: { message: "invalid json" } });
    return;
  }
  const auth = request.headers.authorization || "";
  console.log(
    `[mock] POST ${url.pathname} model=${body.model} key=${
      auth ? "present" : "none"
    } thinking=${Boolean(body.thinking)}`
  );

  if (rejectThinking && body.thinking) {
    send(response, 400, {
      error: { message: "unknown parameter: thinking (mock)" }
    });
    return;
  }
  if (forcedStatus !== 200) {
    send(response, forcedStatus, {
      error: { message: `mock forced status ${forcedStatus}` }
    });
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(body.messages?.at(-1)?.content || "{}");
  } catch {
    payload = {};
  }
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const translations = segments.map((segment) => `【模拟译文】${segment}`);
  const content = JSON.stringify(translations);

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  send(response, 200, {
    id: "mock-completion",
    object: "chat.completion",
    model: body.model || "mock-translate",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 20 + segments.join("").length,
      completion_tokens: 10 + translations.join("").length,
      total_tokens:
        30 + segments.join("").length + translations.join("").length
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock] listening on http://127.0.0.1:${port}/v1`);
  console.log("[mock] extension settings: provider=custom, model=mock-translate");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
