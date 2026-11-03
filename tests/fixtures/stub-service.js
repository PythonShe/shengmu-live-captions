// Stand-in for whisperlivekit-server, llama-server and whisper-server in the
// service tests: `node stub-service.js <kind> <real CLI args...>`. It listens
// on --port, answers /health and /v1/models like the real servers, and writes
// what it was launched with to $SHENGMU_STUB_RECORD_DIR/<kind>-<pid>.json.
//
// Knobs (environment, per kind in upper case: WLK, LLAMA, WHISPER):
//   SHENGMU_STUB_<KIND>_FAIL=1             exit 3 at once, with a stderr line
//   SHENGMU_STUB_<KIND>_HEALTH_DELAY_MS=n  answer 503 on /health for n ms
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [kind, ...argv] = process.argv.slice(2);
const KIND = { wlk: "WLK", llama: "LLAMA", whisper: "WHISPER" }[kind] || String(kind).toUpperCase();
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (process.env[`SHENGMU_STUB_${KIND}_FAIL`] === "1") {
  process.stderr.write(`stub ${kind}: failing on purpose\n`);
  process.exit(3);
}

const recordDir = process.env.SHENGMU_STUB_RECORD_DIR;
if (recordDir) {
  fs.mkdirSync(recordDir, { recursive: true });
  const env = Object.fromEntries(
    ["HF_HUB_DISABLE_XET", "OPENAI_BASE_URL", "OPENAI_API_KEY"].map((key) => [key, process.env[key] ?? null])
  );
  fs.writeFileSync(
    path.join(recordDir, `${kind}-${process.pid}.json`),
    JSON.stringify({ kind, argv, env, cwd: process.cwd(), pid: process.pid })
  );
}

const startedAt = Date.now();
const healthDelay = Number(process.env[`SHENGMU_STUB_${KIND}_HEALTH_DELAY_MS`] || 0);

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/health") {
    if (Date.now() - startedAt < healthDelay) return send(503, { error: { code: 503, message: "Loading model" } });
    return send(200, { status: "ok" });
  }
  if (req.url === "/v1/models") {
    return send(200, { object: "list", data: [{ id: flag("--alias") || "stub", object: "model" }] });
  }
  return send(200, {});
});

server.listen(Number(flag("--port")), flag("--host") || "127.0.0.1", () => {
  process.stdout.write(`stub ${kind} listening\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
