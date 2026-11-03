import assert from "node:assert/strict";
import test from "node:test";

import { installChromeMock, waitFor } from "./helpers/chrome-mock.js";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb.js";
import { deferred, startMockApi } from "./helpers/mock-translation-api.js";

// Drives the real worker through runtime messages: a popup starts and stops
// the capture, the "offscreen document" reports transcripts, and a local mock
// API translates. History lands in an in-memory IndexedDB.

installFakeIndexedDb();
const mock = installChromeMock();
const api = await startMockApi();
await import("../extension/background/service-worker.js");
const { getHistoryLines, getHistorySession } = await import("../extension/storage/history-db.js");

test.after(() => api.close());

const OVERLAY_DETAIL = "页面浮层不可用，可在字幕窗口中继续观看";

async function getState() {
  const response = await mock.sendToBackground({ target: "background", type: "get-state" });
  return response.state;
}

async function configureApi(extra = {}) {
  const response = await mock.sendToBackground({
    target: "background",
    type: "save-settings",
    settings: {
      translationMode: "api",
      translationProvider: "custom",
      translationBaseUrl: api.url,
      translationModel: "mock-translate",
      translationApiKeys: { custom: "secret-key" },
      glossaryEnabled: false,
      openPanelOnStart: false,
      ...extra
    }
  });
  assert.equal(response.ok, true, response.error);
}

async function startSession() {
  const response = await mock.sendToBackground({
    target: "background",
    type: "start-capture",
    targetTabId: 7,
    streamId: "stream-1",
    tabTitle: "Live",
    tabUrl: "https://example.com/live"
  });
  assert.equal(response.ok, true, response.error);
  return response.sessionId;
}

function sendTranscript(sessionId, lines, { epochId = "epoch-1", buffer = "" } = {}) {
  return mock.sendFromOffscreen({
    type: "transcript-update",
    sessionId,
    epochId,
    epochStartedAt: Date.now(),
    data: { lines, buffer_transcription: buffer }
  });
}

function line(text, start, end) {
  return { text, start, end, speaker: 1 };
}

test("API mode strips fillers from the prompt, polishes the reply and keeps the source verbatim", async () => {
  await configureApi();
  api.control.respond = (segments) => segments.map((segment) => `嗯，译:${segment}`);
  api.requests.length = 0;
  const sessionId = await startSession();

  await sendTranscript(sessionId, [line("Um, hello world, this is the opening sentence.", "0:00:01.00", "0:00:02.50")]);
  const state = await waitFor(async () => {
    const value = await getState();
    return value.current.lines[0]?.translation ? value : null;
  }, { label: "line translation" });

  assert.deepEqual(api.requests[0].segments, ["Hello world, this is the opening sentence."]);
  const [runtimeLine] = state.current.lines;
  assert.equal(runtimeLine.source, "Um, hello world, this is the opening sentence.");
  assert.equal(runtimeLine.translation, "译:Hello world, this is the opening sentence.");
  assert.equal(runtimeLine.translationPending, false);
  assert.equal(state.current.displayCaption.translation, "译:Hello world, this is the opening sentence.");
  assert.equal(state.translation.usage.requests, 1);

  // The overlay received the translated caption through caption-state.
  const lastCaption = mock.contentMessages("caption-state").at(-1).message;
  assert.equal(lastCaption.payload.current.lines[0].translation, "译:Hello world, this is the opening sentence.");
  assert.equal("customGlossary" in lastCaption.settings, false);

  const stopped = await mock.sendToBackground({ target: "background", type: "stop-capture" });
  assert.equal(stopped.ok, true);
  const [historyLine] = await getHistoryLines(sessionId);
  assert.equal(historyLine.source, "Um, hello world, this is the opening sentence.");
  assert.equal(historyLine.translation, "译:Hello world, this is the opening sentence.");
  const session = await getHistorySession(sessionId);
  assert.equal(session.status, "stopped");
  assert.equal(session.lineCount, 1);
  assert.equal(session.translationMissing, 0);
});

test("API mode merges ASR fragments into one translated row", async () => {
  await configureApi();
  api.control.respond = (segments) => segments.map((segment) => `译:${segment}`);
  api.requests.length = 0;
  const sessionId = await startSession();

  await sendTranscript(sessionId, [
    line("We went to the shop and", "0:00:01.00", "0:00:02.00"),
    line("bought some bread.", "0:00:02.20", "0:00:03.00")
  ]);
  const state = await waitFor(async () => {
    const value = await getState();
    return value.current.lines[0]?.translation ? value : null;
  }, { label: "merged translation" });
  assert.equal(state.current.lines.length, 1);
  assert.equal(state.current.lines[0].source, "We went to the shop and bought some bread.");
  assert.deepEqual(api.requests[0].segments, ["We went to the shop and bought some bread."]);

  await mock.sendToBackground({ target: "background", type: "stop-capture" });
  const history = await getHistoryLines(sessionId);
  assert.equal(history.length, 1);
});

