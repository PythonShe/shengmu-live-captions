// Port of Start-DevBrowser.ps1 / Load-DevExtension.ps1: start (or reuse) a
// Chrome with a dedicated dev profile and remote debugging, then load the
// unpacked extension into it over CDP.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, findOnPath, pathFor } from "./local-service/config.mjs";
import { loadUnpackedExtension } from "./load-extension.mjs";

export function chromeCandidates({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = pathFor(platform);
  const candidates = [env.CHROME_PATH];
  if (platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
      if (base) candidates.push(p.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    const bundle = p.join("Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    candidates.push(p.join("/Applications", bundle), p.join(home, "Applications", bundle));
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return candidates.filter(Boolean);
}

export function findChrome({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const found = chromeCandidates({ env, platform }).find((candidate) => exists(candidate));
  if (found) return found;
  if (platform === "linux") {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      const onPath = findOnPath(name, { env, platform, exists });
      if (onPath) return onPath;
    }
  }
  throw new Error("Google Chrome was not found; set CHROME_PATH.");
}

export async function devToolsVersion(port, timeoutMs = 2000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export function devBrowserArgs({ port, profileDir, url }) {
  return [
    `--remote-debugging-port=${port}`,
    // Extensions.loadUnpacked over CDP is refused without it.
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    url
  ];
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function loadDevExtension({ port = 9223, extensionPath = path.join(REPO_ROOT, "extension") } = {}) {
  const resolved = fs.realpathSync(extensionPath);
  const version = await devToolsVersion(port, 5000);
  if (!version) {
    throw new Error(`Chrome DevTools endpoint is unavailable on port ${port}. Start Chrome with remote debugging first.`);
  }
  return loadUnpackedExtension(version.webSocketDebuggerUrl, resolved);
}

/**
 * Starts the dev Chrome unless one already answers on `port`; with a running
 * one, opens `url` as a new tab instead. Then (re)loads the extension.
 */
export async function startDevBrowser({
  port = 9223,
  profileDir = path.join(REPO_ROOT, "chrome-profile"),
  url = "about:blank",
  extensionPath,
  log = () => {}
} = {}) {
  const profile = path.resolve(profileDir);
  fs.mkdirSync(profile, { recursive: true });
  let chromePid = null;
  if (!(await devToolsVersion(port))) {
    const chrome = findChrome();
    const child = spawn(chrome, devBrowserArgs({ port, profileDir: profile, url }), {
      detached: true,
      stdio: "ignore"
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    chromePid = child.pid;
    log(`Started Chrome (PID ${chromePid}) with profile ${profile}`);
    const deadline = Date.now() + 30_000;
    while (!(await devToolsVersion(port)) && Date.now() < deadline) await sleep(500);
    if (!(await devToolsVersion(port))) {
      throw new Error(`Chrome did not expose DevTools on port ${port}. Close other Chrome instances using ${profile} and retry.`);
    }
  } else if (url && url !== "about:blank") {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: "PUT" });
    if (!response.ok) throw new Error(`Chrome refused to open ${url}: HTTP ${response.status}`);
  }
  const extension = await loadDevExtension({ port, extensionPath });
  return { chromePid, devToolsPort: port, profileDir: profile, extension };
}
