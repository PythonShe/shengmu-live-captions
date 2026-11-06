import assert from "node:assert/strict";
import test from "node:test";

import {
  BAILIAN_CONTEXT_MAX_CHARS,
  bailianErrorDetail,
  bailianInferenceUrl,
  bailianRunTask,
  createLineAccumulator,
  formatTimecode,
  parseBailianEvent,
  speechPhrases
} from "../extension/lib/asr-sessions.js";
import { SEGMENT_MAX_CHARS } from "../extension/lib/caption-segment.js";
import { parseTimecode } from "../extension/lib/caption-utils.js";
import { reduceTranscriptUpdate, rememberLine } from "../extension/lib/transcript-reducer.js";
import { renderZh } from "./helpers/i18n.js";

test("formatTimecode round-trips through the reducer's parser", () => {
  assert.equal(formatTimecode(0), "0:00:00.00");
  assert.equal(formatTimecode(61.237), "0:01:01.24");
  assert.equal(formatTimecode(3725.5), "1:02:05.50");
  for (const seconds of [0.01, 9.99, 59.994, 3599.99, 7322.4]) {
    assert.ok(Math.abs(parseTimecode(formatTimecode(seconds)) - seconds) <= 0.005, String(seconds));
  }
});

test("the accumulator keeps starts strictly increasing, windows rows and clears the buffer on a final", () => {
  const lines = createLineAccumulator({ limit: 2 });
  lines.interim("hello wor");
  assert.equal(lines.message().buffer_transcription, "hello wor");
  assert.equal(lines.final("this first complete sentence is long enough.", 1, 2), true);
  assert.equal(lines.message().buffer_transcription, "");
  assert.equal(lines.final("  ", 3, 4), false);
  lines.final("this complete sentence starts at the same time.", 1, 1.5);
  lines.final("this complete sentence comes a good while later.", 5, 6);
  const { lines: rows } = lines.message();
  assert.deepEqual(rows.map((row) => row.text), [
    "this complete sentence starts at the same time.",
    "this complete sentence comes a good while later."
  ]);
  assert.equal(rows[0].start, "0:00:01.01", "a repeated start moves past the previous one");
  assert.equal(rows[0].end, "0:00:01.50");
});

test("a full window never cuts through a sentence the reducer merged", () => {
  const accumulator = createLineAccumulator({ limit: 6 });
  const knownLines = new Map();
  const state = { startedAt: 1000, current: { lines: [] } };
  // Records history on every update, as the worker does.
  const update = () => {
    const next = reduceTranscriptUpdate(
      state,
      { data: accumulator.message(), sessionId: "s", epochId: "e", epochStartedAt: 1000 },
      { knownLines, useApi: true, now: 1 }
    );
    state.current = next.patch.current;
    for (const line of next.historyLines) knownLines.set(line.id, rememberLine(line));
  };
  // Every pair is one sentence in two rows: a trailing "the" leaves it open.
  for (let index = 0; index < 20; index += 1) {
    accumulator.final(`so in part ${index} we are going to check out the`, index * 4, index * 4 + 1);
    update();
    accumulator.final(`boss arena number ${index} and see what it drops today.`, index * 4 + 1, index * 4 + 2);
    update();
  }
  // Untranslated rows are screen-only, so the window itself is the proof: no
  // row in it is a half sentence the merge should have joined.
  const sources = state.current.lines.map((line) => line.source);
  assert.ok(sources.length > 0);
  for (const source of sources) {
    assert.match(
      source,
      /we are going to check out the boss arena number \d+ and see what it drops today\.$/,
      source
    );
  }
  assert.ok(accumulator.message().lines.length <= 6);
});

test("noise rows never hold a full window open", () => {
  const accumulator = createLineAccumulator({ limit: 4 });
  for (let index = 0; index < 50; index += 1) accumulator.final("...", index, index + 0.5);
  assert.ok(accumulator.message().lines.length <= 4);
});

test("speechPhrases keeps the primary English spelling once, in priority order", () => {
  assert.deepEqual(
    speechPhrases([
      { sources: ["Searing Exarch", "Searing Exark"] },
      { source: "Maven|Mayven" },
      { sources: ["searing exarch"] },
      { sources: ["流放之路"] },
      { sources: [""] }
    ]),
    ["Searing Exarch", "Maven"]
  );
});

