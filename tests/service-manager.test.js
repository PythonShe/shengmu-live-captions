import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LOCAL_ASR_MODELS, LOCAL_TRANSLATION_MODELS } from "../extension/lib/caption-utils.js";
import {
  ASR_MODELS,
  TRANSLATION_MODELS,
  WHISPER_CPP_PLACEHOLDER_KEY,
  buildLlamaArgs,
  buildWhisperCppArgs,
  buildWlkArgs,
  buildWlkEnv,
  llamaServerCandidates,
  resolveConfig,
  resolveServiceCommand,
  wlkServerPath
} from "../scripts/local-service/config.mjs";
import {
  isPidAlive,
  isPortListening,
  killServiceTree,
  parseTasklistImage,
  readPidFile,
  windowsKillCommand
} from "../scripts/local-service/processes.mjs";
import { createServiceManager } from "../scripts/local-service/service-manager.mjs";

const STUB = fileURLToPath(new URL("./fixtures/stub-service.js", import.meta.url));

// ---- pure configuration -------------------------------------------------

test("model tiers stay in lockstep with the extension settings", () => {
  assert.deepEqual(TRANSLATION_MODELS.map((model) => model.id), [...LOCAL_TRANSLATION_MODELS]);
  assert.deepEqual(ASR_MODELS.map((model) => model.id), [...LOCAL_ASR_MODELS]);
});

test("the per-OS table picks the venv layout and the ASR backend", () => {
  const win = resolveConfig({ platform: "win32", root: "C:\\repo", env: {} });
  assert.equal(wlkServerPath(win), "C:\\repo\\.research\\wlk-venv\\Scripts\\whisperlivekit-server.exe");
  assert.equal(win.asrBackend, "faster-whisper");
  assert.equal(win.runtimeDir, "C:\\repo\\.runtime");
  assert.equal(win.logsDir, "C:\\repo\\logs");

  const mac = resolveConfig({ platform: "darwin", root: "/repo", env: { HOME: "/Users/me" } });
  assert.equal(wlkServerPath(mac), "/repo/.research/wlk-venv/bin/whisperlivekit-server");
  assert.equal(mac.asrBackend, "whisper-cpp");
  assert.equal(mac.hfCacheDir, "/Users/me/.cache/huggingface/hub");

  const linux = resolveConfig({ platform: "linux", root: "/repo", env: {} });
  assert.equal(linux.asrBackend, "faster-whisper");
  assert.deepEqual(linux.ports, { asr: 8010, whisperCpp: 8011, translation: 8013 });

  assert.equal(resolveConfig({ platform: "darwin", root: "/r", env: { SHENGMU_ASR_BACKEND: "mlx-whisper" } }).asrBackend, "mlx-whisper");
  assert.throws(() => resolveConfig({ platform: "linux", root: "/r", env: { SHENGMU_ASR_BACKEND: "vosk" } }), /Unknown ASR backend/);
  assert.throws(() => resolveConfig({ platform: "linux", root: "/r", env: { SHENGMU_WLK_COMMAND: "wlk --x" } }), /JSON array/);
});

test("llama-server is looked up in the newest llama.cpp folder first", () => {
  const config = resolveConfig({ platform: "win32", root: "C:\\repo", env: {} });
  const candidates = llamaServerCandidates(config, () => ["llama.cpp-b9000", "llama.cpp-b11808", "WhisperLiveKit"]);
  assert.equal(candidates[0], "C:\\repo\\.research\\llama.cpp-b11808\\llama-server.exe");
  assert.ok(candidates.includes("C:\\repo\\.research\\llama.cpp-b9000\\build\\bin\\Release\\llama-server.exe"));
  assert.ok(!candidates.some((item) => item.includes("WhisperLiveKit")));
});

