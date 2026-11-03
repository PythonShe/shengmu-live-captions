#!/usr/bin/env node
/**
 * 声幕本地控制服务 (127.0.0.1:8014)
 *
 * 扩展页面（popup）不能直接创建本地进程，所以由这个常驻小服务代劳：
 *   GET  /health    存活探测
 *   GET  /status    ASR / 翻译服务在线状态 + 启动任务进度 + 下载进度
 *   GET  /models    本地模型档位（是否已下载、下载链接）
 *   POST /start     一键拉起 WhisperLiveKit + llama.cpp（可选翻译模型与 ASR 尺寸）
 *   POST /stop      停止本项目自己的两个服务
 *   POST /download  下载所选翻译模型的 GGUF（fetch 断点续传，带进度）
 *
 * 只绑定回环地址，并且只接受来自 chrome-extension:// 页面的跨域请求。
 * 启停逻辑不在这里重复实现，统一交给同进程的 service-manager.mjs
 * （也是 scripts/services.mjs 命令行用的那一份）。
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASR_MODELS,
  DEFAULT_PORTS,
  TRANSLATION_MODELS,
  resolveConfig,
  resolveAsrModel,
  resolveTranslationModel,
  translationModelPath,
  translationModelUrls,
  whisperCppModel
} from "./config.mjs";
import {
  DownloadError,
  configureProxyFromEnv,
  discardStalePart,
  downloadToFile,
  fileSize,
  probeTotalBytes
} from "./download.mjs";
import { createServiceManager } from "./service-manager.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.SHENGMU_LOCAL_SERVICE_HOST || "127.0.0.1";
const REQUESTED_PORT = process.env.SHENGMU_LOCAL_SERVICE_PORT
  ? Number(process.env.SHENGMU_LOCAL_SERVICE_PORT)
  : DEFAULT_PORTS.control;
// Tests listen on port 0, so hostAllowed compares against the bound port.
let PORT = REQUESTED_PORT;
const PID_FILE = process.env.SHENGMU_LOCAL_SERVICE_PID_FILE || path.join(HERE, "server.pid");
const SERVICE_VERSION = "1.1.0";

// Must run before the first request: fetch only honors HTTP(S)_PROXY once the
// global dispatcher is configured.
const proxySetup = configureProxyFromEnv();
const CONFIG = resolveConfig();
const LOGS = CONFIG.logsDir;
const TRANSLATION_PORT = CONFIG.ports.translation;
const ASR_PORT = CONFIG.ports.asr;

const DOWNLOAD_POLL_MS = 700;
const MAX_WLK_GLOSSARY_CHARS = 4000;
const logTail = [];
let job = {
  state: "idle",
  action: "",
  ...jobText("", ""),
  startedAt: null,
  finishedAt: null,
  exitCode: null
};
// The in-flight start: its AbortController, and a promise that settles (never
// rejects) once the job state reflects the outcome.
let jobAbort = null;
let jobSettled = null;
// WhisperLiveKit has no endpoint that reports whether it translates or which
// glossary it was started with, so what we last started it with is the only
// reliable hint. null means unknown.
let startedWlkMode = null;
let startedGlossarySignature = null;
let download = null;
let downloadAbort = null;
// handleStart and startDownload await probes before they publish their busy
// state, so these flags close the window in which a second request (double
// click, two popups) would pass the 409 guard and spawn a second launcher.
let startPending = false;
let downloadPending = false;
// Bumped by /stop so a start that is still probing knows it was cancelled.
let stopGeneration = 0;

function sanitizeWlkGlossary(value) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex -- strip control characters before they reach a CLI argument
    .replace(/[\0-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WLK_GLOSSARY_CHARS);
}

// The popup renders errorCode / messageKey through chrome.i18n. `error` and
// `message` stay Chinese for scripts/services.mjs and extension builds that
// predate the keys. An empty code means the text is not ours to translate.
function errorFields(error, errorCode = "", ...errorParams) {
  return { error, errorCode, errorParams: errorParams.map(String) };
}

function failure(error, errorCode, ...errorParams) {
  return { ok: false, ...errorFields(error, errorCode, ...errorParams) };
}

function jobText(message, messageKey, ...messageParams) {
  return { message, messageKey, messageParams: messageParams.map(String) };
}

class RequestError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.errorCode = errorCode;
  }
}

function pushLog(line) {
  const text = String(line).trimEnd();
  if (!text) return;
  for (const part of text.split(/\r?\n/)) {
    if (!part.trim()) continue;
    logTail.push(part);
  }
  while (logTail.length > 40) logTail.shift();
}

function appendJobLog(lines) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(
      path.join(LOGS, "local-service-start.log"),
      lines.map((line) => `${new Date().toISOString()} ${line}`).join("\n") + "\n",
      "utf8"
    );
  } catch {
    // Logging must never break the control plane.
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new RequestError("请求体过大", "server_body_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new RequestError("请求体不是合法 JSON", "server_body_invalid_json");
  }
}

async function fetchWithTimeout(url, timeoutMs = 1600) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return response;
}

async function probeHealth(port) {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return { online: false, listening: true, detail: `HTTP ${response.status}` };
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { online: body?.status ? body.status === "ok" : true, listening: true, detail: "在线", body };
  } catch (error) {
    const message = error?.name === "TimeoutError" ? "健康检查超时" : "未连接";
    return { online: false, listening: false, detail: message };
  }
}

async function probeTranslationModelName() {
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${TRANSLATION_PORT}/v1/models`
    );
    if (!response.ok) return null;
    const body = await response.json();
    const ids = Array.isArray(body?.data)
      ? body.data.map((entry) => entry?.id).filter(Boolean)
      : [];
    return ids[0] || null;
  } catch {
    return null;
  }
}

async function probeServiceState() {
  const [asrHealth, translationHealth] = await Promise.all([
    probeHealth(ASR_PORT),
    probeHealth(TRANSLATION_PORT)
  ]);
  const translationModel = translationHealth.online
    ? await probeTranslationModelName()
    : null;
  const asrBody = asrHealth.body && typeof asrHealth.body === "object"
    ? Object.fromEntries(
        Object.entries(asrHealth.body).filter(([, value]) =>
          ["string", "number", "boolean"].includes(typeof value)
        )
      )
    : {};
  return {
    asr: {
      online: asrHealth.online,
      port: ASR_PORT,
      detail: asrHealth.detail,
      health: asrBody
    },
    translation: {
      online: translationHealth.online,
      port: TRANSLATION_PORT,
      detail: translationHealth.detail,
      model: translationModel
    }
  };
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// The weight file each backend leaves in a Hugging Face snapshot.
const HF_WEIGHT_FILES = {
  "faster-whisper": ["model.bin"],
  "mlx-whisper": ["weights.safetensors", "weights.npz"]
};

function asrCacheInfo(model) {
  if (CONFIG.asrBackend === "whisper-cpp") {
    return fileExists(whisperCppModel(CONFIG, model.id).path);
  }
  const repo = model.hfRepo[CONFIG.asrBackend];
  const weights = HF_WEIGHT_FILES[CONFIG.asrBackend] || [];
  if (!repo) return false;
  const repoDir = path.join(CONFIG.hfCacheDir, `models--${repo.replace("/", "--")}`);
  try {
    const snapshots = path.join(repoDir, "snapshots");
    const entries = fs.readdirSync(snapshots, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const snapshotDir = path.join(snapshots, entry.name);
      const files = fs.readdirSync(snapshotDir);
      if (weights.some((name) => files.includes(name))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function listModels() {
  return {
    translation: TRANSLATION_MODELS.map((model) => {
      const filePath = translationModelPath(CONFIG, model);
      const exists = fileExists(filePath);
      const bytes = exists ? fileSize(filePath) : model.approxBytes;
      return {
        id: model.id,
        label: model.label,
        alias: model.alias,
        file: model.file,
        path: filePath,
        exists,
        bytes,
        note: model.note,
        pageUrl: translationModelUrls(CONFIG, model).pageUrl,
        downloading: download?.modelId === model.id ? download.state : null
      };
    }),
    asr: ASR_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      cached: asrCacheInfo(model),
      // sizeLabel is the pre-i18n Chinese text; sizeNote is its message.
      sizeLabel: `约 ${model.approxSize}`,
      sizeNote: { key: "server_approx_size", params: [model.approxSize] },
      note: model.note
    }))
  };
}

function activeModels(models, services) {
  const runningAlias = services?.translation?.model || null;
  return {
    translation:
      models.translation.find((entry) => entry.alias === runningAlias)?.id ||
      null,
    asr: null
  };
}

const manager = createServiceManager({
  config: CONFIG,
  log: (line) => {
    pushLog(line);
    appendJobLog([line]);
  }
});

async function hasPortListener(port) {
  const health = await probeHealth(port);
  return health.listening || health.online;
}

async function runStopServices() {
  try {
    await manager.stop();
    return { ok: true, code: 0 };
  } catch (error) {
    pushLog(error.message);
    appendJobLog([error.message]);
    return { ok: false, error: error.message, code: 1 };
  }
}

async function handleStart(payload) {
  if (startPending || job.state === "starting" || job.state === "stopping") {
    const busyState = startPending ? "starting" : job.state;
    return {
      status: 409,
      body: failure(`已有任务在进行：${busyState}`, "server_job_busy", busyState)
    };
  }
  startPending = true;
  try {
    return await startServices(payload, stopGeneration);
  } finally {
    startPending = false;
  }
}

async function startServices(payload, generation) {
  const asrModel = resolveAsrModel(payload.asrModel);
  if (!asrModel) {
    return { status: 400, body: failure("未知的 ASR 模型", "server_unknown_asr_model") };
  }
  // In "api" mode with a working key the extension translates with its own
  // provider, so the local llama.cpp server would only burn the VRAM the ASR
  // needs and hand WhisperLiveKit a translation the extension discards. Start
  // ASR only. Without an explicit `true` (old popup, no key, `server` mode) the
  // local model is still the one producing Chinese, so it starts as usual.
  const asrOnly =
    payload.translationMode === "api" && payload.apiTranslationConfigured === true;
  const translationModel = resolveTranslationModel(payload.translationModel);
  if (!asrOnly) {
    if (!translationModel) {
      return { status: 400, body: failure("未知的本地翻译模型", "server_unknown_translation_model") };
    }
    const modelPath = translationModelPath(CONFIG, translationModel);
    if (!fileExists(modelPath)) {
      return {
        status: 409,
        body: {
          ...failure(
            `本地翻译模型尚未下载：${translationModel.file}`,
            "server_translation_model_missing",
            translationModel.file
          ),
          needsDownload: translationModel.id,
          downloadUrl: translationModelUrls(CONFIG, translationModel).downloadUrl
        }
      };
    }
  }

  const status = await probeServiceState();
  let wlkOnline = await hasPortListener(ASR_PORT);
  const translationOnline = await hasPortListener(TRANSLATION_PORT);
  const desiredWlkMode = asrOnly ? "asr-only" : "translation";

  async function stopServicesOrFail(reason) {
    pushLog(reason);
    const stopped = await runStopServices();
    if (!stopped.ok) {
      return stopped.error || `退出码 ${stopped.code}`;
    }
    wlkOnline = false;
    startedWlkMode = null;
    startedGlossarySignature = null;
    return "";
  }

  if (asrOnly) {
    if (translationOnline) {
      const stopFailure = await stopServicesOrFail(
        "API 翻译模式：停止本地翻译服务，把显存让给 ASR"
      );
      if (stopFailure) {
        return {
          status: 500,
          body: failure(`停止旧服务失败：${stopFailure}`, "server_stop_old_failed", stopFailure)
        };
      }
    }
  } else {
    const modelMismatch =
      status.translation.online && status.translation.model !== translationModel.alias;
    if (modelMismatch || (!status.translation.online && translationOnline)) {
      const stopFailure = await stopServicesOrFail(
        `停止旧翻译服务（当前 ${status.translation.model || "未知"}）`
      );
      if (stopFailure) {
        return {
          status: 500,
          body: failure(`停止旧服务失败：${stopFailure}`, "server_stop_old_failed", stopFailure)
        };
      }
    }
  }

  const desiredGlossary = asrOnly ? "" : sanitizeWlkGlossary(payload.glossary);
  const request = { asrModel: asrModel.id, asrOnly, restart: false };
  if (!asrOnly) {
    request.translationModel = translationModel.id;
    request.glossary = desiredGlossary;
  }

  // WhisperLiveKit does not expose its translation mode or glossary over HTTP,
  // so a leftover process is judged from what we started, plus what the ports
  // show. Switching modes or updating the server-side glossary has to restart
  // it: otherwise WLK keeps running with stale CLI arguments.
  const modeSwitch =
    startedWlkMode !== desiredWlkMode &&
    (desiredWlkMode === "asr-only" || !status.translation.online);
  // An unknown signature (`null`) means the control service restarted while a
  // WhisperLiveKit process survived, so its glossary is unknown too: restart to
  // apply the current table, even when that table is now empty.
  const glossarySwitch =
    !asrOnly && startedGlossarySignature !== desiredGlossary;
  if (wlkOnline && (modeSwitch || glossarySwitch)) {
    pushLog(
      modeSwitch
        ? desiredWlkMode === "asr-only"
          ? "WhisperLiveKit 仍在翻译模式，重启为 ASR-only"
          : "WhisperLiveKit 可能仍运行在 ASR-only，重启以恢复翻译"
        : "术语库已变更，重启 WhisperLiveKit 以加载新术语表"
    );
    request.restart = true;
  }

  if (generation !== stopGeneration) {
    return { status: 409, body: failure("启动已被停止请求取消", "server_start_cancelled") };
  }

  job = {
    state: "starting",
    action: "start",
    translationMode: asrOnly ? "asr-only" : "translation",
    glossarySignature: desiredGlossary,
    ...(asrOnly
      ? jobText(
          `正在启动 ASR ${asrModel.label}（API 翻译，不启动本地翻译模型）`,
          "server_job_starting_asr_only",
          asrModel.label
        )
      : jobText(
          `正在启动 ${translationModel.label} + ${asrModel.label}`,
          "server_job_starting",
          translationModel.label,
          asrModel.label
        )),
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null
  };

  const controller = new AbortController();
  const startedJob = job;
  jobAbort = controller;
  jobSettled = manager
    .start(request, { signal: controller.signal })
    .then(
      () => {
        // /stop aborts the start; the stop handler owns the final job state.
        if (job !== startedJob) return;
        startedWlkMode = job.translationMode || null;
        startedGlossarySignature = job.glossarySignature ?? "";
        job = {
          ...job,
          state: "finished",
          ...jobText("本地服务已就绪", "server_job_ready"),
          finishedAt: Date.now(),
          exitCode: 0
        };
      },
      (error) => {
        if (job !== startedJob) return;
        const message = error?.message || String(error);
        pushLog(message);
        appendJobLog([message]);
        job = {
          ...job,
          state: "error",
          ...jobText(`启动失败：${message}`, "server_job_start_failed", message),
          finishedAt: Date.now(),
          exitCode: 1
        };
      }
    )
    .finally(() => {
      if (jobAbort === controller) {
        jobAbort = null;
        jobSettled = null;
      }
    });

  return { status: 200, body: { ok: true, job } };
}

async function handleStop() {
  if (job.state === "stopping") {
    return { status: 409, body: failure("正在停止中", "server_stop_in_progress") };
  }
  if (downloadPending || download?.state === "downloading") {
    return { status: 409, body: failure("模型下载中，请稍后再停止", "server_stop_blocked_by_download") };
  }
  stopGeneration += 1;
  // A start that is still running would re-create the services after the stop
  // finished, so cancel it and let it unwind (its waits are abortable and it
  // spawns nothing once aborted) before killing what it already launched.
  const pendingStart = jobSettled;
  if (jobAbort) {
    pushLog("收到停止请求，取消进行中的启动任务");
    jobAbort.abort();
  }
  job = {
    state: "stopping",
    action: "stop",
    ...jobText("正在停止本地服务", "server_job_stopping"),
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null
  };
  if (pendingStart) await pendingStart;
  const result = await runStopServices();
  // Nothing is running any more, so the recorded WhisperLiveKit mode is void.
  if (result.ok) {
    startedWlkMode = null;
    startedGlossarySignature = null;
  }
  const stopError = String(result.error || result.code);
  job = {
    ...job,
    state: result.ok ? "idle" : "error",
    ...(result.ok
      ? jobText("已停止", "server_job_stopped")
      : jobText(`停止失败：${stopError}`, "server_job_stop_failed", stopError)),
    finishedAt: Date.now(),
    exitCode: result.code ?? null
  };
  const body = result.ok
    ? { ok: true, job }
    : { ...failure(job.message, job.messageKey, ...job.messageParams), job };
  return { status: 200, body };
}

async function startDownload(payload) {
  if (downloadPending || download?.state === "downloading") {
    const modelId = download?.modelId || "";
    return {
      status: 409,
      body: modelId
        ? failure(`正在下载 ${modelId}`, "server_download_busy_model", modelId)
        : failure("正在下载", "server_download_busy")
    };
  }
  downloadPending = true;
  try {
    return await beginDownload(payload);
  } finally {
    downloadPending = false;
  }
}

// Failures other than these two carry download.mjs's own text and no code.
function downloadErrorFields(error) {
  if (error instanceof DownloadError && error.code === "size-mismatch") {
    return errorFields(
      `下载大小不符（期望 ${error.expected}，实际 ${error.actual}）`,
      "server_download_size_mismatch",
      error.expected,
      error.actual
    );
  }
  if (error instanceof DownloadError && error.code === "rename") {
    return errorFields(`保存失败：${error.message}`, "server_download_save_failed", error.message);
  }
  return errorFields(error?.message || String(error));
}

async function beginDownload(payload) {
  const model = resolveTranslationModel(payload.translationModel);
  if (!model) {
    return { status: 400, body: failure("未知的本地翻译模型", "server_unknown_translation_model") };
  }
  const targetPath = translationModelPath(CONFIG, model);
  if (fileExists(targetPath)) {
    download = {
      modelId: model.id,
      state: "done",
      receivedBytes: fileSize(targetPath),
      totalBytes: fileSize(targetPath),
      ...errorFields(""),
      startedAt: Date.now(),
      finishedAt: Date.now()
    };
    return { status: 200, body: { ok: true, download } };
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const partPath = `${targetPath}.part`;
  const { downloadUrl } = translationModelUrls(CONFIG, model);
  const totalBytes = await probeTotalBytes(downloadUrl);
  discardStalePart(partPath, totalBytes);
  download = {
    modelId: model.id,
    state: "downloading",
    receivedBytes: fileSize(partPath),
    totalBytes,
    ...errorFields(""),
    startedAt: Date.now(),
    finishedAt: null
  };

  const controller = new AbortController();
  downloadAbort = controller;
  const timer = setInterval(() => {
    if (download?.modelId !== model.id) return;
    download = { ...download, receivedBytes: fileSize(partPath) };
  }, DOWNLOAD_POLL_MS);

  downloadToFile({ url: downloadUrl, targetPath, totalBytes, signal: controller.signal })
    .then(
      () => {
        download = {
          ...download,
          state: "done",
          receivedBytes: fileSize(targetPath),
          totalBytes: fileSize(targetPath),
          ...errorFields(""),
          finishedAt: Date.now()
        };
      },
      (error) => {
        // The .part stays so a retry resumes with Range; the next download
        // removes it only when its size is already past the total.
        download = {
          ...download,
          state: "error",
          receivedBytes: fileSize(partPath),
          ...downloadErrorFields(error),
          finishedAt: Date.now()
        };
      }
    )
    .finally(() => {
      clearInterval(timer);
      if (downloadAbort === controller) downloadAbort = null;
    });

  return { status: 200, body: { ok: true, download } };
}

// DNS rebinding: a page on evil.example that re-resolves to 127.0.0.1 sends
// same-origin GETs with no Origin header, so the Host header is the only signal.
function hostAllowed(host) {
  if (!host) return true; // HTTP/1.0 native callers
  return [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(
    host.toLowerCase()
  );
}

function originAllowed(origin) {
  if (!origin) return true; // curl / scripts / native callers
  return origin.startsWith("chrome-extension://");
}

async function handleRequest(req, res) {
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  // Cross-site browser requests without an Origin header (inline <img>, <link>,
  // etc.) must not reach the control plane either.
  const blocked =
    !hostAllowed(req.headers.host) ||
    !originAllowed(origin) ||
    (!origin && fetchSite && fetchSite === "cross-site");
  if (blocked) {
    return sendJson(res, 403, failure("只接受扩展页面调用", "server_forbidden_origin"));
  }
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "GET,POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600"
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /health") {
      return sendJson(res, 200, { ok: true, service: "shengmu-local", version: SERVICE_VERSION });
    }
    if (route === "GET /status") {
      const services = await probeServiceState();
      const models = listModels();
      return sendJson(res, 200, {
        ok: true,
        version: SERVICE_VERSION,
        services,
        job,
        download,
        active: activeModels(models, services),
        logTail: logTail.slice(-8)
      });
    }
    if (route === "GET /models") {
      const services = await probeServiceState();
      return sendJson(res, 200, { ok: true, models: listModels(), services });
    }
    if (route === "POST /start") {
      const body = await readJsonBody(req);
      const result = await handleStart(body);
      return sendJson(res, result.status, result.body);
    }
    if (route === "POST /stop") {
      const result = await handleStop();
      return sendJson(res, result.status, result.body);
    }
    if (route === "POST /download") {
      const body = await readJsonBody(req);
      const result = await startDownload(body);
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 404, failure(`未知接口：${route}`, "server_unknown_route", route));
  } catch (error) {
    return sendJson(res, 500, failure(error?.message || String(error), error?.errorCode));
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    sendJson(res, 500, failure(error?.message || String(error)));
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[shengmu-local] 端口 ${PORT} 已被占用，可能已有一个控制服务在运行。`);
  } else {
    console.error(`[shengmu-local] 启动失败：${error.message}`);
  }
  process.exit(1);
});

server.listen(REQUESTED_PORT, HOST, () => {
  PORT = server.address().port;
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), "ascii");
  console.log(`[shengmu-local] listening on http://${HOST}:${PORT}`);
  console.log(
    `[shengmu-local] ASR backend ${CONFIG.asrBackend}; download proxy ${
      proxySetup.enabled ? "from environment" : `off (${proxySetup.reason})`
    }`
  );
});

function shutdown() {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch {
    // ignore
  }
  // Do not leave a half-finished start behind after the control plane exits;
  // services it already launched keep running, as they did under PowerShell.
  jobAbort?.abort();
  downloadAbort?.abort();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
