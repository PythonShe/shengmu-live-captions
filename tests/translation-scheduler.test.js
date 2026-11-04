import assert from "node:assert/strict";
import test from "node:test";

import {
  TRANSLATION_BUFFER_DEBOUNCE_MS,
  TRANSLATION_BUFFER_MIN_INTERVAL_MS,
  TRANSLATION_LINE_CONCURRENCY,
  TRANSLATION_LINE_DEBOUNCE_MS,
  TRANSLATION_LINE_RETRY_DELAYS_MS,
  createTranslationScheduler,
  shouldRetryTranslationError
} from "../extension/lib/translation-scheduler.js";
import { TranslationApiError } from "../extension/lib/translation-api.js";
import { createFakeClock, settleAsync } from "./helpers/fake-clock.js";

const LONG = "This sentence is long enough to never be held as a fragment.";

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

// A translateTexts stand-in: every call stays pending until the test answers
// it, unless `auto` maps the texts straight to a reply.
function createTranslator({ auto = null } = {}) {
  const calls = [];
  const translate = (options) =>
    new Promise((resolve, reject) => {
      const call = { ...options, resolve, reject };
      calls.push(call);
      if (auto) resolve(auto(options));
    });
  return { calls, translate };
}

function row(id, source, extra = {}) {
  return { id, source, translation: "", translationPending: true, ...extra };
}

