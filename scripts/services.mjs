#!/usr/bin/env node
// Command line for the local services, replacing the PowerShell launchers:
//
//   start           Start-Services.ps1    WLK (8010) + llama-server (8013)
//   stop            Stop-Services.ps1     stop what start launched
//   status                                 ports, health and PIDs
//   serve           Start-LocalService.ps1 control service (8014) in the background
//   serve-stop      Stop-LocalService.ps1
//   download                               fetch a translation or whisper.cpp model
//   dev-browser     Start-DevBrowser.ps1   dev Chrome + unpacked extension
//   load-extension  Load-DevExtension.ps1
//
// Run `node scripts/services.mjs help` for the options.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_PORTS,
  REPO_ROOT,
  resolveConfig,
  resolveTranslationModel,
  translationModelPath,
  translationModelUrls,
  whisperCppModel
} from "./local-service/config.mjs";
import { configureProxyFromEnv, downloadToFile, fileSize, probeTotalBytes } from "./local-service/download.mjs";
import { fetchJson, isPidAlive, runQuiet, sleep, tailFile, windowsImageName } from "./local-service/processes.mjs";
import { createServiceManager } from "./local-service/service-manager.mjs";

const SERVER = path.join(REPO_ROOT, "scripts", "local-service", "server.mjs");

const USAGE = `Usage: node scripts/services.mjs <command> [options]   (pnpm services <command> ...)

  start      [--asr-only] [--restart] [--translation-model 9b-q4km|2b-iq4xs]
             [--translation-model-path FILE] [--asr-model large-v3-turbo|medium|small|base]
             [--asr-backend faster-whisper|mlx-whisper|whisper-cpp] [--glossary TEXT]
             [--translate-on-complete] [--pause-segmentation-seconds 1.0]
             [--translation-max-segment-seconds 2.5] [--wlk-port 8010] [--translation-port 8013]
  stop       [--wlk-port 8010] [--translation-port 8013]
  status     [--wlk-port 8010] [--translation-port 8013] [--port 8014]
  serve      [--port 8014] [--foreground]
  serve-stop [--port 8014]
  download   --translation-model ID | --asr-model ID   (the latter: whisper.cpp ggml file)
  dev-browser    [--port 9223] [--profile-dir DIR] [--url URL] [--extension-path DIR]
  load-extension [--port 9223] [--extension-path DIR]

Environment overrides (read by resolveConfig in scripts/local-service/config.mjs):
  SHENGMU_RESEARCH_DIR, SHENGMU_LOGS_DIR, SHENGMU_RUNTIME_DIR, SHENGMU_WLK_WORKDIR,
  SHENGMU_WHISPER_CPP_MODELS_DIR, SHENGMU_ASR_BACKEND, SHENGMU_{ASR,WHISPER_CPP,TRANSLATION}_PORT,
  SHENGMU_{WLK,LLAMA,WHISPER_CPP}_COMMAND, SHENGMU_{WLK,LLAMA,WHISPER_CPP}_SERVER,
  SHENGMU_LLAMA_EXTRA_ARGS, SHENGMU_HEALTH_POLL_MS`;

const OPTIONS = {
  "asr-only": { type: "boolean" },
  restart: { type: "boolean" },
  "translation-model": { type: "string" },
  "translation-model-path": { type: "string" },
  "asr-model": { type: "string" },
  "asr-backend": { type: "string" },
  glossary: { type: "string" },
  "translate-on-complete": { type: "boolean" },
  "pause-segmentation-seconds": { type: "string" },
  "translation-max-segment-seconds": { type: "string" },
  "wlk-port": { type: "string" },
  "translation-port": { type: "string" },
  port: { type: "string" },
  foreground: { type: "boolean" },
  "profile-dir": { type: "string" },
  url: { type: "string" },
  "extension-path": { type: "string" },
  help: { type: "boolean", short: "h" }
};

function print(record) {
  for (const [key, value] of Object.entries(record)) {
    console.log(`${key.padEnd(22)}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : value}`);
  }
}

