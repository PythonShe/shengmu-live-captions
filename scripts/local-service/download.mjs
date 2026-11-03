// Resumable model downloads over fetch(), replacing the curl.exe calls:
// HEAD for the size, a .part file resumed with Range, retries, and a final
// size check before the rename.
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sleep } from "./processes.mjs";

const PROXY_KEYS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];

export class DownloadError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "DownloadError";
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * curl picked up HTTP(S)_PROXY by itself; fetch() only does so when Node is
 * started with NODE_USE_ENV_PROXY=1 / --use-env-proxy, or after
 * http.setGlobalProxyFromEnv() (Node >= 24.14). Call this once at startup,
 * before any request. Loopback is always added to NO_PROXY so the /health
 * probes of 8010/8013 never go through the proxy. SHENGMU_DOWNLOAD_NO_PROXY=1
 * keeps the old `curl --noproxy *` escape hatch.
 */
export function configureProxyFromEnv(env = process.env, setGlobal = http.setGlobalProxyFromEnv) {
  if (typeof setGlobal !== "function") {
    return { enabled: false, reason: "this Node has no http.setGlobalProxyFromEnv (needs >= 24.14)" };
  }
  if (env.SHENGMU_DOWNLOAD_NO_PROXY === "1") {
    setGlobal({});
    return { enabled: false, reason: "SHENGMU_DOWNLOAD_NO_PROXY=1" };
  }
  if (!PROXY_KEYS.some((key) => env[key])) return { enabled: false, reason: "no proxy configured" };
  const existing = String(env.no_proxy ?? env.NO_PROXY ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const noProxy = [...new Set([...existing, ...LOOPBACK])].join(",");
  const proxyEnv = {};
  for (const key of PROXY_KEYS) if (env[key]) proxyEnv[key] = env[key];
  setGlobal({ ...proxyEnv, NO_PROXY: noProxy, no_proxy: noProxy });
  return { enabled: true, noProxy };
}

export function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Size of the final payload after redirects. fetch only exposes the last hop,
 * which is what curl's "last content-length" parsing picked out of -sIL.
 * Returns 0 when unknown.
 */
export async function probeTotalBytes(url, { timeoutMs = 15000, signal } = {}) {
  try {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.any(signals) });
    if (!response.ok) return 0;
    const size = Number(response.headers.get("content-length"));
    return Number.isFinite(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

/**
 * A finished or over-long leftover would make every resume answer 416. A
 * total of 0 means the HEAD probe failed, and a size check against it would
 * wipe a resumable multi-GB .part, so only a real total is trusted.
 */
export function discardStalePart(partPath, totalBytes) {
  const partBytes = fileSize(partPath);
  if (partBytes > 0 && totalBytes > 0 && partBytes >= totalBytes) {
    try {
      fs.rmSync(partPath, { force: true });
    } catch {
      // Best effort: a .part that cannot be removed fails the resume visibly.
    }
    return true;
  }
  return false;
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? 0 : Number(match[3]) };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function fetchOnce({ url, partPath, signal, idleTimeoutMs }) {
  const offset = fileSize(partPath);
  const idle = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new DownloadError("stalled", `no data for ${idleTimeoutMs} ms`)), idleTimeoutMs);
  };
  const combined = AbortSignal.any([idle.signal, ...(signal ? [signal] : [])]);
  armIdle();
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
      signal: combined
    });
    if (response.status === 416) {
      await response.body?.cancel();
      return { status: 416, offset };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadError("http", `HTTP ${response.status}`, { status: response.status });
    }
    let append = false;
    let total = 0;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== offset) {
        await response.body?.cancel();
        throw new DownloadError("range", `server resumed at ${range?.start ?? "?"} instead of ${offset}`);
      }
      append = true;
      total = range.total;
    } else {
      // 200 to a ranged request: the server ignored Range, start over.
      total = Number(response.headers.get("content-length")) || 0;
    }
    if (!response.body) throw new DownloadError("http", "empty response body");
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (source) {
        for await (const chunk of source) {
          armIdle();
          yield chunk;
        }
      },
      fs.createWriteStream(partPath, { flags: append ? "a" : "w" }),
      { signal: combined }
    );
    return { status: response.status, total };
  } catch (error) {
    if (idle.signal.aborted && !signal?.aborted) throw idle.signal.reason;
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * Downloads `url` to `targetPath` through `${targetPath}.part`. Keeps the
 * .part on failure so the next call resumes (like `curl -C -`), retries
 * transient failures (like `curl --retry 3 --retry-delay 2`), and refuses to
 * rename a file whose size does not match the known total.
 */
export async function downloadToFile({
  url,
  targetPath,
  totalBytes = 0,
  signal,
  retries = 3,
  retryDelayMs = 2000,
  idleTimeoutMs = 60000
}) {
  const partPath = `${targetPath}.part`;
  discardStalePart(partPath, totalBytes);
  let total = totalBytes;
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const result = await fetchOnce({ url, partPath, signal, idleTimeoutMs });
      if (result.status === 416) {
        if (total > 0 && fileSize(partPath) === total) break;
        // The .part does not line up with the remote file; restart it.
        fs.rmSync(partPath, { force: true });
        throw new DownloadError("range", "HTTP 416 for the resume offset");
      }
      if (!total && result.total) total = result.total;
      break;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const retryable =
        !(error instanceof DownloadError) ||
        error.code === "stalled" ||
        error.code === "range" ||
        (error.code === "http" && RETRYABLE_STATUS.has(error.status));
      if (!retryable || attempt >= retries) throw error;
      attempt += 1;
      await sleep(retryDelayMs, signal);
    }
  }
  const partSize = fileSize(partPath);
  if (total > 0 && partSize !== total) {
    throw new DownloadError("size-mismatch", `size mismatch: expected ${total}, got ${partSize}`, {
      expected: total,
      actual: partSize
    });
  }
  try {
    fs.renameSync(partPath, targetPath);
  } catch (error) {
    throw new DownloadError("rename", error.message, { cause: error });
  }
  return { bytes: fileSize(targetPath), partPath };
}