test("service commands resolve from JSON, an explicit path, the defaults, then PATH", () => {
  const base = { platform: "linux", root: "/repo" };
  const json = resolveConfig({ ...base, env: { SHENGMU_WLK_COMMAND: '["/bin/node","stub.js","wlk"]' } });
  assert.deepEqual(resolveServiceCommand(json, "wlk", { exists: () => false }), {
    command: "/bin/node",
    args: ["stub.js", "wlk"],
    found: true,
    tried: ["/bin/node"]
  });
  const explicit = resolveConfig({ ...base, env: { SHENGMU_LLAMA_SERVER: "/opt/llama-server" } });
  assert.equal(resolveServiceCommand(explicit, "llama", { exists: () => false }).found, false);

  const config = resolveConfig({ ...base, env: {} });
  const viaPath = resolveServiceCommand(config, "whisperCpp", {
    env: { PATH: "/usr/local/bin:/opt/homebrew/bin" },
    exists: (file) => file === "/opt/homebrew/bin/whisper-server"
  });
  assert.equal(viaPath.command, "/opt/homebrew/bin/whisper-server");
  const missing = resolveServiceCommand(config, "wlk", { env: { PATH: "" }, exists: () => false });
  assert.equal(missing.found, false);
  assert.match(missing.tried.join(" "), /wlk-venv\/bin\/whisperlivekit-server/);
});

test("WhisperLiveKit gets exactly the flags Start-Services.ps1 passed", () => {
  const common = [
    "--host", "127.0.0.1", "--port", "8010", "--backend", "faster-whisper", "--model", "large-v3-turbo",
    "--lan", "en", "--pause-segmentation-seconds", "1", "--pcm-input", "--backend-policy", "localagreement",
    "--asr-coalesce-min-s", "0.5", "--localagreement-beam-size", "3", "--retention-seconds", "300",
    "--buffer_trimming", "segment", "--buffer_trimming_sec", "10", "--confidence-validation", "--log-level", "INFO"
  ];
  assert.deepEqual(buildWlkArgs({ port: 8010, asrModel: "large-v3-turbo", asrOnly: true, glossary: "A -> 甲" }), common);
  assert.deepEqual(
    buildWlkArgs({
      port: 8010,
      asrModel: "large-v3-turbo",
      translationPort: 8013,
      translationAlias: "Index-Translate-9B",
      glossary: "Chaos Orb -> 混沌石; Divine Orb -> 神圣石",
      translateOnComplete: true
    }),
    [
      ...common,
      "--target-language", "zh", "--translation-backend", "openai",
      "--openai-translation-url", "http://127.0.0.1:8013/v1",
      "--openai-translation-model", "Index-Translate-9B",
      "--openai-translation-max-tokens", "768", "--openai-translation-max-segment-seconds", "2.5",
      "--translate-on-complete",
      "--openai-translation-glossary", "Chaos Orb -> 混沌石; Divine Orb -> 神圣石"
    ]
  );
  const bridged = buildWlkArgs({ port: 8010, asrBackend: "whisper-cpp", asrModel: "medium", asrOnly: true });
  assert.equal(bridged[bridged.indexOf("--backend") + 1], "openai-api");
  const mlx = buildWlkArgs({ port: 8010, asrBackend: "mlx-whisper", asrModel: "medium", asrOnly: true });
  assert.equal(mlx[mlx.indexOf("--backend") + 1], "mlx-whisper");
});

test("WLK environment disables Xet unless the caller chose, and bridges whisper.cpp", () => {
  assert.equal(buildWlkEnv({}, { asrBackend: "faster-whisper" }).HF_HUB_DISABLE_XET, "1");
  assert.equal(buildWlkEnv({ HF_HUB_DISABLE_XET: "0" }, { asrBackend: "faster-whisper" }).HF_HUB_DISABLE_XET, "0");
  assert.equal(buildWlkEnv({}, { asrBackend: "faster-whisper" }).OPENAI_BASE_URL, undefined);
  const bridged = buildWlkEnv({ OPENAI_API_KEY: "sk-real" }, { asrBackend: "whisper-cpp", whisperCppPort: 8011 });
  assert.equal(bridged.OPENAI_BASE_URL, "http://127.0.0.1:8011/v1");
  assert.equal(bridged.OPENAI_API_KEY, WHISPER_CPP_PLACEHOLDER_KEY);
});

