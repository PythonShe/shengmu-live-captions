// One-time Windows setup for the popup's "start local service" button:
// registers the native messaging host that runs `services.mjs serve`.
// Double-click install-windows.cmd in the repo root, or run
//   node scripts/native-host/install.mjs [--extension-id ID] [--uninstall] [--dry-run]
import "../require-node.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { NATIVE_HOST_NAME, findUnpackedExtensionIds, hostManifest } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, "..", "..", "extension");
const HOST_SCRIPT = path.join(HERE, "host.mjs");
// Each browser reads its own registry key and keeps its own profiles. Both
// keys are always written: an unpacked extension's ID derives from its
// folder, so it is the same in Chrome and Edge.
const BROWSERS = [
  {
    registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    userData: ["Chrome", "Chrome Beta", "Chrome Dev", "Chrome SxS"].map((channel) => path.join("Google", channel, "User Data"))
  },
  {
    registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    userData: ["Edge", "Edge Beta", "Edge Dev", "Edge SxS"].map((channel) => path.join("Microsoft", channel, "User Data"))
  }
];
const REGISTRY_KEYS = BROWSERS.map((browser) => browser.registryKey);

const { values } = parseArgs({
  options: {
    "extension-id": { type: "string", multiple: true },
    uninstall: { type: "boolean" },
    "dry-run": { type: "boolean" }
  }
});
const dryRun = Boolean(values["dry-run"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "win32" && !dryRun) {
  fail("本地助手目前只支持 Windows。");
}
const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
const installDir = path.join(localAppData, "Shengmu", "native-host");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Parsed Preferences of every profile of every installed Chrome and Edge channel. */
function browserPreferences() {
  const found = [];
  for (const relative of BROWSERS.flatMap((browser) => browser.userData)) {
    const userData = path.join(localAppData, relative);
    let profiles;
    try {
      profiles = fs.readdirSync(userData, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const profile of profiles) {
      for (const name of ["Secure Preferences", "Preferences"]) {
        const prefs = readJson(path.join(userData, profile.name, name));
        if (prefs) found.push(prefs);
      }
    }
  }
  return found;
}

if (values.uninstall) {
  if (!dryRun) {
    for (const key of REGISTRY_KEYS) {
      try {
        execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
      } catch {
        // Already gone, or that browser was never registered.
      }
    }
    fs.rmSync(installDir, { recursive: true, force: true });
  }
  console.log("已移除声幕本地助手。");
  process.exit(0);
}

const extensionIds = [
  ...new Set([...(values["extension-id"] || []), ...findUnpackedExtensionIds(browserPreferences(), EXTENSION_DIR)])
];
const invalid = extensionIds.filter((id) => !/^[a-p]{32}$/.test(id));
if (invalid.length > 0) fail(`扩展 ID 格式不对：${invalid.join(", ")}`);
if (extensionIds.length === 0) {
  fail(
    [
      "没有在 Chrome 或 Edge 里找到从这个目录加载的声幕扩展：",
      `  ${EXTENSION_DIR}`,
      "请先在 chrome://extensions（Edge 为 edge://extensions）打开开发者模式，点“加载已解压的扩展程序”选中上面的文件夹，再运行一次。",
      "刚加载完扩展时浏览器可能还没写入配置，关闭浏览器后再运行一次即可。",
      "也可以用 --extension-id <ID> 直接指定扩展 ID。"
    ].join("\n")
  );
}

const hostPath = path.join(installDir, "shengmu-host.cmd");
const manifestPath = path.join(installDir, `${NATIVE_HOST_NAME}.json`);
// The absolute node path: Chrome starts the host with its own environment,
// where node may not be on PATH.
const launcher = `@echo off\r\n"${process.execPath}" "${HOST_SCRIPT}" %*\r\n`;
const manifest = hostManifest({ hostPath, extensionIds });

if (dryRun) {
  console.log(JSON.stringify({ registryKeys: REGISTRY_KEYS, manifestPath, manifest, launcher }, null, 2));
  process.exit(0);
}

fs.mkdirSync(installDir, { recursive: true });
fs.writeFileSync(hostPath, launcher);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
for (const key of REGISTRY_KEYS) {
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "ignore" });
}
console.log(
  [
    "声幕本地助手已安装。",
    `扩展：${extensionIds.join(", ")}`,
    "现在可以在 Chrome 或 Edge 的扩展弹窗里点“启动控制服务”，不需要再开终端。",
    "扩展目录移动位置后需要重新运行一次。"
  ].join("\n")
);
