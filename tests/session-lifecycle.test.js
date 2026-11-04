import assert from "node:assert/strict";
import test from "node:test";

import { createSessionLifecycle } from "../extension/background/session-lifecycle.js";
import { rememberLine } from "../extension/lib/transcript-reducer.js";
import { deferred } from "./helpers/mock-translation-api.js";

// The lifecycle against stub collaborators, so a test can hold finalize at an
// exact step (settling, final flush) and send a transcript into that window.

const SESSION_ID = "s1";
const STARTED_AT = 1_700_000_000_000;

function transcript(...texts) {
  return {
    sessionId: SESSION_ID,
    epochId: "e1",
    epochStartedAt: STARTED_AT,
    data: {
      lines: texts.map((text, index) => ({
        text,
        start: `0:00:0${index * 2 + 1}.00`,
        end: `0:00:0${index * 2 + 2}.00`,
        speaker: 1
      })),
      buffer_transcription: ""
    }
  };
}

function harness() {
  const calls = [];
  const recorded = [];
  const gates = { settle: deferred(), finalFlush: deferred() };
  const knownLines = new Map();
  const store = {
    state: {
      active: true,
      status: "capturing",
      detail: "正在接收实时转写",
      sessionId: SESSION_ID,
      startedAt: STARTED_AT,
      lineCount: 0,
      current: { lines: [], bufferSource: "", bufferTranslation: "", translationError: "", epochId: null }
    },
    persist: async () => {}
  };
  const history = {
    knownLines,
    record(lines) {
      for (const line of lines) {
        recorded.push(line.source);
        knownLines.set(line.id, rememberLine(line));
      }
    },
    async flush(force) {
      if (!force) return;
      calls.push("final-flush");
      await gates.finalFlush.promise;
    },
    summarize: async () => ({ lineCount: knownLines.size, translationMissing: 0, preview: "" }),
    updateSession: async (sessionId, patch) => {
      calls.push(`session:${patch.status}:${patch.lineCount}`);
    }
  };
  const scheduler = {
    lastError: "",
    async settle() {
      calls.push("settle");
      await gates.settle.promise;
    },
    invalidate: () => calls.push("invalidate"),
    reset: () => calls.push("reset"),
    refreshSummary() {},
    scheduleLines: () => calls.push("schedule-lines")
  };
  const lifecycle = createSessionLifecycle({
    store,
    settings: {
      current: {},
      translationConfig: () => ({ mode: "api", enabled: true }),
      apiTranslationActive: () => true
    },
    views: {
      updateBadge: async () => {},
      broadcastToExtension: async () => {},
      broadcastCaptionState: async () => {},
      notifyHistoryChanged: async () => {}
    },
    offscreen: { hasDocument: async () => true, stopCapture: async () => {} },
    history,
    scheduler,
    ready: async () => {}
  });
  return { calls, recorded, gates, store, lifecycle };
}

async function until(probe) {
  for (let round = 0; round < 50 && !probe(); round += 1) {
    await new Promise(setImmediate);
  }
  assert.ok(probe(), "condition never became true");
}

test("outside a stop, an untranslated transcript only schedules line translation", async () => {
  const { calls, recorded, store, lifecycle } = harness();
  await lifecycle.handleTranscriptUpdate(transcript("The first sentence is complete."));
  // A row is screen-only until a translation lands on it, so history waits.
  assert.deepEqual(recorded, []);
  assert.deepEqual(calls, ["schedule-lines"]);
  assert.equal(store.state.current.lines[0].translationPending, true);
});

test("finalize counts a transcript that lands while it settles and drops one after the seal", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { calls, recorded, gates, store, lifecycle } = harness();
  const finalizing = lifecycle.finalize("stopped", "标签页音频采集已停止");
  await until(() => calls.includes("settle"));

  // Still settling: the row is not written yet (it has no translation) and no
  // timer is armed; settle drives the remaining translations.
  await lifecycle.handleTranscriptUpdate(transcript("The first sentence is complete."));
  assert.deepEqual(recorded, []);
  assert.deepEqual(calls, ["settle"]);

  gates.settle.resolve();
  await until(() => calls.includes("final-flush"));
  // Whatever is on screen when the session ends is committed as the final
  // version of that row, so the summary and the SRT export see it.
  assert.deepEqual(recorded, ["The first sentence is complete."]);
  assert.deepEqual(calls, ["settle", "invalidate", "final-flush"]);

  // Sealed: the summary is being computed, so this update is dropped.
  const late = await lifecycle.handleTranscriptUpdate(
    transcript("The first sentence is complete.", "A second sentence arrives too late.")
  );
  assert.deepEqual(late, { dropped: "history-sealed" });
  assert.deepEqual(recorded, ["The first sentence is complete."]);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[1].reason, "history-sealed");

  gates.finalFlush.resolve();
  await finalizing;
  assert.deepEqual(calls, ["settle", "invalidate", "final-flush", "session:stopped:1", "reset"]);
  assert.equal(store.state.active, false);
  assert.equal(store.state.lineCount, 1);

  // A new session is not sealed by the previous finalize: its rows are new and
  // untranslated, so they are screen-only until the scheduler lands Chinese.
  Object.assign(store.state, { active: true, status: "capturing" });
  await lifecycle.handleTranscriptUpdate(transcript("The first sentence is complete.", "A new session speaks."));
  assert.deepEqual(recorded, ["The first sentence is complete."]);
  assert.equal(warn.mock.callCount(), 1);
});

test("a start that fails before the capture removes the bailian auth rule", async () => {
  const auth = [];
  const lifecycle = createSessionLifecycle({
    store: { state: { active: false }, persist: async () => {} },
    settings: {
      current: { wsUrl: "ws://127.0.0.1:8010/asr" },
      update: async () => {},
      translationConfig: () => ({ mode: "api", model: "m", provider: "custom", enabled: true }),
      sessionAsr: () => ({ backend: "bailian", url: "wss://dashscope.aliyuncs.com/api-ws/v1/inference", context: "" }),
      bailianApiKey: () => "sk"
    },
    views: {},
    offscreen: { hasDocument: async () => false },
    history: {
      resetSession() {},
      createSession: async () => {
        throw new Error("IndexedDB is gone");
      }
    },
    scheduler: { reset() {} },
    ready: async () => {},
    asrAuth: {
      grant: async () => auth.push("grant"),
      revoke: async () => auth.push("revoke")
    }
  });
  await assert.rejects(lifecycle.start({ targetTabId: 1, streamId: "x" }), /IndexedDB is gone/);
  assert.deepEqual(auth, ["grant", "revoke"]);
});