test("llama-server and whisper-server command lines", () => {
  assert.deepEqual(buildLlamaArgs({ port: 8013, alias: "Index-Translate-2B", modelPath: "/m/2b.gguf", extraArgs: ["-fa", "on"] }), [
    "-m", "/m/2b.gguf", "--alias", "Index-Translate-2B", "--host", "127.0.0.1", "--port", "8013", "-c", "2048", "-ngl", "999", "-fa", "on"
  ]);
  assert.deepEqual(buildWhisperCppArgs({ port: 8011, modelPath: "/m/ggml-medium.bin" }), [
    "-m", "/m/ggml-medium.bin", "--host", "127.0.0.1", "--port", "8011", "--inference-path", "/v1/audio/transcriptions", "-l", "en"
  ]);
  assert.deepEqual(
    resolveConfig({ platform: "linux", root: "/r", env: { SHENGMU_LLAMA_EXTRA_ARGS: '["--jinja"]' } }).llamaExtraArgs,
    ["--jinja"]
  );
});

test("windows kills the whole tree and reads image names from tasklist", () => {
  assert.deepEqual(windowsKillCommand(4242), { command: "taskkill", args: ["/PID", "4242", "/T", "/F"] });
  const csv = '"whisperlivekit-server.exe","4242","Console","1","12,345 K"\r\n';
  assert.equal(parseTasklistImage(csv, 4242), "whisperlivekit-server.exe");
  assert.equal(parseTasklistImage("INFO: No tasks are running which match the specified criteria.\r\n", 4242), "");
});

// ---- the manager against stub executables -------------------------------

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

function stubCommand(kind) {
  return JSON.stringify([process.execPath, STUB, kind]);
}

