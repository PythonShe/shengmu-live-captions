import assert from "node:assert/strict";
import test from "node:test";

import {
  TRANSLATION_LINE_CONCURRENCY,
  TRANSLATION_LINE_DEBOUNCE_MS,
  TRANSLATION_LINE_RETRY_DELAYS_MS,
  createTranslationScheduler,
  shouldRetryTranslationError
} from "../extension/lib/translation-scheduler.js";
import { TranslationApiError } from "../extension/lib/translation-api.js";
import { reduceTranscriptUpdate } from "../extension/lib/transcript-reducer.js";
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

function setup({ lines = [], bufferSource = "", auto = null, config = {}, random = () => 0 } = {}) {
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
  assert.equal(history[0].signature, `Um, ${LONG}\u0000译甲\u00000`);
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

test("a row that grew while its request was in flight keeps the answer as a stage translation", async () => {
  const { clock, translator, state, history, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  // The recogniser appended a few words: not enough to make the answer wrong,
  // and not enough to spend another request yet (see shouldRetranslateLine).
  // The appended words form a complete short sentence, so the batch planner
  // does not hold the row as a trailing fragment.
  state.current.lines[0].source = `${LONG} Nice.`;
  state.current.lines[0].translationPending = true;
  translator.calls[0].resolve({ translations: ["旧译文"] });
  await settleAsync();

  assert.equal(state.current.lines[0].translation, "旧译文");
  assert.equal(state.current.lines[0].translationPending, true, "the row is still behind");
  assert.deepEqual(history, [], "a stage translation is screen-only");
  assert.equal(translator.calls.length, 1, "the newer source is held by the throttle");
  assert.equal(scheduler.inspect().wakeTimer, true);

  // The wake timer re-runs the queue even though no new ASR update arrives.
  await clock.advance(400);
  await clock.advance(0);
  assert.equal(translator.calls.length, 2);
  translator.calls[1].resolve({ translations: ["新译文"] });
  await settleAsync();
  assert.equal(state.current.lines[0].translation, "新译文");
  assert.equal(state.current.lines[0].translationPending, false);
  assert.equal(history.at(-1).translation, "新译文");
});

test("an ASR update during a request does not pass the old answer off as final", async () => {
  const { clock, translator, state, history, knownLines, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  assert.deepEqual(translator.calls[0].texts, [LONG]);

  // handleTranscriptUpdate runs scheduleLines after every ASR update, so the
  // queue sees the grown row before the response comes back.
  const grown = `${LONG} And it keeps going with a clause nobody translated.`;
  state.current.lines[0].source = grown;
  state.current.lines[0].translationPending = true;
  scheduler.scheduleLines();
  translator.calls[0].resolve({ translations: ["short"] });
  await settleAsync();

  const line = state.current.lines[0];
  assert.equal(line.translation, "short", "still shown as a stage translation");
  assert.equal(line.translatedSource, LONG, "it translates what was sent, not the grown row");
  assert.equal(line.translationPending, true);
  assert.equal(knownLines.get("a").translatedSource, LONG);
  assert.deepEqual(history, [], "a stage translation is screen-only");

  await clock.advance(400);
  await clock.advance(0);
  assert.deepEqual(translator.calls[1]?.texts, [grown], "the grown row is translated in full");
  translator.calls[1].resolve({ translations: ["full"] });
  await settleAsync();
  assert.equal(line.translation, "full");
  assert.equal(line.translatedSource, grown);
  assert.equal(line.translationPending, false);
  assert.equal(history.at(-1).translation, "full");
});

test("a batch split in flight still sends the text of the original request", async () => {
  const { clock, translator, state, scheduler } = setup({
    lines: [row("a", LONG), row("b", `${LONG} Second.`)]
  });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  const [first] = translator.calls;
  state.current.lines[0].source = `${LONG} Grown while the batch was out.`;
  state.current.lines[0].translationPending = true;
  scheduler.scheduleLines();
  first.reject(new TranslationApiError("wrong count", { code: "count_mismatch" }));
  await settleAsync();
  assert.deepEqual(translator.calls[1]?.texts, [LONG], "the half repeats what was asked");
});

test("a worker that runs out of rounds on a growing row hands it on", async () => {
  const { clock, translator, state, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  // No ASR update after the last response, so nothing but the worker can
  // notice that the row is still behind.
  let rounds = 0;
  while (translator.calls.length > rounds && scheduler.inspect().lineWorkers > 0) {
    state.current.lines[0].source += " And a few more words arrive.";
    state.current.lines[0].translationPending = true;
    translator.calls[rounds].resolve({ translations: [`stage ${rounds}`] });
    rounds += 1;
    await settleAsync();
  }
  assert.equal(state.current.lines[0].translationPending, true);

  await clock.advance(1000);
  const last = translator.calls.at(-1);
  assert.equal(translator.calls.length, rounds + 1, "a new worker takes the row");
  assert.deepEqual(last.texts, [state.current.lines[0].source]);
  last.resolve({ translations: ["final"] });
  await settleAsync();
  assert.equal(state.current.lines[0].translation, "final");
  assert.equal(state.current.lines[0].translationPending, false);
});

test("a fallback that matches the grown row finishes it when the request fails", async () => {
  const { clock, translator, state, history, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);

  const grown = `${LONG} And it keeps going with a clause nobody translated.`;
  const line = state.current.lines[0];
  line.source = grown;
  line.translationPending = true;
  line.fallbackTranslation = "完整兜底";
  scheduler.scheduleLines();
  translator.calls[0].reject(codedError("bad key", "auth"));
  await settleAsync();

  assert.equal(line.translation, "完整兜底");
  assert.equal(line.translatedSource, grown);
  assert.equal(line.translationPending, false);
  assert.equal(line.translationFallback, true);
  assert.equal(history.at(-1).translation, "完整兜底");
  await clock.advance(1000);
  assert.equal(translator.calls.length, 1, "the fallback covers the row, so no request is spent");
});

test("a fallback for the shorter text does not finish a row that grew", async () => {
  const { clock, translator, state, history, scheduler } = setup({
    lines: [row("a", LONG, { fallbackTranslation: "旧兜底" })]
  });
  scheduler.scheduleLines(50);

  // Grown before the request leaves, and the worker has no fallback for it yet.
  const grown = `${LONG} And it keeps going with a clause nobody translated.`;
  const line = state.current.lines[0];
  line.source = grown;
  line.fallbackTranslation = "";
  scheduler.scheduleLines(50);
  await clock.advance(50);
  assert.deepEqual(translator.calls[0].texts, [grown]);
  translator.calls[0].reject(codedError("bad key", "auth"));
  await settleAsync();

  assert.equal(line.translation, "旧兜底", "shown as a stage translation");
  assert.equal(line.translatedSource, LONG);
  assert.equal(line.translationPending, true);
  assert.deepEqual(history, [], "it does not reach the history as final");
});

// One ASR update through the real reducer, the way handleTranscriptUpdate runs it.
async function asrFrame({ clock, state, knownLines, scheduler }, text) {
  const next = reduceTranscriptUpdate(
    state,
    {
      sessionId: "s1",
      epochId: "e1",
      epochStartedAt: 1000,
      data: { lines: [{ text, start: "0:00:01.00", end: "0:00:02.00" }] }
    },
    { knownLines, useApi: true, now: clock.now() }
  );
  Object.assign(state, next.patch);
  scheduler.scheduleLines();
  await clock.advance(500);
}

async function failStageRow(rig, grown) {
  await asrFrame(rig, LONG);
  rig.translator.calls[0].resolve({ translations: ["stage"] });
  await settleAsync();
  await asrFrame(rig, grown);
  rig.translator.calls[1].reject(codedError("bad key", "auth"));
  await settleAsync();
}

test("a permanent failure on a stage row stops requests until the settings change", async () => {
  const rig = setup();
  const grown = `${LONG} And it keeps going with a clause nobody translated.`;
  await failStageRow(rig, grown);

  for (let frame = 0; frame < 5; frame += 1) await asrFrame(rig, grown);
  assert.equal(rig.translator.calls.length, 2, "identical frames send nothing");
  const failed = rig.state.current.lines[0];
  assert.equal(failed.translation, "stage", "the stage translation stays on screen");
  assert.equal(failed.translationFailed, true);
  assert.equal(failed.translationPending, false);
  assert.equal(rig.state.current.displayCaption.pending, false, "nothing is on its way");

  rig.scheduler.handleConfigChanged();
  await rig.clock.advance(500);
  assert.deepEqual(rig.translator.calls[2]?.texts, [grown], "a new key gets a new attempt");
  rig.translator.calls[2].resolve({ translations: ["full"] });
  await settleAsync();
  const fixed = rig.state.current.lines[0];
  assert.equal(fixed.translation, "full");
  assert.equal(fixed.translationFailed, false);
  assert.equal(fixed.translationPending, false);
  assert.equal(rig.history.at(-1).translation, "full");
});

test("a stage row that failed gets one new attempt when it grows", async () => {
  const rig = setup();
  const grown = `${LONG} And it keeps going with a clause nobody translated.`;
  await failStageRow(rig, grown);

  const longer = `${grown} Then one more clause arrives.`;
  await asrFrame(rig, longer);
  assert.equal(rig.state.current.lines[0].translationFailed, false);
  assert.equal(rig.state.current.lines[0].translationPending, true);
  assert.deepEqual(rig.translator.calls[2]?.texts, [longer]);
  rig.translator.calls[2].reject(codedError("bad key", "auth"));
  await settleAsync();

  await asrFrame(rig, longer);
  assert.equal(rig.translator.calls.length, 3);
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

test("a Retry-After holds back the line queue until the cooldown ends", async () => {
  const { clock, translator, scheduler } = setup({ lines: [row("a", LONG)] });
  scheduler.scheduleLines(0);
  await clock.advance(0);
  translator.calls[0].reject(
    new TranslationApiError("slow down", { code: "rate_limit", status: 429, retryAfterMs: 5000 })
  );
  await settleAsync();
  assert.equal(scheduler.inspect().cooldownMs, 5000);
  await clock.advance(TRANSLATION_LINE_RETRY_DELAYS_MS[0]);
  assert.equal(translator.calls.length, 1, "the retry does not jump the cooldown");
  await clock.advance(5000 - TRANSLATION_LINE_RETRY_DELAYS_MS[0]);
  assert.ok(translator.calls.length >= 2, "requests resume once the cooldown ends");
});
