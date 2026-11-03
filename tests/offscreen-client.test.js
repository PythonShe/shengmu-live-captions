import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { OFFSCREEN_URL, createOffscreenClient } from "../extension/background/offscreen-client.js";

function fakeBrowser({ open = false, onCreate = async () => {} } = {}) {
  const events = [];
  const state = { open };
  const runtime = {
    getURL: (path) => `chrome-extension://test/${path}`,
    getContexts: async () => (state.open ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
    sendMessage: async (message) => {
      events.push(`send:${message.type}`);
      return { ok: true };
    }
  };
  const offscreen = {
    createDocument: async (options) => {
      events.push(`create:${options.url}`);
      await onCreate();
      state.open = true;
    }
  };
  return { events, state, runtime, offscreen };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("the first message waits for the document to report ready", async () => {
  const browser = fakeBrowser();
  const client = createOffscreenClient({ ...browser, readyTimeoutMs: 1000 });
  const sending = client.send({ type: "start-capture" });
  await wait(30);
  assert.deepEqual(browser.events, [`create:${OFFSCREEN_URL}`]);
  browser.events.push("ready");
  client.markReady();
  assert.deepEqual(await sending, { ok: true });
  assert.deepEqual(browser.events, [`create:${OFFSCREEN_URL}`, "ready", "send:start-capture"]);
});

test("a ready report that beats the create promise is not missed", async () => {
  const holder = {};
  const browser = fakeBrowser({
    onCreate: async () => {
      holder.client.markReady();
    }
  });
  const client = createOffscreenClient({ ...browser, readyTimeoutMs: 1000 });
  holder.client = client;
  const startedAt = Date.now();
  await client.send({ type: "start-capture" });
  assert.ok(Date.now() - startedAt < 500, "must not wait for the timeout");
});

test("without a ready report the client falls back after the timeout and still sends", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const browser = fakeBrowser();
  const client = createOffscreenClient({ ...browser, readyTimeoutMs: 40 });
  await client.send({ type: "start-capture" });
  assert.deepEqual(browser.events, [`create:${OFFSCREEN_URL}`, "send:start-capture"]);
  assert.equal(warn.mock.callCount(), 1);
  // A late report after the fallback is harmless.
  client.markReady();
});

test("an existing document is reused and concurrent callers share one creation", async () => {
  const existing = fakeBrowser({ open: true });
  const reused = createOffscreenClient({ ...existing, readyTimeoutMs: 1000 });
  await reused.ensureDocument();
  assert.deepEqual(existing.events, []);

  const fresh = fakeBrowser();
  const client = createOffscreenClient({ ...fresh, readyTimeoutMs: 1000 });
  const both = Promise.all([client.ensureDocument(), client.ensureDocument()]);
  await wait(10);
  client.markReady();
  await both;
  assert.deepEqual(fresh.events, [`create:${OFFSCREEN_URL}`]);
});

test("a failed creation rejects without leaving a waiter behind", async () => {
  let fail = true;
  const browser = fakeBrowser({
    onCreate: async () => {
      if (fail) throw new Error("Only a single offscreen document may be created.");
    }
  });
  const client = createOffscreenClient({ ...browser, readyTimeoutMs: 1000 });
  await assert.rejects(client.ensureDocument(), /single offscreen document/);
  fail = false;
  const retry = client.ensureDocument();
  await wait(10);
  client.markReady();
  await retry;
  assert.equal(browser.state.open, true);
});

test("offscreen.js reports ready only after its message listener is registered", () => {
  const events = [];
  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: async (message) => {
        events.push(`send:${message.type}:${message.source}:${message.target}`);
      },
      onMessage: {
        addListener: () => events.push("listener")
      }
    }
  };
  const source = fs.readFileSync(new URL("../extension/offscreen/offscreen.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { chrome, console, setTimeout, clearTimeout, Promise }, { filename: "offscreen.js" });
  assert.deepEqual(events, ["listener", "send:offscreen-ready:offscreen:background"]);
});
