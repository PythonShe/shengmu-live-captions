import assert from "node:assert/strict";
import test from "node:test";

import { installChromeMock, waitFor } from "./helpers/chrome-mock.js";
import { installFakeIndexedDb } from "./helpers/fake-indexeddb.js";
import { startMockApi } from "./helpers/mock-translation-api.js";

// A recycled MV3 worker: the session, its rows and a pending stop reason are
// already in chrome.storage.session and the offscreen document is still
// capturing when the worker module loads again.

installFakeIndexedDb();
const mock = installChromeMock();
const api = await startMockApi({ respond: (segments) => segments.map((segment) => `译:${segment}`) });
const { createHistorySession, getHistoryLines, getHistorySession } = await import(
  "../extension/storage/history-db.js"
);
const { reduceTranscriptUpdate, rememberLine } = await import("../extension/lib/transcript-reducer.js");
const { createSessionLifecycle } = await import("../extension/background/session-lifecycle.js");

test.after(() => api.close());

const SESSION_ID = "restart-session";
const STARTED_AT = Date.now() - 60_000;
const TRANSLATED = "The first sentence was translated before the restart.";
const WAITING = "The second sentence was still waiting for its translation.";
const RAW_LINES = [
  { text: TRANSLATED, start: "0:00:01.00", end: "0:00:03.00", speaker: 1 },
  { text: WAITING, start: "0:00:04.00", end: "0:00:06.00", speaker: 1 }
];
const TRANSCRIPT = {
  sessionId: SESSION_ID,
  epochId: "epoch-1",
  epochStartedAt: STARTED_AT,
  data: { lines: RAW_LINES, buffer_transcription: "" }
};

function persistedState() {
  const base = {
    active: true,
    status: "capturing",
    detail: "正在采集",
    sessionId: SESSION_ID,
    tabId: 7,
    tabTitle: "Live",
    tabUrl: "https://example.com/live",
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    wsConnected: true,
    lineCount: 0,
    overlayError: "",
    current: { lines: [], bufferSource: "", bufferTranslation: "", translationError: "", epochId: null }
  };
  const { patch } = reduceTranscriptUpdate(base, TRANSCRIPT, {
    knownLines: new Map(),
    useApi: true,
    now: STARTED_AT + 6_000
  });
  const [first, second] = patch.current.lines;
  // The first row's translation landed, but the worker died inside the 700 ms
  // history debounce, so IndexedDB never saw either row.
  Object.assign(first, { translation: "译:第一句", translationPending: false });
  assert.equal(second.translationPending, true);
  return {
    ...base,
    ...patch,
    pendingStopDetail: "直播标签页已关闭",
    translation: { usage: { requests: 3, promptTokens: 30, completionTokens: 12 }, error: "" }
  };
}

mock.storage.local.settings = {
  translationMode: "api",
  translationProvider: "custom",
  translationBaseUrl: api.url,
  translationModel: "mock-translate",
  translationApiKeys: { custom: "secret-key" },
  glossaryEnabled: false,
  openPanelOnStart: false,
  overlayEnabled: false
};
mock.storage.session.runtimeState = persistedState();
mock.state.offscreenOpen = true;
await createHistorySession({ id: SESSION_ID, startedAt: STARTED_AT, title: "Live", status: "capturing" });
await import("../extension/background/service-worker.js");

async function getState() {
  return (await mock.sendToBackground({ target: "background", type: "get-state" })).state;
}

test("a restarted worker writes the persisted rows to history and translates the pending one once", async () => {
  const history = await waitFor(async () => {
    const lines = await getHistoryLines(SESSION_ID);
    return lines.length === 2 && lines.every((line) => line.translation) ? lines : null;
  }, { label: "recovered history" });

  const bySource = new Map(history.map((line) => [line.source, line]));
  assert.equal(bySource.get(TRANSLATED).translation, "译:第一句");
  assert.equal(bySource.get(WAITING).translation, `译:${WAITING}`);
  assert.deepEqual(api.requests.map((request) => request.segments), [[WAITING]]);

  const state = await getState();
  assert.equal(state.active, true);
  assert.equal(state.translation.usage.requests, 4);
  assert.equal(state.current.lines.every((line) => !line.translationPending), true);
});

test("after recovery the same transcript asks for nothing again and a stop keeps the persisted reason", async () => {
  await mock.sendFromOffscreen({ type: "transcript-update", ...TRANSCRIPT });
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  assert.equal(api.requests.length, 1);
  const lines = (await getState()).current.lines;
  assert.deepEqual(
    lines.map((line) => line.translation),
    ["译:第一句", `译:${WAITING}`]
  );

  // The offscreen document finishes the stop that started before the restart.
  await mock.sendFromOffscreen({
    type: "status-report",
    sessionId: SESSION_ID,
    status: { state: "stopped", detail: "采集已停止", wsConnected: false }
  });
  const state = await getState();
  assert.equal(state.active, false);
  assert.equal(state.status, "stopped");
  assert.equal(state.detail, "直播标签页已关闭");
  assert.equal(state.pendingStopDetail, "");
  const session = await getHistorySession(SESSION_ID);
  assert.equal(session.status, "stopped");
  assert.equal(session.lineCount, 2);
  assert.equal(session.translationMissing, 0);
});

test("recovery is idempotent: a second run re-records nothing", async () => {
  const { patch } = reduceTranscriptUpdate(
    { active: true, status: "capturing", sessionId: SESSION_ID, startedAt: STARTED_AT, current: {} },
    TRANSCRIPT,
    { knownLines: new Map(), useApi: true, now: STARTED_AT }
  );
  // Only the row whose translation landed before the restart is written; the
  // other one is still screen-only and waits for its own translation.
  patch.current.lines[0].translation = "译:第一句";
  patch.current.lines[0].translationPending = false;
  const recorded = [];
  const knownLines = new Map();
  const history = {
    knownLines,
    record(lines) {
      recorded.push(lines.map((line) => line.id));
      for (const line of lines) knownLines.set(line.id, rememberLine(line));
    },
    flush: async () => {}
  };
  let resumed = 0;
  const lifecycle = createSessionLifecycle({
    store: { state: { active: true, current: patch.current } },
    settings: { apiTranslationActive: () => true },
    views: { updateBadge: async () => {} },
    offscreen: { hasDocument: async () => true },
    history,
    scheduler: {
      resume() {
        resumed += 1;
      }
    },
    ready: async () => {}
  });

  await lifecycle.recover();
  await lifecycle.recover();
  assert.deepEqual(recorded, [[patch.current.lines[0].id]]);
  assert.equal(resumed, 2);
});
