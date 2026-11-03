import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isPidAlive, isPortListening, readPidFile } from "../scripts/local-service/processes.mjs";

// End-to-end over HTTP: server.mjs runs as its own process on a random port,
// with every directory in a temp folder and stub executables standing in for
// WhisperLiveKit and llama-server, so nothing in the repo is touched.

const SERVER = fileURLToPath(new URL("../scripts/local-service/server.mjs", import.meta.url));
const STUB = fileURLToPath(new URL("./fixtures/stub-service.js", import.meta.url));
const MODEL_9B = { subdir: "index-translate-9b", file: "Index-Translate-9B.Q4_K_M.gguf" };
const MODEL_2B = { subdir: "index-translate-2b", file: "Index-Translate-2B.IQ4_XS.gguf" };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Raw node:http so Host, Origin and Sec-Fetch-Site can be set freely. */
function request(port, { method = "GET", path: urlPath = "/health", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitFor(probe, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
}

async function launch(t, { env: extraEnv = {}, models = [MODEL_9B] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shengmu-control-"));
  const research = path.join(dir, "research");
  for (const model of models) {
    fs.mkdirSync(path.join(research, "models", model.subdir), { recursive: true });
    fs.writeFileSync(path.join(research, "models", model.subdir, model.file), "gguf");
  }
  const ports = { asr: await freePort(), translation: await freePort() };
  const env = {
    ...process.env,
    SHENGMU_LOCAL_SERVICE_PORT: "0",
    SHENGMU_LOCAL_SERVICE_PID_FILE: path.join(dir, "server.pid"),
    SHENGMU_RESEARCH_DIR: research,
    SHENGMU_LOGS_DIR: path.join(dir, "logs"),
    SHENGMU_RUNTIME_DIR: path.join(dir, "runtime"),
    SHENGMU_ASR_PORT: String(ports.asr),
    SHENGMU_TRANSLATION_PORT: String(ports.translation),
    SHENGMU_ASR_BACKEND: "faster-whisper",
    SHENGMU_WLK_COMMAND: JSON.stringify([process.execPath, STUB, "wlk"]),
    SHENGMU_LLAMA_COMMAND: JSON.stringify([process.execPath, STUB, "llama"]),
    SHENGMU_HEALTH_POLL_MS: "50",
    SHENGMU_STUB_RECORD_DIR: path.join(dir, "records"),
    HF_HUB_CACHE: path.join(dir, "hf"),
    ...extraEnv
  };
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const port = await waitFor(
    async () => Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]) || (child.exitCode != null && -1),
    "control service"
  );
  assert.ok(port > 0, `server.mjs exited early: ${stderr}`);
  const runtime = env.SHENGMU_RUNTIME_DIR;
  const ctx = {
    dir,
    port,
    ports,
    runtime,
    records: env.SHENGMU_STUB_RECORD_DIR,
    call: (options) => request(port, options),
    wlkRecords: () => readRecords(env.SHENGMU_STUB_RECORD_DIR, "wlk"),
    llamaRecords: () => readRecords(env.SHENGMU_STUB_RECORD_DIR, "llama"),
    // The record of the WLK process the PID file points at now. Ordering by
    // PID is not enough: Windows does not hand out PIDs in increasing order.
    currentWlk: () => {
      const { pid } = readPidFile(env.SHENGMU_RUNTIME_DIR, "wlk");
      return readRecords(env.SHENGMU_STUB_RECORD_DIR, "wlk").find((record) => record.pid === pid);
    }
  };
  t.after(async () => {
    const status = await ctx.call({ path: "/status" }).catch(() => null);
    if (status?.json?.job?.state !== "stopping") await ctx.call({ method: "POST", path: "/stop" }).catch(() => null);
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode != null) resolve();
      else child.once("exit", resolve);
    });
    // Last resort for a failed test: nothing may outlive the suite.
    for (const name of ["wlk", "llama-server"]) {
      const record = readPidFile(runtime, name);
      if (record && isPidAlive(record.pid)) process.kill(record.pid);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return ctx;
}

function readRecords(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${kind}-`))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

const EXT = { origin: "chrome-extension://abcdefghijklmnop" };

async function finished(ctx, label = "job to finish") {
  return waitFor(async () => {
    const { json } = await ctx.call({ path: "/status", headers: EXT });
    if (json.job.state === "error") throw new Error(`job failed: ${json.job.message}`);
    return json.job.state === "finished" ? json : null;
  }, label);
}

test("health, cors and the host / origin / fetch-site guards", async (t) => {
  const ctx = await launch(t);
  const health = await ctx.call({});
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, service: "shengmu-local", version: "1.1.0" });

  for (const host of [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`, `[::1]:${ctx.port}`]) {
    assert.equal((await ctx.call({ headers: { host } })).status, 200, host);
  }
  const rebinding = await ctx.call({ headers: { host: `evil.example:${ctx.port}` } });
  assert.equal(rebinding.status, 403);
  assert.deepEqual(rebinding.json, {
    ok: false,
    error: "只接受扩展页面调用",
    errorCode: "server_forbidden_origin",
    errorParams: []
  });
  assert.equal((await ctx.call({ headers: { host: "127.0.0.1:1" } })).status, 403);
  assert.equal((await ctx.call({ headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await ctx.call({ headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await ctx.call({ method: "POST", path: "/stop", headers: { origin: "https://evil.example" } })).status, 403);

  const allowed = await ctx.call({ headers: EXT });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["access-control-allow-origin"], EXT.origin);
  const preflight = await ctx.call({ method: "OPTIONS", path: "/start", headers: EXT });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-methods"], "GET,POST");

  const missing = await ctx.call({ path: "/nope" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.errorCode, "server_unknown_route");
  assert.deepEqual(missing.json.errorParams, ["GET /nope"]);
  const badJson = await ctx.call({ method: "POST", path: "/start", body: "{nope" });
  assert.equal(badJson.status, 500);
  assert.equal(badJson.json.error, "请求体不是合法 JSON");
  assert.equal(badJson.json.errorCode, "server_body_invalid_json");
  const tooLarge = await ctx.call({ method: "POST", path: "/start", body: JSON.stringify({ pad: "x".repeat(20000) }) });
  assert.equal(tooLarge.status, 500);
  assert.equal(tooLarge.json.error, "请求体过大");
  assert.equal(tooLarge.json.errorCode, "server_body_too_large");
});

test("status and models report the local tiers", async (t) => {
  const ctx = await launch(t);
  const status = await ctx.call({ path: "/status" });
  assert.equal(status.json.ok, true);
  assert.equal(status.json.job.state, "idle");
  assert.equal(status.json.job.messageKey, "");
  assert.equal(status.json.download, null);
  assert.equal(status.json.services.asr.port, ctx.ports.asr);
  assert.equal(status.json.services.asr.online, false);
  assert.equal(status.json.services.translation.port, ctx.ports.translation);

  const models = await ctx.call({ path: "/models" });
  assert.deepEqual(models.json.models.translation.map((entry) => [entry.id, entry.exists]), [
    ["9b-q4km", true],
    ["2b-iq4xs", false]
  ]);
  assert.equal(models.json.models.translation[1].pageUrl, "https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF");
  assert.deepEqual(models.json.models.translation[0].note, {
    key: "server_model_note_best_quality",
    params: ["5.4 GiB"]
  });
  assert.deepEqual(models.json.models.asr.map((entry) => [entry.id, entry.cached]), [
    ["large-v3-turbo", false],
    ["medium", false]
  ]);
  const turbo = models.json.models.asr[0];
  assert.equal(turbo.sizeLabel, "约 1.6 GB");
  assert.deepEqual(turbo.sizeNote, { key: "server_approx_size", params: ["1.6 GB"] });
  assert.deepEqual(turbo.note, { key: "server_asr_note_default", params: [] });

  const missing = await ctx.call({ method: "POST", path: "/start", body: { translationModel: "2b-iq4xs", asrModel: "medium" } });
  assert.equal(missing.status, 409);
  assert.equal(missing.json.needsDownload, "2b-iq4xs");
  assert.equal(missing.json.error, "本地翻译模型尚未下载：Index-Translate-2B.IQ4_XS.gguf");
  assert.equal(missing.json.errorCode, "server_translation_model_missing");
  assert.deepEqual(missing.json.errorParams, ["Index-Translate-2B.IQ4_XS.gguf"]);
  assert.match(missing.json.downloadUrl, /Index-Translate-2B-GGUF\/resolve\/main\/Index-Translate-2B\.IQ4_XS\.gguf$/);
  const unknown = await ctx.call({ method: "POST", path: "/start", body: { asrModel: "tiny" } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "未知的 ASR 模型");
  assert.equal(unknown.json.errorCode, "server_unknown_asr_model");
  assert.deepEqual(unknown.json.errorParams, []);
  const unknownTranslation = await ctx.call({ method: "POST", path: "/start", body: { asrModel: "medium", translationModel: "x" } });
  assert.equal(unknownTranslation.status, 400);
  assert.equal(unknownTranslation.json.errorCode, "server_unknown_translation_model");
});

test("start follows the translation mode and restarts WLK on mode or glossary changes", async (t) => {
  const ctx = await launch(t);
  const start = (body) => ctx.call({ method: "POST", path: "/start", headers: EXT, body });
  const apiMode = { translationModel: "9b-q4km", asrModel: "large-v3-turbo", translationMode: "api", apiTranslationConfigured: true };
  const serverMode = { translationModel: "9b-q4km", asrModel: "large-v3-turbo", translationMode: "server" };

  // api + key: ASR only, and a second click while it runs is refused.
  const [first, second] = await Promise.all([start(apiMode), start(apiMode)]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const accepted = first.status === 200 ? first : second;
  const refused = first.status === 200 ? second : first;
  assert.equal(refused.json.errorCode, "server_job_busy");
  assert.deepEqual(refused.json.errorParams, ["starting"]);
  assert.equal(accepted.json.job.state, "starting");
  assert.equal(accepted.json.job.translationMode, "asr-only");
  assert.equal(accepted.json.job.message, "正在启动 ASR large-v3-turbo（API 翻译，不启动本地翻译模型）");
  assert.equal(accepted.json.job.messageKey, "server_job_starting_asr_only");
  assert.deepEqual(accepted.json.job.messageParams, ["large-v3-turbo"]);
  let status = await finished(ctx);
  assert.equal(status.job.message, "本地服务已就绪");
  assert.equal(status.job.messageKey, "server_job_ready");
  assert.deepEqual(status.job.messageParams, []);
  assert.equal(status.services.asr.online, true);
  assert.equal(status.services.translation.online, false);
  assert.equal(ctx.llamaRecords().length, 0);
  assert.ok(!ctx.wlkRecords()[0].argv.includes("--target-language"));
  const asrOnlyPid = readPidFile(ctx.runtime, "wlk").pid;

  // server mode: the local model starts and WLK restarts to translate.
  const serverStart = await start({ ...serverMode, glossary: "Chaos Orb -> 混沌石" });
  assert.equal(serverStart.status, 200);
  assert.equal(serverStart.json.job.messageKey, "server_job_starting");
  assert.deepEqual(serverStart.json.job.messageParams, ["Index-Translate-9B Q4_K_M", "large-v3-turbo"]);
  status = await finished(ctx);
  assert.equal(status.services.translation.online, true);
  assert.equal(status.services.translation.model, "Index-Translate-9B");
  assert.equal(status.active.translation, "9b-q4km");
  const translatingPid = readPidFile(ctx.runtime, "wlk").pid;
  assert.notEqual(translatingPid, asrOnlyPid);
  assert.equal(isPidAlive(asrOnlyPid), false);
  let wlk = ctx.currentWlk();
  assert.equal(wlk.argv[wlk.argv.indexOf("--openai-translation-glossary") + 1], "Chaos Orb -> 混沌石");
  assert.equal(wlk.argv[wlk.argv.indexOf("--openai-translation-model") + 1], "Index-Translate-9B");

  // Same glossary: nothing restarts.
  assert.equal((await start({ ...serverMode, glossary: "Chaos Orb -> 混沌石" })).status, 200);
  await finished(ctx);
  assert.equal(readPidFile(ctx.runtime, "wlk").pid, translatingPid);
  const llamaPid = readPidFile(ctx.runtime, "llama-server").pid;

  // New glossary (control characters stripped): WLK restarts. Like
  // Start-Services.ps1 -Restart, the restart stops both services first.
  assert.equal((await start({ ...serverMode, glossary: "Divine Orb -> 神圣石\n" })).status, 200);
  await finished(ctx);
  const regloss = readPidFile(ctx.runtime, "wlk").pid;
  assert.notEqual(regloss, translatingPid);
  wlk = ctx.currentWlk();
  assert.equal(wlk.argv[wlk.argv.indexOf("--openai-translation-glossary") + 1], "Divine Orb -> 神圣石");
  assert.equal(isPidAlive(llamaPid), false);
  const relaunchedLlama = readPidFile(ctx.runtime, "llama-server").pid;

  // Back to api + key: the local model is stopped to free VRAM.
  assert.equal((await start(apiMode)).status, 200);
  status = await finished(ctx);
  assert.equal(status.services.translation.online, false);
  assert.equal(await isPortListening(ctx.ports.translation), false);
  assert.equal(isPidAlive(relaunchedLlama), false);
  assert.ok(status.logTail.some((line) => line.includes("API 翻译模式")));

  const stopped = await ctx.call({ method: "POST", path: "/stop", headers: EXT });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.job.state, "idle");
  assert.equal(stopped.json.job.message, "已停止");
  assert.equal(stopped.json.job.messageKey, "server_job_stopped");
  assert.equal(await isPortListening(ctx.ports.asr), false);
  assert.equal(readPidFile(ctx.runtime, "wlk"), null);
});

test("stop cancels a start that is still waiting for health", async (t) => {
  const ctx = await launch(t, { env: { SHENGMU_STUB_WLK_HEALTH_DELAY_MS: "60000" } });
  const start = await ctx.call({
    method: "POST",
    path: "/start",
    headers: EXT,
    body: { asrModel: "medium", translationMode: "api", apiTranslationConfigured: true }
  });
  assert.equal(start.status, 200);
  await waitFor(async () => readPidFile(ctx.runtime, "wlk"), "WLK spawn");
  const wlkPid = readPidFile(ctx.runtime, "wlk").pid;

  const stopped = await ctx.call({ method: "POST", path: "/stop", headers: EXT });
  assert.equal(stopped.json.ok, true);
  assert.equal(stopped.json.job.state, "idle");
  assert.equal(isPidAlive(wlkPid), false);
  await delay(400);
  const status = await ctx.call({ path: "/status" });
  assert.equal(status.json.job.state, "idle");
  assert.equal(status.json.services.asr.online, false);
  assert.equal(await isPortListening(ctx.ports.asr), false);
  assert.ok(status.json.logTail.some((line) => line.includes("取消进行中的启动任务")));
});

test("a failing launch surfaces as a job error with the reason", async (t) => {
  const ctx = await launch(t, { env: { SHENGMU_STUB_WLK_FAIL: "1" } });
  await ctx.call({ method: "POST", path: "/start", body: { asrModel: "medium", translationMode: "api", apiTranslationConfigured: true } });
  const status = await waitFor(async () => {
    const { json } = await ctx.call({ path: "/status" });
    return json.job.state === "error" ? json : null;
  }, "job error");
  assert.match(status.job.message, /^启动失败：WhisperLiveKit did not become ready .*exited with code 3/);
  assert.equal(status.job.messageKey, "server_job_start_failed");
  assert.equal(status.job.messageParams.length, 1);
  assert.equal(`启动失败：${status.job.messageParams[0]}`, status.job.message);
  assert.equal(status.job.exitCode, 1);
  assert.ok(status.logTail.some((line) => line.includes("failing on purpose")));
});

test("download resumes through fetch, guards concurrency and blocks stop", async (t) => {
  const payload = Buffer.alloc(256 * 1024, 3);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const hf = http.createServer(async (req, res) => {
    if (!req.url.endsWith("/IndexTeam/Index-Translate-2B-GGUF/resolve/main/Index-Translate-2B.IQ4_XS.gguf")) {
      res.writeHead(404);
      return res.end();
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": payload.length });
      return res.end();
    }
    res.writeHead(200, { "content-length": payload.length });
    res.write(payload.subarray(0, 1024));
    await gate;
    return res.end(payload.subarray(1024));
  });
  await new Promise((resolve) => {
    hf.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    hf.closeAllConnections();
    hf.close();
  });
  const ctx = await launch(t, { env: { HF_ENDPOINT: `http://127.0.0.1:${hf.address().port}` } });

  const begin = await ctx.call({ method: "POST", path: "/download", headers: EXT, body: { translationModel: "2b-iq4xs" } });
  assert.equal(begin.status, 200);
  assert.equal(begin.json.download.state, "downloading");
  assert.equal(begin.json.download.totalBytes, payload.length);
  assert.equal(begin.json.download.errorCode, "");
  const again = await ctx.call({ method: "POST", path: "/download", body: { translationModel: "2b-iq4xs" } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "正在下载 2b-iq4xs");
  assert.equal(again.json.errorCode, "server_download_busy_model");
  assert.deepEqual(again.json.errorParams, ["2b-iq4xs"]);
  const stop = await ctx.call({ method: "POST", path: "/stop" });
  assert.equal(stop.status, 409);
  assert.equal(stop.json.error, "模型下载中，请稍后再停止");
  assert.equal(stop.json.errorCode, "server_stop_blocked_by_download");

  release();
  const done = await waitFor(async () => {
    const { json } = await ctx.call({ path: "/status" });
    return json.download?.state === "done" ? json.download : null;
  }, "download");
  assert.equal(done.receivedBytes, payload.length);
  const models = await ctx.call({ path: "/models" });
  assert.equal(models.json.models.translation.find((entry) => entry.id === "2b-iq4xs").exists, true);
  const file = path.join(ctx.dir, "research", "models", MODEL_2B.subdir, MODEL_2B.file);
  assert.equal(fs.statSync(file).size, payload.length);
  assert.equal(fs.existsSync(`${file}.part`), false);

  const cached = await ctx.call({ method: "POST", path: "/download", body: { translationModel: "2b-iq4xs" } });
  assert.equal(cached.json.download.state, "done");
  const unknown = await ctx.call({ method: "POST", path: "/download", body: { translationModel: "x" } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.errorCode, "server_unknown_translation_model");
});

test("a short download reports the size mismatch as a coded error", async (t) => {
  const hf = http.createServer((req, res) => {
    // HEAD promises 2048 bytes, GET delivers 1024.
    res.writeHead(200, { "content-length": req.method === "HEAD" ? 2048 : 1024 });
    res.end(req.method === "HEAD" ? undefined : Buffer.alloc(1024, 1));
  });
  await new Promise((resolve) => {
    hf.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    hf.closeAllConnections();
    hf.close();
  });
  const ctx = await launch(t, { env: { HF_ENDPOINT: `http://127.0.0.1:${hf.address().port}` } });
  assert.equal((await ctx.call({ method: "POST", path: "/download", body: { translationModel: "2b-iq4xs" } })).status, 200);
  const failed = await waitFor(async () => {
    const { json } = await ctx.call({ path: "/status" });
    return json.download?.state === "error" ? json.download : null;
  }, "download error");
  assert.equal(failed.error, "下载大小不符（期望 2048，实际 1024）");
  assert.equal(failed.errorCode, "server_download_size_mismatch");
  assert.deepEqual(failed.errorParams, ["2048", "1024"]);
});
