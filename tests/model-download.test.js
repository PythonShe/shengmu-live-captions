import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureProxyFromEnv,
  discardStalePart,
  downloadToFile,
  probeTotalBytes
} from "../scripts/local-service/download.mjs";

const PAYLOAD = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 251));

/**
 * A tiny file server with knobs for the failure modes curl used to absorb:
 * ignoring Range, lying in HEAD, transient 503s, and stalling.
 */
async function fileServer(t, { ignoreRange = false, headLength, failFirst = 0, headStatus = 200, stallAfter } = {}) {
  const seen = { ranges: [], gets: 0 };
  let failures = failFirst;
  const server = http.createServer((req, res) => {
    if (req.url !== "/model.gguf") {
      res.writeHead(404);
      return res.end();
    }
    if (req.method === "HEAD") {
      res.writeHead(headStatus, { "content-length": headLength ?? PAYLOAD.length });
      return res.end();
    }
    seen.gets += 1;
    seen.ranges.push(req.headers.range || null);
    if (failures > 0) {
      failures -= 1;
      res.writeHead(503);
      return res.end();
    }
    const match = /^bytes=(\d+)-$/.exec(req.headers.range || "");
    if (match && !ignoreRange) {
      const start = Number(match[1]);
      res.writeHead(206, {
        "content-length": PAYLOAD.length - start,
        "content-range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`
      });
      return res.end(PAYLOAD.subarray(start));
    }
    res.writeHead(200, { "content-length": PAYLOAD.length });
    if (stallAfter != null) {
      res.write(PAYLOAD.subarray(0, stallAfter));
      return undefined;
    }
    return res.end(PAYLOAD);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}/model.gguf`, seen };
}

function tempTarget(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shengmu-download-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "model.gguf");
}

test("downloads into .part and renames once the size matches", async (t) => {
  const { url } = await fileServer(t);
  const target = tempTarget(t);
  const total = await probeTotalBytes(url);
  assert.equal(total, PAYLOAD.length);
  const result = await downloadToFile({ url, targetPath: target, totalBytes: total });
  assert.equal(result.bytes, PAYLOAD.length);
  assert.deepEqual(fs.readFileSync(target), PAYLOAD);
  assert.equal(fs.existsSync(`${target}.part`), false);
});

test("resumes a partial .part with a Range request", async (t) => {
  const { url, seen } = await fileServer(t);
  const target = tempTarget(t);
  fs.writeFileSync(`${target}.part`, PAYLOAD.subarray(0, 1000));
  await downloadToFile({ url, targetPath: target, totalBytes: PAYLOAD.length });
  assert.deepEqual(seen.ranges, ["bytes=1000-"]);
  assert.deepEqual(fs.readFileSync(target), PAYLOAD);
});

test("a .part at or past the total is discarded instead of looping on 416", async (t) => {
  const { url, seen } = await fileServer(t);
  const target = tempTarget(t);
  fs.writeFileSync(`${target}.part`, Buffer.alloc(PAYLOAD.length + 10));
  await downloadToFile({ url, targetPath: target, totalBytes: PAYLOAD.length });
  assert.deepEqual(seen.ranges, [null]);
  assert.deepEqual(fs.readFileSync(target), PAYLOAD);
});

test("an unknown total never wipes a resumable .part", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shengmu-download-"));
  const part = path.join(dir, "x.part");
  fs.writeFileSync(part, Buffer.alloc(100));
  assert.equal(discardStalePart(part, 0), false);
  assert.equal(fs.statSync(part).size, 100);
  assert.equal(discardStalePart(part, 100), true);
  assert.equal(fs.existsSync(part), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a size mismatch keeps the .part and refuses the rename", async (t) => {
  const { url } = await fileServer(t, { headLength: PAYLOAD.length + 5 });
  const target = tempTarget(t);
  const total = await probeTotalBytes(url);
  await assert.rejects(downloadToFile({ url, targetPath: target, totalBytes: total }), {
    code: "size-mismatch",
    expected: PAYLOAD.length + 5,
    actual: PAYLOAD.length
  });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.statSync(`${target}.part`).size, PAYLOAD.length);
});

test("a failed HEAD falls back to the size the GET reports", async (t) => {
  const { url } = await fileServer(t, { headStatus: 405 });
  const target = tempTarget(t);
  assert.equal(await probeTotalBytes(url), 0);
  fs.writeFileSync(`${target}.part`, PAYLOAD.subarray(0, 500));
  await downloadToFile({ url, targetPath: target, totalBytes: 0 });
  assert.deepEqual(fs.readFileSync(target), PAYLOAD);
});

test("a server that ignores Range restarts the file from zero", async (t) => {
  const { url } = await fileServer(t, { ignoreRange: true });
  const target = tempTarget(t);
  fs.writeFileSync(`${target}.part`, Buffer.alloc(1000, 0xff));
  await downloadToFile({ url, targetPath: target, totalBytes: PAYLOAD.length });
  assert.deepEqual(fs.readFileSync(target), PAYLOAD);
});

test("transient 503s are retried, permanent errors are not", async (t) => {
  const flaky = await fileServer(t, { failFirst: 2 });
  const target = tempTarget(t);
  await downloadToFile({ url: flaky.url, targetPath: target, totalBytes: PAYLOAD.length, retryDelayMs: 10 });
  assert.equal(flaky.seen.gets, 3);

  const missing = tempTarget(t);
  await assert.rejects(
    downloadToFile({ url: flaky.url.replace("model.gguf", "nope.gguf"), targetPath: missing, retryDelayMs: 10 }),
    { code: "http", status: 404 }
  );
});

test("a stalled transfer is cut and resumed, an abort keeps the .part", async (t) => {
  const stalled = await fileServer(t, { stallAfter: 2048, ignoreRange: true });
  const target = tempTarget(t);
  await assert.rejects(
    downloadToFile({ url: stalled.url, targetPath: target, totalBytes: PAYLOAD.length, retries: 1, retryDelayMs: 10, idleTimeoutMs: 150 }),
    { code: "stalled" }
  );
  assert.equal(stalled.seen.gets, 2);
  assert.equal(fs.statSync(`${target}.part`).size, 2048);

  const controller = new AbortController();
  const run = downloadToFile({ url: stalled.url, targetPath: target, totalBytes: PAYLOAD.length, signal: controller.signal, idleTimeoutMs: 5000 });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, { name: "AbortError" });
  assert.ok(fs.existsSync(`${target}.part`));
});

test("proxy settings reach fetch with loopback always bypassed", () => {
  const calls = [];
  const capture = (env) => calls.push(env);
  assert.equal(configureProxyFromEnv({}, capture).enabled, false);
  assert.equal(calls.length, 0);

  const result = configureProxyFromEnv({ HTTPS_PROXY: "http://proxy:7890", NO_PROXY: "corp.example" }, capture);
  assert.equal(result.enabled, true);
  assert.equal(calls[0].HTTPS_PROXY, "http://proxy:7890");
  assert.deepEqual(calls[0].NO_PROXY.split(","), ["corp.example", "127.0.0.1", "localhost", "::1", "[::1]"]);
  assert.equal(calls[0].no_proxy, calls[0].NO_PROXY);

  configureProxyFromEnv({ HTTPS_PROXY: "http://proxy:7890", SHENGMU_DOWNLOAD_NO_PROXY: "1" }, capture);
  assert.deepEqual(calls[1], {});
  assert.match(configureProxyFromEnv({ HTTPS_PROXY: "http://p:1" }, null).reason, /24\.14/);
});
