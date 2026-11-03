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
 *   POST /download  下载所选翻译模型的 GGUF（curl 断点续传，带进度）
 *
 * 只绑定回环地址，并且只接受来自 chrome-extension:// 页面的跨域请求。
 * 启动逻辑不在这里重复实现，统一调用 scripts/Start-Services.ps1。
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPTS = path.join(ROOT, "scripts");
const RESEARCH = path.join(ROOT, ".research");
const LOGS = path.join(ROOT, "logs");
const START_SCRIPT = path.join(SCRIPTS, "Start-Services.ps1");
const STOP_SCRIPT = path.join(SCRIPTS, "Stop-Services.ps1");

const HOST = process.env.SHENGMU_LOCAL_SERVICE_HOST || "127.0.0.1";
const PORT = Number(process.env.SHENGMU_LOCAL_SERVICE_PORT || 8014);
const TRANSLATION_PORT = Number(process.env.SHENGMU_TRANSLATION_PORT || 8013);
const ASR_PORT = Number(process.env.SHENGMU_ASR_PORT || 8010);
const SERVICE_VERSION = "1.0.0";

const POWERSHELL = process.env.SHENGMU_POWERSHELL || "powershell.exe";
const CURL = process.env.SHENGMU_CURL || "C:\\Windows\\System32\\curl.exe";
const HF_CACHE = path.join(os.homedir(), ".cache", "huggingface", "hub");

const TRANSLATION_MODELS = [
  {
    id: "9b-q4km",
    label: "Index-Translate-9B Q4_K_M",
    alias: "Index-Translate-9B",
    file: "Index-Translate-9B.Q4_K_M.gguf",
    dir: path.join(RESEARCH, "models", "index-translate-9b"),
    pageUrl: "https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF",
    downloadUrl:
      "https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF/resolve/main/Index-Translate-9B.Q4_K_M.gguf",
    approxBytes: 5780090304,
    note: "5.4 GiB · 质量最好"
  },
  {
    id: "2b-iq4xs",
    label: "Index-Translate-2B IQ4_XS",
    alias: "Index-Translate-2B",
    file: "Index-Translate-2B.IQ4_XS.gguf",
    dir: path.join(RESEARCH, "models", "index-translate-2b"),
    pageUrl: "https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF",
    downloadUrl:
      "https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF/resolve/main/Index-Translate-2B.IQ4_XS.gguf",
    approxBytes: 1234377216,
    note: "1.15 GiB · 省显存"
  }
];

const ASR_MODELS = [
  {
    id: "large-v3-turbo",
    label: "large-v3-turbo",
    repo: "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo",
    sizeLabel: "约 1.6 GB",
    note: "精度最好（默认）"
  },
  {
    id: "medium",
    label: "medium",
    repo: "models--Systran--faster-whisper-medium",
    sizeLabel: "约 1.5 GB",
    note: "更快更省显存，精度略降"
  }
];

const DOWNLOAD_POLL_MS = 700;
const MAX_WLK_GLOSSARY_CHARS = 4000;
const logTail = [];
let job = {
  state: "idle",
  action: "",
  message: "",
  startedAt: null,
  finishedAt: null,
  exitCode: null
};
let jobChild = null;
// WhisperLiveKit has no endpoint that reports whether it translates or which
// glossary it was started with, so what we last started it with is the only
// reliable hint. null means unknown.
let startedWlkMode = null;
let startedGlossarySignature = null;
let download = null;
let downloadChild = null;

