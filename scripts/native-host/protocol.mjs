// Chrome native messaging: each message is UTF-8 JSON behind a 32-bit length
// in native byte order (little-endian on every platform Chrome ships on).
import path from "node:path";

export const NATIVE_HOST_NAME = "com.shengmu.live_captions";
// Chrome caps host-to-extension messages at 1 MB.
const MAX_OUTGOING_BYTES = 1024 * 1024;

/** @param {unknown} message */
export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_OUTGOING_BYTES) throw new Error("native message too large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Splits a byte stream into decoded messages; feed() returns the complete ones. */
export function createNativeMessageReader() {
  let pending = Buffer.alloc(0);
  return {
    /** @param {Buffer} chunk */
    feed(chunk) {
      pending = Buffer.concat([pending, chunk]);
      const messages = [];
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (pending.length < 4 + length) break;
        messages.push(JSON.parse(pending.subarray(4, 4 + length).toString("utf8")));
        pending = pending.subarray(4 + length);
      }
      return messages;
    }
  };
}

function samePath(left, right, platform) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value)).replace(/[\\/]+$/, "");
    return platform === "win32" ? resolved.replace(/\//g, "\\").toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * Ids of the unpacked extensions loaded from `extensionDir`, read from the
 * parsed (Secure) Preferences files of Chrome profiles. An unpacked id derives
 * from its folder, so it differs per machine and the installer must look it up.
 * @param {any[]} preferences
 * @param {string} extensionDir
 * @param {string} [platform]
 */
export function findUnpackedExtensionIds(preferences, extensionDir, platform = process.platform) {
  const ids = new Set();
  for (const prefs of preferences) {
    const settings = prefs?.extensions?.settings;
    if (!settings || typeof settings !== "object") continue;
    for (const [id, entry] of Object.entries(settings)) {
      if (/^[a-p]{32}$/.test(id) && entry?.path && samePath(entry.path, extensionDir, platform)) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * @param {{ hostPath: string, extensionIds: string[] }} options
 */
export function hostManifest({ hostPath, extensionIds }) {
  return {
    name: NATIVE_HOST_NAME,
    description: "Shengmu Live Captions local service helper",
    path: hostPath,
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`)
  };
}
