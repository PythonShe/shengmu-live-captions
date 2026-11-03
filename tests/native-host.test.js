import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NATIVE_HOST_NAME,
  createNativeMessageReader,
  encodeNativeMessage,
  findUnpackedExtensionIds,
  hostManifest
} from "../scripts/native-host/protocol.mjs";

const ID_A = "abcdefghijklmnopabcdefghijklmnop";
const ID_B = "ponmlkjihgfedcbaponmlkjihgfedcba";

test("native messages round-trip through split and merged chunks", () => {
  const first = encodeNativeMessage({ type: "ping", text: "声幕" });
  const second = encodeNativeMessage({ ok: true });
  const reader = createNativeMessageReader();
  assert.deepEqual(reader.feed(first.subarray(0, 3)), []);
  assert.deepEqual(reader.feed(Buffer.concat([first.subarray(3), second.subarray(0, 6)])), [
    { type: "ping", text: "声幕" }
  ]);
  assert.deepEqual(reader.feed(second.subarray(6)), [{ ok: true }]);
  assert.equal(first.readUInt32LE(0), first.length - 4);
});

test("the installer finds unpacked ids by folder, case-insensitively on Windows", () => {
  const preferences = [
    {
      extensions: {
        settings: {
          [ID_A]: { path: "C:\\Users\\me\\shengmu\\extension\\" },
          [ID_B]: { path: "C:\\Users\\me\\other\\extension" },
          notanid: { path: "C:\\Users\\me\\shengmu\\extension" }
        }
      }
    },
    { extensions: { settings: { [ID_A]: { path: "c:/users/ME/shengmu/extension" } } } },
    null,
    {}
  ];
  assert.deepEqual(findUnpackedExtensionIds(preferences, "C:\\Users\\me\\shengmu\\extension", "win32"), [ID_A]);
  assert.deepEqual(
    findUnpackedExtensionIds([{ extensions: { settings: { [ID_A]: { path: "/Users/Me/x" } } } }], "/users/me/x", "darwin"),
    [],
    "POSIX paths stay case-sensitive"
  );
});

test("the host manifest allows exactly the found extensions", () => {
  assert.deepEqual(hostManifest({ hostPath: "C:\\h\\host.cmd", extensionIds: [ID_A] }), {
    name: NATIVE_HOST_NAME,
    description: "Shengmu Live Captions local service helper",
    path: "C:\\h\\host.cmd",
    type: "stdio",
    allowed_origins: [`chrome-extension://${ID_A}/`]
  });
});

test("the installer finds an extension loaded in Edge and registers both browsers", () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "shengmu-native-"));
  try {
    const extensionDir = fileURLToPath(new URL("../extension", import.meta.url));
    const profile = path.join(localAppData, "Microsoft", "Edge", "User Data", "Default");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, "Secure Preferences"),
      JSON.stringify({ extensions: { settings: { [ID_B]: { path: extensionDir } } } })
    );
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/native-host/install.mjs", import.meta.url)), "--dry-run"],
      { encoding: "utf8", env: { ...process.env, LOCALAPPDATA: localAppData } }
    );
    const plan = JSON.parse(output);
    assert.deepEqual(plan.manifest.allowed_origins, [`chrome-extension://${ID_B}/`]);
    assert.deepEqual(plan.registryKeys, [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
    ]);
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

test("the popup asks for the host the installer registers", () => {
  const popup = fs.readFileSync(new URL("../extension/popup/popup.js", import.meta.url), "utf8");
  assert.match(popup, new RegExp(`NATIVE_HOST_NAME = "${NATIVE_HOST_NAME.replace(/\./g, "\\.")}"`));
});

test("the host answers one framed request and exits", async () => {
  const host = spawn(process.execPath, [fileURLToPath(new URL("../scripts/native-host/host.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  const reader = createNativeMessageReader();
  const replies = [];
  host.stdout.on("data", (chunk) => replies.push(...reader.feed(chunk)));
  host.stdin.write(encodeNativeMessage({ type: "ping" }));
  const code = await new Promise((resolve) => {
    host.on("exit", resolve);
  });
  assert.equal(code, 0);
  assert.deepEqual(replies, [{ ok: true }]);
});

test("the node floor compares numerically, not as text", async () => {
  const { MIN_NODE_VERSION, nodeVersionSupported } = await import("../scripts/require-node.mjs");
  assert.equal(nodeVersionSupported(`v${MIN_NODE_VERSION}`), true);
  assert.equal(nodeVersionSupported("v24.22.1"), false);
  assert.equal(nodeVersionSupported("v24.9.0"), false);
  assert.equal(nodeVersionSupported("v22.30.0"), false);
  assert.equal(nodeVersionSupported("v26.1.0"), true);
  assert.equal(nodeVersionSupported(process.version), true, "CI and dev machines must meet the floor");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, `>=${MIN_NODE_VERSION}`);
});