function sanitizeWlkGlossary(value) {
  return String(value ?? "")
    .replace(/[\0-\x1F\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WLK_GLOSSARY_CHARS);
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
    if (size > limitBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("请求体不是合法 JSON");
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

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function asrCacheInfo(repo) {
  const repoDir = path.join(HF_CACHE, repo);
  try {
    const snapshots = path.join(repoDir, "snapshots");
    const entries = fs.readdirSync(snapshots, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const snapshotDir = path.join(snapshots, entry.name);
      const files = fs.readdirSync(snapshotDir);
      if (files.includes("model.bin")) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function listModels() {
  return {
    translation: TRANSLATION_MODELS.map((model) => {
      const filePath = path.join(model.dir, model.file);
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
        pageUrl: model.pageUrl,
        downloading: download?.modelId === model.id ? download.state : null
      };
    }),
    asr: ASR_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      cached: asrCacheInfo(model.repo),
      sizeLabel: model.sizeLabel,
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

function spawnPowerShell(scriptPath, args) {
  const child = spawn(
    POWERSHELL,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    lines.forEach(pushLog);
    appendJobLog(lines);
  });
  child.stderr.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    lines.forEach(pushLog);
    appendJobLog(lines);
  });
  return child;
}

function resolveTranslationModel(id) {
  return TRANSLATION_MODELS.find((model) => model.id === id) || null;
}

function resolveAsrModel(id) {
  return ASR_MODELS.find((model) => model.id === id) || null;
}

async function hasPortListener(port) {
  const health = await probeHealth(port);
  return health.listening || health.online;
}

async function runStopServices() {
  return new Promise((resolve) => {
    const child = spawnPowerShell(STOP_SCRIPT, []);
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, code }));
  });
}

async function handleStart(payload) {
  if (job.state === "starting" || job.state === "stopping") {
    return { status: 409, body: { ok: false, error: `已有任务在进行：${job.state}` } };
  }
  const asrModel = resolveAsrModel(payload.asrModel);
  if (!asrModel) {
    return { status: 400, body: { ok: false, error: "未知的 ASR 模型" } };
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
      return { status: 400, body: { ok: false, error: "未知的本地翻译模型" } };
    }
    const modelPath = path.join(translationModel.dir, translationModel.file);
    if (!fileExists(modelPath)) {
      return {
        status: 409,
        body: {
          ok: false,
          error: `本地翻译模型尚未下载：${translationModel.file}`,
          needsDownload: translationModel.id,
          downloadUrl: translationModel.downloadUrl
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
      const failure = await stopServicesOrFail(
        "API 翻译模式：停止本地翻译服务，把显存让给 ASR"
      );
      if (failure) {
        return {
          status: 500,
          body: { ok: false, error: `停止旧服务失败：${failure}` }
        };
      }
    }
  } else {
    const modelMismatch =
      status.translation.online && status.translation.model !== translationModel.alias;
    if (modelMismatch || (!status.translation.online && translationOnline)) {
      const failure = await stopServicesOrFail(
        `停止旧翻译服务（当前 ${status.translation.model || "未知"}）`
      );
      if (failure) {
        return {
          status: 500,
          body: { ok: false, error: `停止旧服务失败：${failure}` }
        };
      }
    }
  }

  const desiredGlossary = asrOnly ? "" : sanitizeWlkGlossary(payload.glossary);
  const startArgs = ["-AsrModel", asrModel.id];
  if (asrOnly) {
    startArgs.push("-AsrOnly");
  } else {
    startArgs.push("-TranslationModel", translationModel.id);
    if (desiredGlossary) {
      startArgs.push("-Glossary", desiredGlossary);
    }
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
    startArgs.push("-Restart");
  }

  job = {
    state: "starting",
    action: "start",
    translationMode: asrOnly ? "asr-only" : "translation",
    glossarySignature: desiredGlossary,
    message: asrOnly
      ? `正在启动 ASR ${asrModel.label}（API 翻译，不启动本地翻译模型）`
      : `正在启动 ${translationModel.label} + ${asrModel.label}`,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null
  };

  const child = spawnPowerShell(START_SCRIPT, startArgs);
  jobChild = child;
  child.on("error", (error) => {
    jobChild = null;
    if (job.state === "stopping") return;
    job = {
      ...job,
      state: "error",
      message: `启动失败：${error.message}`,
      finishedAt: Date.now()
    };
  });
  child.on("exit", (code) => {
    jobChild = null;
    // /stop kills the launcher; the stop handler owns the final job state.
    if (job.state === "stopping") return;
    const finishedAt = Date.now();
    if (code === 0) {
      startedWlkMode = job.translationMode || null;
      startedGlossarySignature = job.glossarySignature ?? "";
      job = { ...job, state: "finished", message: "本地服务已就绪", finishedAt, exitCode: code };
    } else {
      const tail = logTail.slice(-4).join(" | ");
      job = {
        ...job,
        state: "error",
        message: tail || `启动脚本退出码 ${code}`,
        finishedAt,
        exitCode: code
      };
    }
  });

  return { status: 200, body: { ok: true, job } };
}

async function handleStop() {
  if (job.state === "stopping") {
    return { status: 409, body: { ok: false, error: "正在停止中" } };
  }
  if (download?.state === "downloading") {
    return { status: 409, body: { ok: false, error: "模型下载中，请稍后再停止" } };
  }
  // A start launcher that is still running would re-create the services after
  // Stop-Services finished, so terminate it first.
  if (jobChild) {
    pushLog("收到停止请求，终止进行中的启动脚本");
    jobChild.kill();
    jobChild = null;
  }
  job = {
    state: "stopping",
    action: "stop",
    message: "正在停止本地服务",
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null
  };
  const result = await runStopServices();
  // Nothing is running any more, so the recorded WhisperLiveKit mode is void.
  if (result.ok) {
    startedWlkMode = null;
    startedGlossarySignature = null;
  }
  job = {
    ...job,
    state: result.ok ? "idle" : "error",
    message: result.ok ? "已停止" : `停止失败：${result.error || result.code}`,
    finishedAt: Date.now(),
    exitCode: result.code ?? null
  };
  return { status: 200, body: { ok: result.ok, job, error: result.ok ? undefined : job.message } };
}

function curlProxyArgs() {
  if (process.env.SHENGMU_DOWNLOAD_NO_PROXY === "1") return ["--noproxy", "*"];
  return [];
}

function runCurlHeadTotal(url) {
  return new Promise((resolve) => {
    const child = spawn(
      CURL,
      ["-sIL", "--max-time", "25", ...curlProxyArgs(), url],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", () => resolve(0));
    child.on("exit", () => {
      const sizes = [...output.matchAll(/^content-length:\s*(\d+)/gim)].map((match) =>
        Number(match[1])
      );
      // The last hop is the real payload; earlier values belong to redirect
      // responses whose body is a short HTML page.
      resolve(sizes.length ? sizes[sizes.length - 1] : 0);
    });
  });
}

async function startDownload(payload) {
  if (download?.state === "downloading") {
    return { status: 409, body: { ok: false, error: `正在下载 ${download.modelId}` } };
  }
  const model = resolveTranslationModel(payload.translationModel);
  if (!model) {
    return { status: 400, body: { ok: false, error: "未知的本地翻译模型" } };
  }
  const targetPath = path.join(model.dir, model.file);
  if (fileExists(targetPath)) {
    download = {
      modelId: model.id,
      state: "done",
      receivedBytes: fileSize(targetPath),
      totalBytes: fileSize(targetPath),
      error: "",
      startedAt: Date.now(),
      finishedAt: Date.now()
    };
    return { status: 200, body: { ok: true, download } };
  }

  await fsp.mkdir(model.dir, { recursive: true });
  const partPath = `${targetPath}.part`;
  const totalBytes = await runCurlHeadTotal(model.downloadUrl);
  const partBytes = fileSize(partPath);
  // totalBytes is 0 when the HEAD probe failed or timed out; a size check
  // against 0 would wipe a resumable multi-GB .part, so only trust a real total.
  if (partBytes > 0 && totalBytes > 0 && partBytes >= totalBytes) {
    // A finished or over-long leftover would make curl answer 416 forever.
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      // ignore
    }
  }
  download = {
    modelId: model.id,
    state: "downloading",
    receivedBytes: fileSize(partPath),
    totalBytes,
    error: "",
    startedAt: Date.now(),
    finishedAt: null
  };

  const child = spawn(
    CURL,
    [
      "-L",
      "--fail",
      "--retry",
      "3",
      "--retry-delay",
      "2",
      "-C",
      "-",
      "-o",
      partPath,
      ...curlProxyArgs(),
      model.downloadUrl
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
  );
  downloadChild = child;
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-800);
  });

  const timer = setInterval(() => {
    if (download?.modelId !== model.id) return;
    download = { ...download, receivedBytes: fileSize(partPath) };
  }, DOWNLOAD_POLL_MS);

  child.on("error", (error) => {
    clearInterval(timer);
    download = {
      ...download,
      state: "error",
      error: error.message,
      finishedAt: Date.now()
    };
    downloadChild = null;
  });

  child.on("exit", (code) => {
    clearInterval(timer);
    const partSize = fileSize(partPath);
    if (code === 0 && totalBytes > 0 && partSize !== totalBytes) {
      download = {
        ...download,
        state: "error",
        receivedBytes: partSize,
        error: `下载大小不符（期望 ${totalBytes}，实际 ${partSize}）`,
        finishedAt: Date.now()
      };
    } else if (code === 0) {
      try {
        fs.renameSync(partPath, targetPath);
        download = {
          ...download,
          state: "done",
          receivedBytes: fileSize(targetPath),
          totalBytes: fileSize(targetPath),
          error: "",
          finishedAt: Date.now()
        };
      } catch (error) {
        download = {
          ...download,
          state: "error",
          error: `保存失败：${error.message}`,
          finishedAt: Date.now()
        };
      }
    } else {
      // Keep the .part file so a retry can resume with `curl -C -`; the next
      // startDownload removes it only when its size is already past the total.
      download = {
        ...download,
        state: "error",
        receivedBytes: fileSize(partPath),
        error: stderrTail.trim().split(/\r?\n/).pop() || `curl 退出码 ${code}`,
        finishedAt: Date.now()
      };
    }
    downloadChild = null;
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
  if (!origin) return true; // curl / PowerShell / native callers
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
    return sendJson(res, 403, { ok: false, error: "只接受扩展页面调用" });
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
    return sendJson(res, 404, { ok: false, error: `未知接口：${route}` });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error?.message || String(error) });
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { ok: false, error: error?.message || String(error) });
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

server.listen(PORT, HOST, () => {
  fs.mkdirSync(RESEARCH, { recursive: true });
  fs.writeFileSync(
    path.join(HERE, "server.pid"),
    String(process.pid),
    "ascii"
  );
  console.log(`[shengmu-local] listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  try {
    fs.rmSync(path.join(HERE, "server.pid"), { force: true });
  } catch {
    // ignore
  }
  // Do not leave an orphaned launcher behind after the control plane exits.
  if (jobChild) {
    jobChild.kill();
    jobChild = null;
  }
  if (download?.state === "downloading" && downloadChild) {
    downloadChild.kill();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
