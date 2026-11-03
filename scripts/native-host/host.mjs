// The native messaging host Chrome starts for the popup's "start local
// service" button (Windows). It answers one request and exits; the work
// itself is `services.mjs serve`, which detaches the control service.
// stdout is the message channel, so nothing else may be written to it.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNativeMessageReader, encodeNativeMessage } from "./protocol.mjs";

const SERVICES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "services.mjs");
const START_TIMEOUT_MS = 30_000;

function reply(message) {
  process.stdout.write(encodeNativeMessage(message));
}

function startControlService() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVICES, "serve"], {
      cwd: path.dirname(SERVICES),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "local service did not start in time" });
    }, START_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: output.trim().split(/\r?\n/).slice(-5).join("\n") });
    });
  });
}

async function handle(message) {
  if (message?.type === "ping") return { ok: true };
  if (message?.type === "start-control-service") return startControlService();
  return { ok: false, error: `unknown request: ${message?.type}` };
}

const reader = createNativeMessageReader();
process.stdin.on("data", (chunk) => {
  for (const message of reader.feed(chunk)) {
    void handle(message).then((response) => {
      reply(response);
      process.exit(0);
    });
  }
});