function numberOption(value, name) {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

// CLI flags win over the environment for this one invocation.
function serviceEnv(values) {
  const env = { ...process.env };
  if (values["wlk-port"]) env.SHENGMU_ASR_PORT = String(numberOption(values["wlk-port"], "wlk-port"));
  if (values["translation-port"]) {
    env.SHENGMU_TRANSLATION_PORT = String(numberOption(values["translation-port"], "translation-port"));
  }
  if (values["asr-backend"]) env.SHENGMU_ASR_BACKEND = values["asr-backend"];
  return env;
}

function controlPort(values) {
  return numberOption(values.port, "port") ?? Number(process.env.SHENGMU_LOCAL_SERVICE_PORT || DEFAULT_PORTS.control);
}

function makeManager(values) {
  const env = serviceEnv(values);
  return createServiceManager({ env, config: resolveConfig({ env }), log: (line) => console.log(line) });
}

async function commandStart(values) {
  const manager = makeManager(values);
  const controller = new AbortController();
  const onInterrupt = () => {
    console.error("Interrupted; run `pnpm services:stop` to stop anything already started.");
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  try {
    const summary = await manager.start(
      {
        asrOnly: Boolean(values["asr-only"]),
        restart: Boolean(values.restart),
        translationModel: values["translation-model"],
        translationModelPath: values["translation-model-path"],
        asrModel: values["asr-model"],
        glossary: values.glossary,
        translateOnComplete: Boolean(values["translate-on-complete"]),
        pauseSegmentationSeconds: numberOption(values["pause-segmentation-seconds"], "pause-segmentation-seconds"),
        translationMaxSegmentSeconds: numberOption(values["translation-max-segment-seconds"], "translation-max-segment-seconds")
      },
      { signal: controller.signal }
    );
    print(summary);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

async function commandStop(values) {
  const result = await makeManager(values).stop();
  print({
    stopped: result.stopped.map((entry) => `${entry.service}:${entry.pid}`).join(", ") || "(nothing)",
    warnings: result.warnings.length
  });
}

async function controlHealth(port) {
  const health = await fetchJson(`http://127.0.0.1:${port}/health`, 2000);
  return health.ok && health.body?.service === "shengmu-local" ? health.body : null;
}

async function commandStatus(values) {
  const status = await makeManager(values).status();
  const port = controlPort(values);
  print({ ...status, control: { port, online: Boolean(await controlHealth(port)) } });
}

function serverPidFile() {
  return process.env.SHENGMU_LOCAL_SERVICE_PID_FILE || path.join(REPO_ROOT, "scripts", "local-service", "server.pid");
}

async function commandServe(values) {
  const port = controlPort(values);
  if (values.foreground) {
    process.env.SHENGMU_LOCAL_SERVICE_PORT = String(port);
    await import("./local-service/server.mjs");
    return;
  }
  if (await controlHealth(port)) {
    print({ status: "running", port, url: `http://127.0.0.1:${port}` });
    return;
  }
  const { logsDir } = resolveConfig();
  fs.mkdirSync(logsDir, { recursive: true });
  const stderrLog = path.join(logsDir, "local-service.stderr.log");
  const out = fs.openSync(path.join(logsDir, "local-service.stdout.log"), "w");
  const err = fs.openSync(stderrLog, "w");
  let child;
  try {
    child = spawn(process.execPath, [SERVER], {
      cwd: path.dirname(SERVER),
      env: { ...process.env, SHENGMU_LOCAL_SERVICE_PORT: String(port) },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err]
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (!exited && Date.now() < deadline && !(await controlHealth(port))) await sleep(400);
  if (!(await controlHealth(port))) {
    tailFile(stderrLog, 40).forEach((line) => console.error(line));
    throw new Error(`Local control service did not become ready on port ${port}.`);
  }
  print({ status: "started", port, pid: child.pid, url: `http://127.0.0.1:${port}` });
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid) && Date.now() < deadline) await sleep(100);
  return !isPidAlive(pid);
}

async function commandServeStop(values) {
  const pidFile = serverPidFile();
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile, "ascii").trim());
  } catch {
    pid = 0;
  }
  if (!pid || !isPidAlive(pid)) {
    // A stale file from a crashed service; this is the one place it is cleared.
    fs.rmSync(pidFile, { force: true });
    print({ service: "local-control", stopped: "(not running)" });
    return;
  }
  // A live PID that does not answer as the control service may have been
  // reused by another program after a crash, so it is not killed blindly.
  const port = controlPort(values);
  if (!(await controlHealth(port))) {
    throw new Error(`PID ${pid} from ${pidFile} is alive but no control service answers on port ${port}; not killing it.`);
  }
  if (process.platform === "win32") {
    if ((await windowsImageName(pid)) !== "node.exe") throw new Error(`PID ${pid} is not node.exe; not killing it.`);
    // No /T: the model services must keep running, as they did when
    // Stop-LocalService.ps1 stopped only node.exe.
    await runQuiet("taskkill", ["/PID", String(pid), "/F"]);
  } else {
    process.kill(pid, "SIGTERM");
  }
  if (!(await waitGone(pid, 5000))) {
    if (process.platform !== "win32") process.kill(pid, "SIGKILL");
    await waitGone(pid, 2000);
  }
  // SIGTERM lets server.mjs remove its own PID file; taskkill /F does not.
  fs.rmSync(pidFile, { force: true });
  print({ service: "local-control", stopped: pid });
}

async function commandDownload(values) {
  const proxy = configureProxyFromEnv();
  const config = resolveConfig({ env: serviceEnv(values) });
  let url;
  let target;
  if (values["translation-model"]) {
    const model = resolveTranslationModel(values["translation-model"]);
    if (!model) throw new Error(`Unknown translation model '${values["translation-model"]}'.`);
    url = translationModelUrls(config, model).downloadUrl;
    target = translationModelPath(config, model);
  } else if (values["asr-model"]) {
    const model = whisperCppModel(config, values["asr-model"]);
    if (!model.file) throw new Error(`Unknown ASR model '${values["asr-model"]}'.`);
    url = model.downloadUrl;
    target = model.path;
  } else {
    throw new Error("download needs --translation-model ID or --asr-model ID");
  }
  if (fs.existsSync(target)) {
    print({ status: "present", path: target, bytes: fileSize(target) });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  console.log(`Downloading ${url} (proxy ${proxy.enabled ? "from environment" : "off"})`);
  const totalBytes = await probeTotalBytes(url);
  const timer = setInterval(() => {
    const received = fileSize(`${target}.part`);
    const percent = totalBytes ? ` (${((received / totalBytes) * 100).toFixed(1)}%)` : "";
    console.log(`  ${received} / ${totalBytes || "?"} bytes${percent}`);
  }, 2000);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  try {
    const result = await downloadToFile({ url, targetPath: target, totalBytes, signal: controller.signal });
    print({ status: "downloaded", path: target, bytes: result.bytes });
  } finally {
    clearInterval(timer);
  }
}

async function commandDevBrowser(values, { loadOnly = false } = {}) {
  const { loadDevExtension, startDevBrowser } = await import("./dev-browser.mjs");
  const port = numberOption(values.port, "port") ?? 9223;
  if (loadOnly) {
    print({ extension: await loadDevExtension({ port, extensionPath: values["extension-path"] }) });
    return;
  }
  print(
    await startDevBrowser({
      port,
      profileDir: values["profile-dir"],
      url: values.url,
      extensionPath: values["extension-path"],
      log: (line) => console.log(line)
    })
  );
}

const COMMANDS = {
  start: commandStart,
  stop: commandStop,
  status: commandStatus,
  serve: commandServe,
  "serve-stop": commandServeStop,
  download: commandDownload,
  "dev-browser": (values) => commandDevBrowser(values),
  "load-extension": (values) => commandDevBrowser(values, { loadOnly: true })
};

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [name] = positionals;
  if (!name || name === "help" || values.help || !COMMANDS[name]) {
    console.log(USAGE);
    return name && name !== "help" && !COMMANDS[name] ? 2 : 0;
  }
  await COMMANDS[name](values);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code) process.exitCode = code;
  },
  (error) => {
    console.error(error?.name === "AbortError" ? "Aborted." : `Error: ${error?.message || error}`);
    process.exitCode = 1;
  }
);