test("bailian frames follow the fun-asr-realtime duplex protocol", () => {
  assert.equal(bailianInferenceUrl("cn"), "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
  assert.equal(bailianInferenceUrl("intl"), "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference");
  assert.equal(bailianInferenceUrl("moon"), bailianInferenceUrl("cn"));
  const run = bailianRunTask({ taskId: "t1", context: "x".repeat(500) });
  assert.deepEqual(run.header, { action: "run-task", task_id: "t1", streaming: "duplex" });
  assert.equal(run.payload.parameters.sample_rate, 16000);
  assert.equal(run.payload.input.context[0].content[0].text.length, BAILIAN_CONTEXT_MAX_CHARS);
  assert.deepEqual(bailianRunTask({ taskId: "t2" }).payload.input, {});
});

test("parseBailianEvent maps server events and skips heartbeats", () => {
  const frame = (header, payload) => JSON.stringify({ header, payload });
  assert.deepEqual(parseBailianEvent(frame({ event: "task-started" })), { kind: "started" });
  assert.deepEqual(parseBailianEvent(frame({ event: "task-finished" })), { kind: "finished" });
  assert.deepEqual(
    parseBailianEvent(frame({ event: "task-failed", error_code: "InvalidApiKey", error_message: "no" })),
    { kind: "failed", code: "InvalidApiKey", message: "no" }
  );
  assert.deepEqual(
    parseBailianEvent(frame({ event: "result-generated" }, {
      output: { sentence: { text: "hi", begin_time: 1500, end_time: null, sentence_end: false } }
    })),
    { kind: "sentence", text: "hi", beginSeconds: 1.5, endSeconds: null, final: false }
  );
  assert.equal(
    parseBailianEvent(frame({ event: "result-generated" }, { output: { sentence: { heartbeat: true } } })).kind,
    "ignored"
  );
  assert.equal(parseBailianEvent("not json").kind, "failed");
  assert.match(renderZh(bailianErrorDetail("InvalidApiKey", "x")), /API Key 无效/);
  assert.match(renderZh(bailianErrorDetail("Other", "boom")), /Other.*boom/);
  assert.match(renderZh(parseBailianEvent("not json").message), /无法解析/);
  assert.match(
    renderZh(parseBailianEvent(frame({ event: "task-failed" })).message),
    /任务失败/,
    "a failure without a server message still says what failed"
  );
});

test("a full window never repeats a sentence that a split row's piece joined", () => {
  // The last piece of the long row is too short to stand alone, so the next row
  // joins it. Dropping the long row alone would repeat that next row under a new id.
  const accumulator = createLineAccumulator({ limit: 3 });
  const long = `${"A long first sentence that goes on for a good while and then stops right there. ".repeat(3).trim()} Okay.`;
  const state = { startedAt: 1, sessionId: "s", current: { lines: [] } };
  const texts = new Map();
  const feed = () => {
    const { patch } = reduceTranscriptUpdate(
      state,
      { data: accumulator.message(), sessionId: "s", epochId: "e", epochStartedAt: 1 },
      { knownLines: new Map(), useApi: true, now: 1 }
    );
    Object.assign(state, patch);
    for (const row of state.current.lines) texts.set(row.id, row.source);
  };

  accumulator.final(long, 0, 20);
  accumulator.final("And this row follows it closely here.", 20.5, 22);
  feed();
  accumulator.final("Number three is a complete row on its own here.", 23, 25);
  accumulator.final("Number four is a complete row on its own here.", 26, 28);
  feed();
  accumulator.final("Number five is a complete row on its own here.", 29, 31);
  feed();

  const holding = [...texts.values()].filter((text) => text.includes("this row follows"));
  assert.equal(holding.length, 1, holding.join(" | "));
  assert.ok(accumulator.message().lines.length <= 3);
});

test("a long row comes out of the accumulator as rows that fit, inside its time span", () => {
  const accumulator = createLineAccumulator();
  const text = "The whole group goes through the same map again because it clears fast. ".repeat(12).trim();
  accumulator.final(text, 10, 40);
  const { lines: rows } = accumulator.message();
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => row.text.length <= SEGMENT_MAX_CHARS));
  assert.equal(rows.map((row) => row.text).join(" "), text);
  assert.equal(rows[0].start, "0:00:10.00");
  assert.equal(rows[rows.length - 1].end, "0:00:40.00");
  const starts = rows.map((row) => parseTimecode(row.start));
  assert.ok(starts.every((start, index) => index === 0 || start > starts[index - 1]));

  // No span at all: row ids come from the start, so the starts still have to differ.
  const instant = createLineAccumulator();
  instant.final(text, 5, 5);
  const instantStarts = instant.message().lines.map((row) => parseTimecode(row.start));
  assert.ok(instantStarts.every((start, index) => index === 0 || start > instantStarts[index - 1]));
});

test("a full window keeps moving when every long row ends in a short piece", () => {
  const limit = 12;
  const accumulator = createLineAccumulator({ limit });
  const knownLines = new Map();
  const state = { startedAt: 1, sessionId: "s", current: { lines: [] } };
  const texts = new Map();
  const spoken = [];
  for (let index = 0; index < 60; index += 1) {
    // Each "Okay." joins the first piece of the next row, so no row boundary is
    // also the start of a sentence unless the rows are cut before the window.
    const row = [0, 1, 2, 3]
      .map((part) => `Row ${index} part ${part} keeps going for a good long while over the same stretch of the map.`)
      .join(" ");
    const text = `${row} Okay.`;
    spoken.push(text);
    accumulator.final(text, index * 30, index * 30 + 29);
    assert.ok(accumulator.message().lines.length <= limit, `row ${index}`);
    const { patch, historyLines } = reduceTranscriptUpdate(
      state,
      { data: accumulator.message(), sessionId: "s", epochId: "e", epochStartedAt: 1 },
      { knownLines, useApi: true, now: 1 }
    );
    Object.assign(state, patch);
    for (const line of historyLines) knownLines.set(line.id, rememberLine(line));
    for (const line of state.current.lines) texts.set(line.id, line.source);
  }
  // Nothing dropped, nothing delivered twice.
  assert.equal([...texts.values()].join(" "), spoken.join(" "));
  assert.ok([...texts.keys()].every((id) => !id.includes("#")));
});

test("a row longer than the whole window still reaches the reducer complete", () => {
  const accumulator = createLineAccumulator({ limit: 3 });
  accumulator.final("An earlier row that came before the long one here.", 0, 2);
  const sentences = Array.from({ length: 8 }, (_, index) => `Sentence ${index} of the one long row is complete on its own right here.`);
  accumulator.final(sentences.join(" "), 3, 30);
  const delivered = accumulator.message().lines.map((row) => row.text).join(" ");
  assert.ok(delivered.endsWith(sentences.join(" ")), delivered);
  // The next row brings the window back to its limit.
  accumulator.final("The following row is complete on its own right here.", 31, 33);
  assert.ok(accumulator.message().lines.length <= 3);
});
