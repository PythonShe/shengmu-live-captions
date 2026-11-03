import http from "node:http";

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * OpenAI-compatible /chat/completions on 127.0.0.1. `respond(segments)` maps
 * the request segments to translations; `gate`, when set, is awaited before the
 * reply so a test can hold a request in flight.
 */
export function startMockApi({ respond = (segments) => segments.map((segment) => `译:${segment}`) } = {}) {
  const requests = [];
  const control = { respond, gate: null };
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    const raw = await readRequest(request);
    const body = JSON.parse(raw || "{}");
    const payload = JSON.parse(body.messages?.at(-1)?.content || "{}");
    const segments = Array.isArray(payload.segments) ? payload.segments : [];
    requests.push({
      authorization: request.headers.authorization || "",
      body,
      payload,
      segments
    });
    if (control.gate) await control.gate;
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        model: "mock-translate",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify(control.respond(segments, payload))
            }
          }
        ],
        usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 }
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        control,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          })
      });
    });
  });
}

/** A promise plus its resolver, for holding a mock request in flight. */
export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