function setup({ lines = [], bufferSource = "", auto = null, config = {}, partial = true, random = () => 0 } = {}) {
  const clock = createFakeClock();
  const translator = createTranslator({ auto });
  const state = {
    active: true,
    current: { lines, bufferSource, bufferTranslation: "", translationError: "" }
  };
  const settings = {
    mode: "api",
    enabled: true,
    provider: "custom",
    providerLabel: "Custom",
    model: "mock",
    ...config
  };
  const knownLines = new Map();
  const history = [];
  const published = [];
  const scheduler = createTranslationScheduler({
    getState: () => state,
    getConfig: () => settings,
    partialEnabled: () => partial,
    translateTexts: translator.translate,
    knownLines,
    enqueueHistory: (batch) => history.push(...batch),
    publish: (change) => {
      published.push(change);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    random
  });
  return { clock, translator, state, settings, knownLines, history, published, scheduler };
}

test("completed rows debounce, batch together and leave their own ids out of the context", async () => {
  const { clock, translator, state, history, published, scheduler } = setup({
    lines: [
      { id: "old", source: "An earlier sentence that was already translated.", translation: "早先的句子。" },
      row("a", `Um, ${LONG}`),
      row("b", LONG)
    ]
  });

  scheduler.scheduleLines();
  await clock.advance(TRANSLATION_LINE_DEBOUNCE_MS - 1);
  assert.equal(translator.calls.length, 0);
  await clock.advance(1);
  assert.equal(translator.calls.length, 1);

  const [call] = translator.calls;
  assert.deepEqual(call.texts, [LONG, LONG], "fillers are stripped from the prompt only");
  assert.deepEqual(
    call.context.map((item) => item.source),
    ["An earlier sentence that was already translated."]
  );
  call.resolve({ translations: ["嗯，译甲", "译乙"], usage: { promptTokens: 4, completionTokens: 2 } });
  await settleAsync();

  assert.equal(state.current.lines[1].source, `Um, ${LONG}`);
  assert.equal(state.current.lines[1].translation, "译甲", "polishTranslation ran");
  assert.equal(state.current.lines[2].translation, "译乙");
  assert.deepEqual(history.map((line) => line.id), ["a", "b"]);
  assert.equal(history[0].signature, `Um, ${LONG}\u0000译甲`);
  assert.deepEqual(published.at(-1), { reason: "lines", lineIds: ["a", "b"] });
  assert.deepEqual(scheduler.usage, {
    requests: 1,
    promptTokens: 4,
    completionTokens: 2,
    billedCharacters: 0
  });
  assert.equal(state.translation.usage.requests, 1);
  assert.equal(scheduler.inspect().pending.size, 0);
});

test("retryable failures back off, then fall back to the server translation", async () => {
  const { clock, translator, state, scheduler } = setup({
    lines: [row("a", LONG, { fallbackTranslation: "服务端译文" })]
  });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  translator.calls[0].reject(codedError("timeout", "timeout"));
  await settleAsync();
  assert.equal(scheduler.lastError, "timeout");
  assert.equal(state.current.translationError, "timeout");
  assert.equal(clock.nextTimerIn(), TRANSLATION_LINE_RETRY_DELAYS_MS[0]);

  await clock.advance(TRANSLATION_LINE_RETRY_DELAYS_MS[0]);
  assert.equal(translator.calls.length, 2);
  translator.calls[1].reject(codedError("timeout", "timeout"));
  await settleAsync();
  assert.equal(clock.nextTimerIn(), TRANSLATION_LINE_RETRY_DELAYS_MS[1]);

  await clock.advance(TRANSLATION_LINE_RETRY_DELAYS_MS[1]);
  translator.calls[2].reject(codedError("timeout", "timeout"));
  await settleAsync();
  assert.equal(translator.calls.length, 3, "three attempts at most");
  assert.equal(state.current.lines[0].translation, "服务端译文");
  assert.equal(state.current.lines[0].translationFallback, true);
  assert.equal(scheduler.inspect().pending.size, 0);
});

test("a non-retryable failure marks the row failed at once and never re-queues it", async () => {
  const { clock, translator, state, history, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  translator.calls[0].reject(codedError("bad key", "auth"));
  await settleAsync();

  assert.equal(state.current.lines[0].translationFailed, true);
  assert.equal(state.current.lines[0].translationPending, false);
  assert.equal(history.at(-1).translationFailed, true);
  assert.equal(scheduler.inspect().retryTimer, false);

  scheduler.scheduleLines(0);
  await clock.advance(1000);
  assert.equal(translator.calls.length, 1, "the failed source is not sent again");
  assert.equal(shouldRetryTranslationError({ code: "auth" }), false);
  assert.equal(shouldRetryTranslationError({ code: "network" }), true);
});

test("a row that grew while its request was in flight is retranslated with the new source", async () => {
  const { clock, translator, state, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  state.current.lines[0] = row("a", `${LONG} And it kept going.`);
  translator.calls[0].resolve({ translations: ["旧译文"] });
  await settleAsync();

  assert.equal(translator.calls.length, 2);
  assert.deepEqual(translator.calls[1].texts, [`${LONG} And it kept going.`]);
  translator.calls[1].resolve({ translations: ["新译文"] });
  await settleAsync();
  assert.equal(state.current.lines[0].translation, "新译文");
});

test("reset discards a response that arrives for the previous generation", async () => {
  const { clock, translator, state, history, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  const [call] = translator.calls;
  scheduler.reset();
  assert.equal(call.signal.aborted, true);
  call.resolve({ translations: ["迟到的译文"] });
  await settleAsync();
  assert.equal(state.current.lines[0].translation, "");
  assert.equal(history.length, 0);
});

test("a row that finishes while a request runs gets its own request, up to the concurrency limit", async () => {
  assert.equal(TRANSLATION_LINE_CONCURRENCY, 2);
  const { clock, translator, state, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines();
  await clock.advance(TRANSLATION_LINE_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 1);

  state.current.lines.push(row("b", `Second: ${LONG}`));
  scheduler.scheduleLines();
  await clock.advance(TRANSLATION_LINE_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 2, "b does not wait behind a");
  assert.deepEqual(translator.calls[1].texts, [`Second: ${LONG}`]);
  assert.equal(scheduler.inspect().lineWorkers, 2);

  state.current.lines.push(row("c", `Third: ${LONG}`));
  scheduler.scheduleLines();
  await clock.advance(TRANSLATION_LINE_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 2, "c waits for a free slot");

  // b answers first; its worker then picks up c.
  translator.calls[1].resolve({ translations: ["译乙"] });
  await settleAsync();
  assert.equal(state.current.lines[1].translation, "译乙");
  assert.equal(translator.calls.length, 3);
  assert.deepEqual(translator.calls[2].texts, [`Third: ${LONG}`]);
  translator.calls[0].resolve({ translations: ["译甲"] });
  translator.calls[2].resolve({ translations: ["译丙"] });
  await settleAsync();
  assert.deepEqual(state.current.lines.map((line) => line.translation), ["译甲", "译乙", "译丙"]);
  assert.equal(scheduler.inspect().lineWorkers, 0);
});

test("a row the buffer request already translated takes that translation without a request", async () => {
  const spoken = "the boss drops a divine orb when you kill it fast";
  const { clock, translator, state, scheduler } = setup({ bufferSource: spoken });
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_BUFFER_DEBOUNCE_MS);
  translator.calls[0].resolve({ translations: ["快速击杀首领会掉落神圣石"] });
  await settleAsync();

  // The speaker paused: the half-sentence is committed (Chrome capitalizes it).
  state.current.bufferSource = "";
  state.current.lines.push(row("a", "The boss drops a Divine Orb when you kill it fast."));
  scheduler.scheduleLines();
  await settleAsync();
  assert.equal(state.current.lines[0].translation, "快速击杀首领会掉落神圣石");
  assert.equal(state.current.lines[0].translationPending, false);
  await clock.advance(TRANSLATION_LINE_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 1, "no line request was sent");
  assert.equal(scheduler.inspect().prefetchHits, 1);
});

test("a buffer translation that lands while the row is in flight shows first, then the full one wins", async () => {
  const spoken = "now the searing exarch is a little different";
  const { clock, translator, state, scheduler } = setup({ bufferSource: spoken });
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_BUFFER_DEBOUNCE_MS);
  const bufferCall = translator.calls[0];

  state.current.bufferSource = "";
  scheduler.abortStaleBuffer();
  assert.equal(bufferCall.signal.aborted, false, "the committed half-sentence keeps its request");
  state.current.lines.push(row("a", spoken));
  scheduler.scheduleLines();
  await clock.advance(TRANSLATION_LINE_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 2, "the row went out before the buffer answer");
  const lineCall = translator.calls[1];

  bufferCall.resolve({ translations: ["焚界者有点不同"] });
  await settleAsync();
  assert.equal(state.current.lines[0].translation, "焚界者有点不同");

  lineCall.resolve({ translations: ["现在焚界者有点不一样"] });
  await settleAsync();
  assert.equal(state.current.lines[0].translation, "现在焚界者有点不一样");
  assert.equal(state.current.lines[0].translationFailed, false);
});

test("the buffer request debounces, keeps a minimum interval and yields to a line backlog", async () => {
  const { clock, translator, state, scheduler } = setup({
    lines: [row("a", LONG), row("b", LONG), row("c", LONG)],
    bufferSource: "and then the streamer"
  });
  // Three queued rows are a backlog above the limit: the buffer waits.
  scheduler.scheduleLines(10_000);
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_BUFFER_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 0);
  assert.equal(scheduler.inspect().bufferTimer, true);

  state.current.lines = [];
  scheduler.reset({ keepUsage: true });
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_BUFFER_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 1);
  assert.equal(translator.calls[0].partial, true);
  translator.calls[0].resolve({ translations: ["嗯，然后主播"] });
  await settleAsync();
  assert.equal(state.current.bufferTranslation, "然后主播");

  state.current.bufferSource = "and then the streamer opened the map";
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_BUFFER_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 1, "the min interval is not over yet");
  await clock.advance(TRANSLATION_BUFFER_MIN_INTERVAL_MS - TRANSLATION_BUFFER_DEBOUNCE_MS);
  assert.equal(translator.calls.length, 2);
});

