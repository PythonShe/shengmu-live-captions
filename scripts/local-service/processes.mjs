// Process plumbing for the service manager: spawn detached with log files,
// PID files, kill a whole tree, and probe ports and /health. Only Node built-ins
// plus taskkill/tasklist, which ship with every Windows.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function isPortListening(port, { host = "127.0.0.1", timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function fetchJson(url, timeoutMs = 3000, signal) {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error };
  }
}

/**
 * Polls `url` until it answers {"status":"ok"} (WLK and llama-server both do),
 * the deadline passes, the signal aborts, or `isDead()` reports that the
 * process we are waiting for has already exited.
 */
export async function waitForHealth(url, { timeoutMs, pollMs = 500, signal, isDead } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const result = await fetchJson(url, 3000, signal);
    signal?.throwIfAborted();
    if (result.ok && result.body?.status === "ok") return result.body;
    if (isDead?.()) return null;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs, signal);
  }
}

export async function waitForPort(port, { timeoutMs, pollMs = 500, signal, isDead } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    if (await isPortListening(port)) return true;
    if (isDead?.()) return false;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs, signal);
  }
}

export function pidFilePath(runtimeDir, name) {
  return path.join(runtimeDir, `${name}.pid`);
}

export function readPidFile(runtimeDir, name) {
  let text;
  try {
    text = fs.readFileSync(pidFilePath(runtimeDir, name), "utf8");
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(text);
    return Number.isInteger(record?.pid) && record.pid > 0 ? record : null;
  } catch {
    return null;
  }
}

export function removePidFile(runtimeDir, name) {
  fs.rmSync(pidFilePath(runtimeDir, name), { force: true });
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

export function tailFile(filePath, lines = 80) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim()).slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Starts one service detached, so it outlives the control service like the
 * old Start-Process launch did, with stdout/stderr in logs/<name>.*.log
 * (truncated per start, as Start-Process -RedirectStandardOutput did). The PID
 * file is written synchronously right after spawn() returns, so a concurrent
 * stop never misses a child that already exists.
 */
export async function spawnService({ name, command, args, cwd, env, logsDir, runtimeDir, port, platform = process.platform }) {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const stdoutPath = path.join(logsDir, `${name}.stdout.log`);
  const stderrPath = path.join(logsDir, `${name}.stderr.log`);
  const out = fs.openSync(stdoutPath, "w");
  const err = fs.openSync(stderrPath, "w");
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err]
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const state = { exited: false, exitCode: null, signal: null };
  child.on("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.signal = signal;
  });
  if (child.pid) {
    const record = {
      pid: child.pid,
      name,
      port,
      // Windows has no process groups; the image name is what lets stop()
      // refuse to kill a PID that was reused by an unrelated program.
      image: (platform === "win32" ? path.win32 : path.posix).basename(command).toLowerCase(),
      startedAt: new Date().toISOString()
    };
    fs.writeFileSync(pidFilePath(runtimeDir, name), JSON.stringify(record), "utf8");
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => {
      removePidFile(runtimeDir, name);
      reject(new Error(`Could not start ${name} (${command}): ${error.message}`, { cause: error }));
    });
  });
  child.unref();
  return { pid: child.pid, state, stdoutPath, stderrPath };
}

export function windowsKillCommand(pid) {
  return { command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] };
}

export function runQuiet(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Image name of a Windows PID via tasklist's CSV output, or "" if none. */
export async function windowsImageName(pid) {
  const result = await runQuiet("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  return parseTasklistImage(result.stdout, pid);
}

export function parseTasklistImage(stdout, pid) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    if (cells.length >= 2 && Number(cells[1]) === Number(pid)) return cells[0].toLowerCase();
  }
  return "";
}

/** Full command line of a POSIX PID via ps, or "" if it no longer exists. */
export async function posixCommandLine(pid) {
  const result = await runQuiet("ps", ["-p", String(pid), "-o", "args="]);
  return result.code === 0 ? result.stdout.trim() : "";
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * Kills a service started by spawnService together with its children (the
 * pip launcher .exe on Windows runs python.exe as a child; WLK may fork
 * helpers). Returns "killed", "gone" (already dead) or "foreign" (the PID now
 * belongs to something else, left alone).
 */
export async function killServiceTree(record, { platform = process.platform, graceMs = 5000 } = {}) {
  const { pid } = record;
  if (!isPidAlive(pid)) return "gone";
  if (platform === "win32") {
    const image = await windowsImageName(pid);
    if (!image) return "gone";
    if (record.image && image !== record.image) return "foreign";
    const { command, args } = windowsKillCommand(pid);
    const result = await runQuiet(command, args);
    if (!(await waitForExit(pid, graceMs))) {
      throw new Error(`taskkill could not stop PID ${pid}: ${(result.stderr || result.stdout).trim()}`);
    }
    return "killed";
  }
  // A stale PID file (e.g. after a reboot) can name a PID that now leads an
  // unrelated group, such as a terminal, so check the command line before a
  // group kill. `args` rather than `comm`: a shebang launcher like `wlk` shows
  // up as `python3` in comm but keeps its own path in args.
  if (record.image) {
    const args = await posixCommandLine(pid);
    if (!args) return "gone";
    if (!args.toLowerCase().includes(record.image)) return "foreign";
  }
  // A detached child leads its own process group, so the group id equals the
  // PID. If no such group exists the PID was reused by an unrelated process.
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return "foreign";
    throw error;
  }
  if (await waitForExit(pid, graceMs)) return "killed";
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!(await waitForExit(pid, 2000))) throw new Error(`PID ${pid} survived SIGKILL`);
  return "killed";
}