function readRecords(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${kind}-`))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

const FAST = {
  translationHealthMs: 8000,
  existingWlkHealthMs: 3000,
  wlkHealthMs: 8000,
  whisperCppReadyMs: 8000,
  stopGraceMs: 3000,
  portSettleMs: 50
};

async function harness(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shengmu-manager-"));
  const research = path.join(dir, "research");
  const records = path.join(dir, "records");
  const ports = { asr: await freePort(), translation: await freePort(), whisperCpp: await freePort() };
  const inherited = { ...process.env };
  delete inherited.HF_HUB_DISABLE_XET;
  const env = {
    ...inherited,
    SHENGMU_RESEARCH_DIR: research,
    SHENGMU_LOGS_DIR: path.join(dir, "logs"),
    SHENGMU_RUNTIME_DIR: path.join(dir, "runtime"),
    SHENGMU_ASR_PORT: String(ports.asr),
    SHENGMU_TRANSLATION_PORT: String(ports.translation),
    SHENGMU_WHISPER_CPP_PORT: String(ports.whisperCpp),
    SHENGMU_WLK_COMMAND: stubCommand("wlk"),
    SHENGMU_LLAMA_COMMAND: stubCommand("llama"),
    SHENGMU_WHISPER_CPP_COMMAND: stubCommand("whisper"),
    SHENGMU_ASR_BACKEND: "faster-whisper",
    SHENGMU_HEALTH_POLL_MS: "50",
    SHENGMU_STUB_RECORD_DIR: records,
    ...extraEnv
  };
  const model = TRANSLATION_MODELS[0];
  fs.mkdirSync(path.join(research, "models", model.subdir), { recursive: true });
  fs.writeFileSync(path.join(research, "models", model.subdir, model.file), "gguf");
  const lines = [];
  const manager = createServiceManager({ env, log: (line) => lines.push(line), timeouts: FAST });
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, env, ports, records, lines, manager, runtime: env.SHENGMU_RUNTIME_DIR };
}

test("start launches llama-server then WhisperLiveKit, stop kills both by PID", async (t) => {
  const h = await harness(t);
  const summary = await h.manager.start({ asrModel: "medium", translationModel: "9b-q4km", glossary: "Orb -> 石" });
  assert.equal(summary.translation, "started");
  assert.equal(summary.wlk, "started");
  assert.equal(summary.translationModel, "Index-Translate-9B");

  const [llama] = readRecords(h.records, "llama");
  assert.deepEqual(llama.argv.slice(0, 10), [
    "-m", path.join(h.env.SHENGMU_RESEARCH_DIR, "models", "index-translate-9b", "Index-Translate-9B.Q4_K_M.gguf"),
    "--alias", "Index-Translate-9B", "--host", "127.0.0.1", "--port", String(h.ports.translation), "-c", "2048"
  ]);
  const [wlk] = readRecords(h.records, "wlk");
  assert.equal(wlk.env.HF_HUB_DISABLE_XET, "1");
  assert.equal(wlk.env.OPENAI_BASE_URL, null);
  assert.deepEqual(
    wlk.argv,
    buildWlkArgs({
      port: h.ports.asr,
      asrModel: "medium",
      translationPort: h.ports.translation,
      translationAlias: "Index-Translate-9B",
      glossary: "Orb -> 石"
    })
  );

  const wlkPid = readPidFile(h.runtime, "wlk").pid;
  const llamaPid = readPidFile(h.runtime, "llama-server").pid;
  assert.ok(fs.existsSync(path.join(h.env.SHENGMU_LOGS_DIR, "wlk.stdout.log")));
  const status = await h.manager.status();
  assert.equal(status.asr.healthy, true);
  assert.equal(status.asr.pid, wlkPid);
  assert.equal(status.translation.pid, llamaPid);

  const stopped = await h.manager.stop();
  assert.deepEqual(stopped.stopped.map((entry) => entry.service).sort(), ["llama-server", "wlk"]);
  assert.deepEqual(stopped.warnings, []);
  assert.equal(isPidAlive(wlkPid), false);
  assert.equal(isPidAlive(llamaPid), false);
  assert.equal(await isPortListening(h.ports.asr), false);
  assert.equal(readPidFile(h.runtime, "wlk"), null);
});

test("asr-only skips the translation model and warns about a foreign 8013 listener", async (t) => {
  const h = await harness(t, { HF_HUB_DISABLE_XET: "0" });
  const foreign = net.createServer();
  await new Promise((resolve) => {
    foreign.listen(h.ports.translation, "127.0.0.1", resolve);
  });
  t.after(() => foreign.close());

  const summary = await h.manager.start({ asrOnly: true });
  assert.equal(summary.translation, "skipped");
  assert.equal(summary.translationPort, "disabled");
  assert.equal(readRecords(h.records, "llama").length, 0);
  const [wlk] = readRecords(h.records, "wlk");
  assert.ok(!wlk.argv.includes("--target-language"));
  assert.equal(wlk.env.HF_HUB_DISABLE_XET, "0");
  assert.ok(h.lines.some((line) => /still serving a translation model/.test(line)));

  const stopped = await h.manager.stop();
  assert.deepEqual(stopped.stopped.map((entry) => entry.service), ["wlk"]);
  assert.match(stopped.warnings.join("\n"), new RegExp(`Port ${h.ports.translation} is still listening`));
  assert.equal(await isPortListening(h.ports.translation), true);
});

test("a running WhisperLiveKit refuses asr-only until restart replaces it", async (t) => {
  const h = await harness(t);
  await h.manager.start({ asrOnly: true });
  const first = readPidFile(h.runtime, "wlk").pid;
  await assert.rejects(h.manager.start({ asrOnly: true }), /already running .* Use --restart/);
  assert.equal(readPidFile(h.runtime, "wlk").pid, first);

  await h.manager.start({ asrOnly: true, restart: true });
  const second = readPidFile(h.runtime, "wlk").pid;
  assert.notEqual(second, first);
  assert.equal(isPidAlive(first), false);
});

test("an 8013 server with another model is not taken over", async (t) => {
  const h = await harness(t);
  const other = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "Other-Model" }] } : { status: "ok" }));
  });
  await new Promise((resolve) => {
    other.listen(h.ports.translation, "127.0.0.1", resolve);
  });
  t.after(() => other.close());
  await assert.rejects(h.manager.start({}), /does not expose Index-Translate-9B.*serving: Other-Model/);
  assert.equal(readRecords(h.records, "wlk").length, 0);
});

test("missing model files and launchers fail before anything starts", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.manager.start({ translationModel: "2b-iq4xs" }), /Translation model file not found: .*Index-Translate-2B/);
  await assert.rejects(h.manager.start({ translationModel: "nope" }), /Unknown translation model 'nope'/);
  await assert.rejects(h.manager.start({ asrOnly: true, asrModel: "tiny" }), /Unknown ASR model 'tiny'/);

  const env = { ...h.env, SHENGMU_WLK_COMMAND: "", SHENGMU_WLK_SERVER: path.join(h.dir, "missing-wlk") };
  const manager = createServiceManager({ env, timeouts: FAST });
  await assert.rejects(manager.start({ asrOnly: true }), /WhisperLiveKit launcher not found. Looked for: .*missing-wlk/);
  assert.equal(readRecords(h.records, "wlk").length, 0);
});

test("a WhisperLiveKit that exits early fails fast with its stderr", async (t) => {
  const h = await harness(t, { SHENGMU_STUB_WLK_FAIL: "1" });
  const startedAt = Date.now();
  await assert.rejects(h.manager.start({ asrOnly: true }), /WhisperLiveKit did not become ready on port \d+ \(exited with code 3\)/);
  assert.ok(Date.now() - startedAt < 5000);
  assert.ok(h.lines.some((line) => line.includes("failing on purpose")));
});

test("aborting a start stops the waits and spawns nothing further", async (t) => {
  const h = await harness(t, { SHENGMU_STUB_LLAMA_HEALTH_DELAY_MS: "60000" });
  const controller = new AbortController();
  const run = h.manager.start({}, { signal: controller.signal });
  const deadline = Date.now() + 5000;
  while (!readPidFile(h.runtime, "llama-server") && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  assert.ok(readPidFile(h.runtime, "llama-server"), "llama-server was spawned");
  const abortedAt = Date.now();
  controller.abort();
  await assert.rejects(run, { name: "AbortError" });
  assert.ok(Date.now() - abortedAt < 1000);
  assert.equal(readRecords(h.records, "wlk").length, 0);
  const stopped = await h.manager.stop();
  assert.deepEqual(stopped.stopped.map((entry) => entry.service), ["llama-server"]);
});

test("the whisper.cpp backend downloads its ggml model and bridges WLK to it", async (t) => {
  const payload = Buffer.alloc(4096, 7);
  const hf = http.createServer((req, res) => {
    if (req.url !== "/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin") {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-length": payload.length });
    return res.end(req.method === "HEAD" ? undefined : payload);
  });
  await new Promise((resolve) => {
    hf.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => hf.close());
  const h = await harness(t, {
    SHENGMU_ASR_BACKEND: "whisper-cpp",
    HF_ENDPOINT: `http://127.0.0.1:${hf.address().port}`
  });
  await h.manager.start({ asrOnly: true, asrModel: "medium" });

  const ggml = path.join(h.env.SHENGMU_RESEARCH_DIR, "models", "whisper.cpp", "ggml-medium.bin");
  assert.equal(fs.statSync(ggml).size, payload.length);
  const [whisper] = readRecords(h.records, "whisper");
  assert.deepEqual(whisper.argv, buildWhisperCppArgs({ port: h.ports.whisperCpp, modelPath: ggml }));
  const [wlk] = readRecords(h.records, "wlk");
  assert.equal(wlk.argv[wlk.argv.indexOf("--backend") + 1], "openai-api");
  assert.equal(wlk.env.OPENAI_BASE_URL, `http://127.0.0.1:${h.ports.whisperCpp}/v1`);
  assert.equal(wlk.env.OPENAI_API_KEY, WHISPER_CPP_PLACEHOLDER_KEY);
  assert.equal((await h.manager.status()).whisperCpp.listening, true);

  const stopped = await h.manager.stop();
  assert.deepEqual(stopped.stopped.map((entry) => entry.service), ["wlk", "whisper-cpp"]);
  assert.equal(await isPortListening(h.ports.whisperCpp), false);
});

test("stop drops PID files of dead processes and never kills a reused PID", async (t) => {
  const h = await harness(t);
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => {
    dead.on("exit", resolve);
  });
  fs.mkdirSync(h.runtime, { recursive: true });
  fs.writeFileSync(path.join(h.runtime, "wlk.pid"), JSON.stringify({ pid: dead.pid, image: "node" }));
  const result = await h.manager.stop();
  assert.deepEqual(result.stopped, []);
  assert.equal(readPidFile(h.runtime, "wlk"), null);

  // A live process that is not ours: on POSIX it does not lead a process
  // group, on Windows its image name does not match the record.
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => bystander.kill());
  await new Promise((resolve) => {
    bystander.once("spawn", resolve);
  });
  const outcome = await killServiceTree(
    { pid: bystander.pid, image: "whisperlivekit-server.exe" },
    { platform: process.platform, graceMs: 200 }
  );
  assert.equal(outcome, "foreign");
  assert.equal(isPidAlive(bystander.pid), true);
});