// Regression for ca4c2bf: an aborted buffer request that settles late must not
// clear the in-flight slot that a newer request already owns.
test("only the owning buffer request clears the in-flight slot", async () => {
  const { clock, translator, state, scheduler } = setup({ bufferSource: "the first half" });
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_BUFFER_DEBOUNCE_MS);
  const first = translator.calls[0];

  state.current.bufferSource = "the first half keeps growing";
  scheduler.abortStaleBuffer();
  assert.equal(first.signal.aborted, true);
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_BUFFER_MIN_INTERVAL_MS);
  assert.equal(translator.calls.length, 2);
  const second = translator.calls[1];
  assert.equal(scheduler.inspect().bufferInFlight, true);

  // The first request only now reports its abort.
  first.reject(abortError());
  await settleAsync();
  assert.equal(scheduler.inspect().bufferInFlight, true, "the newer request still owns the slot");

  // A stale-buffer abort must still reach the request that owns the slot,
  // and no third request may start while the second is in flight.
  state.current.bufferSource = "the first half keeps growing and growing";
  scheduler.abortStaleBuffer();
  assert.equal(second.signal.aborted, true);
  second.reject(abortError());
  await settleAsync();
  assert.equal(translator.calls.length, 2);
});

test("settle waits for the line queue, then aborts at the deadline and marks leftovers failed", async () => {
  const { clock, translator, state, scheduler } = setup({ lines: [row("a", LONG)] });
  let settled = false;
  const done = scheduler.settle(2500).then(() => {
    settled = true;
  });
  await settleAsync();
  assert.equal(translator.calls.length, 1, "settle flushes immediately");
  await clock.advance(2400);
  assert.equal(settled, false);
  // The poll loop overshoots the deadline by one step (to 2520 ms), then the
  // in-flight request gets a 1200 ms grace before it is aborted.
  await clock.advance(1300);
  assert.equal(translator.calls[0].signal.aborted, false);
  await clock.advance(100);
  assert.equal(translator.calls[0].signal.aborted, true);
  translator.calls[0].reject(abortError());
  await clock.advance(600);
  await done;
  assert.equal(settled, true);
  assert.equal(state.current.lines[0].translationFailed, true);
});

