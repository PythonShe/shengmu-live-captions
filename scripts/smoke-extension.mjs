// Loads the unpacked extension into a throwaway headless Chrome profile over
// CDP and checks that every entry point starts: the service worker, the
// offscreen document and its worklet, the popup and subtitle pages, and the
// overlay injection into a plain http page. It does not capture audio.
//
// Usage: node scripts/smoke-extension.mjs   (CHROME_PATH overrides discovery)
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION = fileURLToPath(new URL("../extension", import.meta.url));
const TIMEOUT_MS = 15000;
// A cold Chrome on a shared CI runner can take well over 15 s to listen.
const STARTUP_TIMEOUT_MS = 60000;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(probe, label, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shengmu-smoke-"));
const hostPage = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>host</title><video></video><p>host page</p>");
});
await new Promise((resolve) => {
  hostPage.listen(0, "127.0.0.1", resolve);
});
const hostUrl = `http://127.0.0.1:${hostPage.address().port}/`;

const browser = spawn(
  findChrome(),
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
let browserStderr = "";
browser.stderr.on("data", (chunk) => {
  browserStderr = (browserStderr + String(chunk)).slice(-2000);
});

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
let socket;

try {
  // Chrome writes the chosen port to DevToolsActivePort once it listens.
  const portFile = path.join(profile, "DevToolsActivePort");
  const port = await waitFor(
    async () => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").split("\n")[0],
    "DevTools port",
    STARTUP_TIMEOUT_MS
  );
  const version = await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(),
    "DevTools endpoint"
  );

  let nextId = 1;
  const pending = new Map();
  const events = [];
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else {
      events.push(message);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const attach = async (targetId) => {
    const attached = await send("Target.attachToTarget", { targetId, flatten: true });
    const { sessionId } = attached.result;
    await send("Runtime.enable", {}, sessionId);
    return sessionId;
  };
  const evaluate = async (sessionId, expression) => {
    const reply = await send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    return reply.result?.exceptionDetails
      ? `exception: ${reply.result.exceptionDetails.exception?.description}`
      : reply.result?.result?.value;
  };
  const exceptionsFor = (sessionId) =>
    events
      .filter((event) => event.sessionId === sessionId && event.method === "Runtime.exceptionThrown")
      .map((event) => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);

  const loaded = await send("Extensions.loadUnpacked", { path: EXTENSION });
  const extensionId = loaded.result?.id;
  check("extension loads", extensionId, JSON.stringify(loaded.error));
  if (!extensionId) throw new Error("extension did not load");

  const worker = await waitFor(async () => {
    const { targetInfos } = (await send("Target.getTargets")).result;
    return targetInfos.find((target) => target.type === "service_worker" && target.url.includes(extensionId));
  }, "service worker");
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8"));
  check(
    "service worker starts",
    worker.url.endsWith(`/${manifest.background.service_worker}`),
    worker.url
  );
  const workerSession = await attach(worker.targetId);
  // The target can appear before the extension APIs are bound in it.
  await waitFor(
    async () => (await evaluate(workerSession, `typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)`)) === true,
    "worker extension APIs"
  );
  check(
    "worker evaluates",
    (await evaluate(workerSession, "chrome.runtime.getManifest().version")) === manifest.version
  );

  const offscreen = await evaluate(
    workerSession,
    `chrome.offscreen.createDocument({ url: "offscreen/offscreen.html", reasons: ["USER_MEDIA"], justification: "smoke" }).then(() => "ok", (error) => String(error))`
  );
  check("offscreen document opens", offscreen === "ok", offscreen);
  const worklet = await evaluate(
    workerSession,
    `fetch(chrome.runtime.getURL("offscreen/pcm-worklet.js")).then((response) => response.status)`
  );
  check("audio worklet resolves", worklet === 200, worklet);

  for (const pagePath of [manifest.action.default_popup, "subtitle/subtitle.html"]) {
    const created = await send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/${pagePath}`
    });
    const sessionId = await attach(created.result.targetId);
    const state = await waitFor(async () => {
      const value = await evaluate(
        sessionId,
        `document.readyState === "complete" && JSON.stringify({ styles: document.styleSheets.length })`
      );
      return value || null;
    }, pagePath);
    await sleep(500);
    const errors = exceptionsFor(sessionId);
    check(`${pagePath} renders`, JSON.parse(state).styles > 0 && errors.length === 0, JSON.stringify(errors));
  }

  const host = await send("Target.createTarget", { url: hostUrl });
  const hostSession = await attach(host.result.targetId);
  await waitFor(async () => (await evaluate(hostSession, "document.readyState")) === "complete", "host page");
  const injected = await evaluate(
    workerSession,
    `chrome.tabs.query({ url: "${hostUrl}*" }).then(([tab]) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/overlay-history.js", "content/content-overlay.js"] })).then(() => "ok", (error) => String(error))`
  );
  check("overlay injects", injected === "ok", injected);
  const shadowHost = await waitFor(
    async () =>
      evaluate(hostSession, `[...document.querySelectorAll("*")].some((element) => element.shadowRoot)`),
    "overlay shadow root"
  ).catch(() => false);
  check("overlay mounts a shadow root", shadowHost);

  await sleep(500);
  const workerErrors = exceptionsFor(workerSession);
  check("worker raises no exceptions", workerErrors.length === 0, JSON.stringify(workerErrors));
} catch (error) {
  check("smoke run", false, `${error.message}${browserStderr ? `\n--- chrome stderr ---\n${browserStderr}` : ""}`);
} finally {
  socket?.close();
  browser.kill();
  hostPage.close();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `  ${result.detail}`}`);
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