test("overlay failures are recorded and cleared exactly once", async (t) => {
  t.mock.method(console, "warn", () => {});
  await configureApi();
  const failure = new Error("Cannot access contents of the page");
  mock.hooks.executeScript = async () => {
    throw failure;
  };
  const statusBefore = mock.broadcasts("status").length;
  const sessionId = await startSession();

  let state = await getState();
  assert.equal(state.overlayError, failure.message);
  assert.equal(state.detail, OVERLAY_DETAIL);
  assert.equal(mock.broadcasts("status").length, statusBefore + 1);

  // The same failure again is not news: no second broadcast.
  const retry = await mock.sendToBackground({ target: "background", type: "refresh-overlay" });
  assert.equal(retry.ok, false);
  assert.equal(retry.error, failure.message);
  assert.equal(mock.broadcasts("status").length, statusBefore + 1);

  mock.hooks.executeScript = async () => {};
  const recovered = await mock.sendToBackground({ target: "background", type: "refresh-overlay" });
  assert.equal(recovered.ok, true);
  state = await getState();
  assert.equal(state.overlayError, "");
  assert.notEqual(state.detail, OVERLAY_DETAIL);
  assert.equal(mock.broadcasts("status").length, statusBefore + 2);

  const again = await mock.sendToBackground({ target: "background", type: "refresh-overlay" });
  assert.equal(again.ok, true);
  assert.equal(mock.broadcasts("status").length, statusBefore + 2);

  // A failure while the overlay answers init with ok:false is recorded too.
  mock.hooks.tabMessage = async (tabId, message) =>
    message?.type === "init" ? { ok: false, error: "init rejected" } : undefined;
  const rejected = await mock.sendToBackground({ target: "background", type: "refresh-overlay" });
  assert.equal(rejected.ok, false);
  assert.equal((await getState()).overlayError, "init rejected");

  // content-ready from the captured tab means the overlay recovered on its own.
  mock.hooks.tabMessage = async () => undefined;
  await mock.sendToBackground(
    { target: "background", type: "content-ready" },
    { url: "https://example.com/live", tab: { id: 7 } }
  );
  assert.equal((await getState()).overlayError, "");

  await mock.sendToBackground({ target: "background", type: "stop-capture" });
  state = await getState();
  assert.equal(state.overlayError, "");
  assert.equal(state.active, false);
  assert.ok(sessionId);
});

test("finalize runs once for concurrent stops and waits for the in-flight translation", async () => {
  await configureApi();
  api.control.respond = (segments) => segments.map((segment) => `译:${segment}`);
  api.requests.length = 0;
  const gate = deferred();
  api.control.gate = gate.promise;
  const sessionId = await startSession();
  const endedBefore = mock.broadcasts("session-ended").length;

  await sendTranscript(sessionId, [line("The final sentence arrives late.", "0:00:01.00", "0:00:02.00")]);
  await waitFor(() => api.requests.length === 1, { label: "request in flight" });

  const stops = [
    mock.sendToBackground({ target: "background", type: "stop-capture" }),
    mock.sendToBackground({ target: "background", type: "stop-capture" }),
    mock.sendFromOffscreen({
      type: "status-report",
      sessionId,
      status: { state: "stopped", detail: "采集已停止", wsConnected: false }
    })
  ];
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
  assert.equal((await getState()).active, true, "finalize must wait for the translation");
  api.control.gate = null;
  gate.resolve();
  const results = await Promise.all(stops);
  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);

  assert.equal(mock.broadcasts("session-ended").length, endedBefore + 1);
  const state = await getState();
  assert.equal(state.active, false);
  assert.equal(state.status, "stopped");
  const [historyLine] = await getHistoryLines(sessionId);
  assert.equal(historyLine.translation, "译:The final sentence arrives late.");
  const session = await getHistorySession(sessionId);
  assert.equal(session.status, "stopped");
  assert.equal(session.translationMissing, 0);
});

test("a stop that arrives after the session ended does not finalize it again", async () => {
  await configureApi();
  const sessionId = await startSession();
  await mock.sendFromOffscreen({
    type: "status-report",
    sessionId,
    status: { state: "error", fatal: true, detail: "WLK crashed", wsConnected: false }
  });
  const ended = await getHistorySession(sessionId);
  assert.equal(ended.status, "error");
  const endedBroadcasts = mock.broadcasts("session-ended").length;

  // A view that still shows the session as active sends a late stop.
  const lateStop = await mock.sendToBackground({ target: "background", type: "stop-capture" });
  assert.equal(lateStop.ok, true);
  assert.equal(mock.broadcasts("session-ended").length, endedBroadcasts);
  const after = await getHistorySession(sessionId);
  assert.equal(after.status, "error");
  assert.equal(after.endedAt, ended.endedAt);
  const state = await getState();
  assert.equal(state.status, "error");
  assert.equal(state.detail, "WLK crashed");
  // The stray capture, if any, was still told to stop.
  assert.equal(mock.sent.at(-1).type, "stop-capture");
});