test("settle without an enabled API applies the server fallbacks", async () => {
  const { state, scheduler, settings, translator } = setup({
    lines: [row("a", LONG, { fallbackTranslation: "服务端" })]
  });
  scheduler.scheduleLines(10_000);
  settings.enabled = false;
  await scheduler.settle();
  assert.equal(translator.calls.length, 0);
  assert.equal(state.current.lines[0].translation, "服务端");
});

test("restore and config changes reset the error and requeue failed rows", async () => {
  const { clock, translator, state, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.restore({ usage: { requests: 3, promptTokens: "9", completionTokens: 1 }, error: "old" });
  assert.deepEqual(scheduler.usage, {
    requests: 3,
    promptTokens: 9,
    completionTokens: 1,
    billedCharacters: 0
  });
  assert.equal(scheduler.lastError, "old");

  scheduler.scheduleLines(0);
  await clock.advance(0);
  translator.calls[0].reject(codedError("bad key", "auth"));
  await settleAsync();
  assert.equal(state.current.lines[0].translationFailed, true);

  // translationFailed is a row flag the reducer clears on the next update.
  state.current.lines[0] = row("a", LONG);
  scheduler.handleConfigChanged();
  assert.equal(scheduler.lastError, "");
  await clock.advance(0);
  assert.equal(translator.calls.length, 2, "the new config gets another try");
});

test("a batch-shape failure is retried in halves without spending an attempt", async () => {
  const { clock, translator, state, scheduler } = setup({
    lines: [row("a", `A: ${LONG}`), row("b", `B: ${LONG}`), row("c", `C: ${LONG}`), row("d", `D: ${LONG}`)]
  });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  assert.equal(translator.calls[0].texts.length, 4);
  translator.calls[0].reject(new TranslationApiError("count", { code: "count_mismatch" }));
  await settleAsync();
  assert.equal(translator.calls.length, 2);
  assert.equal(translator.calls[1].texts.length, 2);
  translator.calls[1].resolve({ translations: ["甲", "乙"] });
  await settleAsync();
  assert.equal(translator.calls.length, 3);
  // The second half sees the first half's fresh translations as context.
  assert.deepEqual(translator.calls[2].context.map((item) => item.translation), ["甲", "乙"]);
  translator.calls[2].resolve({ translations: ["丙", "丁"] });
  await settleAsync();
  assert.deepEqual(state.current.lines.map((line) => line.translation), ["甲", "乙", "丙", "丁"]);
  assert.equal(scheduler.inspect().pending.size, 0);
  assert.equal(scheduler.usage.requests, 2);
});

test("a single row that still fails after splitting goes through the normal retry delay", async () => {
  const { clock, translator, state, scheduler } = setup({
    lines: [row("a", `A: ${LONG}`), row("b", `B: ${LONG}`)]
  });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  translator.calls[0].reject(new TranslationApiError("parse", { code: "parse_error" }));
  await settleAsync();
  translator.calls[1].reject(new TranslationApiError("parse", { code: "parse_error" }));
  await settleAsync();
  assert.equal(translator.calls.length, 3, "the second half still goes out");
  translator.calls[2].resolve({ translations: ["乙"] });
  await settleAsync();
  assert.equal(state.current.lines[1].translation, "乙");
  assert.equal(scheduler.inspect().pending.get("a").attempts, 1);
  assert.equal(scheduler.inspect().retryTimer, true);
  await clock.advance(TRANSLATION_LINE_RETRY_DELAYS_MS[0] - 1);
  assert.equal(translator.calls.length, 3, "no immediate re-request past the retry delay");
  await clock.advance(1);
  assert.equal(translator.calls.length, 4);
  assert.deepEqual(translator.calls[3].texts, [`A: ${LONG}`]);
});

test("a Retry-After from one stream holds back both streams", async () => {
  const { clock, translator, scheduler } = setup({
    lines: [row("a", LONG)],
    bufferSource: "and the buffer keeps talking about the next thing"
  });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  translator.calls[0].reject(
    new TranslationApiError("slow down", { code: "rate_limit", status: 429, retryAfterMs: 5000 })
  );
  await settleAsync();
  assert.equal(scheduler.inspect().cooldownMs, 5000);
  scheduler.scheduleBuffer();
  await clock.advance(TRANSLATION_LINE_RETRY_DELAYS_MS[0]);
  await clock.advance(TRANSLATION_BUFFER_MIN_INTERVAL_MS);
  assert.equal(translator.calls.length, 1, "neither the line retry nor the buffer jumps the cooldown");
  await clock.advance(5000 - TRANSLATION_LINE_RETRY_DELAYS_MS[0] - TRANSLATION_BUFFER_MIN_INTERVAL_MS);
  assert.ok(translator.calls.length >= 2, "requests resume once the cooldown ends");
});
