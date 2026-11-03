import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromeCandidates, devBrowserArgs, findChrome } from "../scripts/dev-browser.mjs";
import { isPidAlive, isPortListening } from "../scripts/local-service/processes.mjs";

const CLI = fileURLToPath(new URL("../scripts/services.mjs", import.meta.url));
const STUB = fileURLToPath(new URL("./fixtures/stub-service.js", import.meta.url));

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

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shengmu-cli-"));
  const env = {
    ...process.env,
    SHENGMU_RESEARCH_DIR: path.join(dir, "research"),
    SHENGMU_LOGS_DIR: path.join(dir, "logs"),
    SHENGMU_RUNTIME_DIR: path.join(dir, "runtime"),
    SHENGMU_LOCAL_SERVICE_PID_FILE: path.join(dir, "server.pid"),
    SHENGMU_ASR_PORT: String(await freePort()),
    SHENGMU_TRANSLATION_PORT: String(await freePort()),
    SHENGMU_LOCAL_SERVICE_PORT: String(await freePort()),
    SHENGMU_ASR_BACKEND: "faster-whisper",
    SHENGMU_WLK_COMMAND: JSON.stringify([process.execPath, STUB, "wlk"]),
    SHENGMU_LLAMA_COMMAND: JSON.stringify([process.execPath, STUB, "llama"]),
    SHENGMU_HEALTH_POLL_MS: "50"
  };
  t.after(async () => {
    await run(["stop"], env);
    await run(["serve-stop"], env);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env };
}

test("help and unknown commands", async () => {
  const help = await run(["help"], process.env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /serve-stop/);
  const unknown = await run(["frobnicate"], process.env);
  assert.equal(unknown.code, 2);
  const badFlag = await run(["start", "--no-such-flag"], process.env);
  assert.equal(badFlag.code, 1);
  assert.match(badFlag.stderr, /no-such-flag/);
});

test("start, status and stop from the command line", async (t) => {
  const { env } = await sandbox(t);
  const started = await run(["start", "--asr-only", "--asr-model", "medium"], env);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /wlk\s+: started/);
  assert.equal(await isPortListening(Number(env.SHENGMU_ASR_PORT)), true);

  const status = await run(["status"], env);
  assert.match(status.stdout, /"healthy":true/);

  const refused = await run(["start", "--asr-only"], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Use --restart/);

  const stopped = await run(["stop"], env);
  assert.equal(stopped.code, 0);
  assert.match(stopped.stdout, /stopped\s+: wlk:\d+/);
  assert.equal(await isPortListening(Number(env.SHENGMU_ASR_PORT)), false);
});

test("serve starts the control service in the background and serve-stop ends it", async (t) => {
  const { env } = await sandbox(t);
  const served = await run(["serve"], env);
  assert.equal(served.code, 0, served.stderr);
  const pid = Number(/pid\s+: (\d+)/.exec(served.stdout)?.[1]);
  assert.ok(isPidAlive(pid));
  assert.match((await run(["serve"], env)).stdout, /status\s+: running/);

  const response = await fetch(`http://127.0.0.1:${env.SHENGMU_LOCAL_SERVICE_PORT}/health`);
  assert.equal((await response.json()).service, "shengmu-local");

  const stopped = await run(["serve-stop"], env);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(isPidAlive(pid), false);
  assert.equal(fs.existsSync(env.SHENGMU_LOCAL_SERVICE_PID_FILE), false);
  assert.match((await run(["serve-stop"], env)).stdout, /not running/);
});

test("chrome discovery per OS and the dev profile flags", () => {
  const win = chromeCandidates({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }
  });
  assert.deepEqual(win, [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
  ]);
  const mac = chromeCandidates({ platform: "darwin", env: { CHROME_PATH: "/custom/chrome" }, home: "/Users/me" });
  assert.deepEqual(mac, [
    "/custom/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ]);
  assert.equal(
    findChrome({ platform: "linux", env: { PATH: "/opt/bin" }, exists: (file) => file === "/opt/bin/chromium" }),
    "/opt/bin/chromium"
  );
  assert.throws(() => findChrome({ platform: "linux", env: { PATH: "" }, exists: () => false }), /CHROME_PATH/);
  assert.deepEqual(devBrowserArgs({ port: 9223, profileDir: "/p", url: "about:blank" }), [
    "--remote-debugging-port=9223",
    "--enable-unsafe-extension-debugging",
    "--user-data-dir=/p",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank"
  ]);
});
