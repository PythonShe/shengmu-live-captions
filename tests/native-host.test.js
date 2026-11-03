import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
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
