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
import { parseTimecode } from "../extension/lib/caption-utils.js";

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
  assert.equal(lines.final("hello world", 1, 2), true);
  assert.equal(lines.message().buffer_transcription, "");
  assert.equal(lines.final("  ", 3, 4), false);
  lines.final("same start", 1, 1.5);
  lines.final("third", 5, 6);
  const { lines: rows } = lines.message();
  assert.deepEqual(rows.map((row) => row.text), ["same start", "third"]);
  assert.equal(rows[0].start, "0:00:01.01", "a repeated start moves past the previous one");
  assert.equal(rows[0].end, "0:00:01.50");
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
  assert.match(bailianErrorDetail("InvalidApiKey", "x"), /API Key 无效/);
  assert.match(bailianErrorDetail("Other", "boom"), /Other.*boom/);
});
