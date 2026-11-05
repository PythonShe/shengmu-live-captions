import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_LINE_LIMIT,
  lineSignature,
  reduceTranscriptUpdate,
  rememberLine
} from "../extension/lib/transcript-reducer.js";

const SESSION = "s1";
const STARTED_AT = 1_700_000_000_000;
const NOW = STARTED_AT + 5_000;

function state(extra = {}) {
  return {
    active: true,
    status: "capturing",
    sessionId: SESSION,
    startedAt: STARTED_AT,
    current: { lines: [], bufferSource: "", bufferTranslation: "", translationError: "", epochId: null },
    ...extra
  };
}

function message(lines, { epochId = "e1", epochStartedAt = STARTED_AT, ...data } = {}) {
  return { sessionId: SESSION, epochId, epochStartedAt, data: { lines, ...data } };
}

function reduce(currentState, msg, options = {}) {
  return reduceTranscriptUpdate(currentState, msg, {
    knownLines: new Map(),
    useApi: true,
    now: NOW,
    ...options
  });
}

test("API mode: fragments merge into one pending row and the buffer extends the source slot", () => {
  const result = reduce(
    state(),
    message(
      [
        { text: "We went to the shop and", start: "0:00:01.00", end: "0:00:02.00", speaker: 1, translation: "嗯，我们去了商店" },
        { text: "bought some bread.", start: "0:00:02.20", end: "0:00:03.00", speaker: 1 }
      ],
      { buffer_transcription: "and then we" }
    ),
    { apiError: "rate limited" }
  );

  assert.deepEqual(result.patch.current, {
    lines: [
      {
        id: "s1:e1:0:00:01.00",
        sessionId: SESSION,
        epochId: "e1",
        start: "0:00:01.00",
        end: "0:00:03.00",
        source: "We went to the shop and bought some bread.",
        translation: "",
        translatedSource: "",
        // Only the first fragment has a server translation, so it cannot stand
        // in for the whole row.
        fallbackTranslation: "",
        translationPending: true,
        translationFailed: false,
        speaker: 1,
        detectedLanguage: "en",
        order: STARTED_AT + 1000,
        updatedAt: NOW,
        // mergeCaptionFragments bookkeeping rides along on the row.
        fragmentIds: ["s1:e1:0:00:01.00", "s1:e1:0:00:02.20"],
        fragmentLines: 2,
        open: true
      }
    ],
    bufferSource: "and then we",
    bufferTranslation: "",
    translationError: "rate limited",
    epochId: "e1",
    displayCaption: {
      lineId: "s1:e1:0:00:01.00",
      // The buffer only carries the words after the row, so the English slot
      // keeps the sentence and appends what has not been committed yet, with
      // the uncommitted tail split out so the overlay can dim it.
      source: "We went to the shop and bought some bread. and then we",
      sourceStable: "We went to the shop and bought some bread.",
      sourceStash: "and then we",
      translation: "",
      error: "rate limited",
      pending: true,
      failed: false
    }
  });
  assert.equal(result.patch.wsConnected, true);
  assert.equal(result.patch.updatedAt, NOW);
  assert.equal(result.bufferChanged, true);
  // A row whose translation is still pending is screen-only: the history waits
  // for the scheduler to land one, so nothing is queued yet.
  assert.deepEqual(result.historyLines, []);
});

test("API mode keeps a server translation only as the polished fallback", () => {
  const result = reduce(
    state(),
    message([{ text: "This sentence stands on its own.", start: "0:00:01.00", end: "0:00:02.00", translation: "嗯，这句话独立成句。" }])
  );
  const [row] = result.patch.current.lines;
  assert.equal(row.translation, "");
  assert.equal(row.fallbackTranslation, "这句话独立成句。");
  assert.equal(row.translationPending, true);
});

test("a merged row's fallback covers every fragment or is not offered", () => {
  const rows = [
    { text: "We went to the shop and", start: "0:00:01.00", end: "0:00:02.00", translation: "我们去了商店，" },
    { text: "bought some bread.", start: "0:00:02.20", end: "0:00:03.00" }
  ];
  const partial = reduce(state(), message(rows));
  assert.equal(partial.patch.current.lines[0].fallbackTranslation, "");
  assert.equal("translationPartial" in partial.patch.current.lines[0], false, "merge bookkeeping stays off the row");

  const whole = reduce(partial.patch, message([rows[0], { ...rows[1], translation: "买了面包。" }]));
  assert.equal(whole.patch.current.lines[0].source, "We went to the shop and bought some bread.");
  assert.equal(whole.patch.current.lines[0].fallbackTranslation, "我们去了商店，买了面包。");

  // A later frame that lost the second translation keeps the one that covered
  // this exact source.
  const again = reduce(whole.patch, message(rows));
  assert.equal(again.patch.current.lines[0].fallbackTranslation, "我们去了商店，买了面包。");
});

test("server mode keeps the WLK rows, polishes their translations and never merges fragments", () => {
  const result = reduce(
    state({ status: "reconnecting" }),
    message(
      [
        { text: "We went to the shop and", start: "0:00:01.00", end: "0:00:02.00", translation: "嗯，我们去了商店" },
        { text: "bought some bread.", start: "0:00:02.20", end: "0:00:03.00", translation: { text: "买了面包。" } }
      ],
      { buffer_transcription: "and then", buffer_translation: "然后", translation_error: "llama busy" }
    ),
    { useApi: false, apiError: "ignored in server mode" }
  );

  const { current } = result.patch;
  assert.deepEqual(
    current.lines.map((row) => [row.id, row.source, row.translation, row.fallbackTranslation, row.translationPending]),
    [
      ["s1:e1:0:00:01.00", "We went to the shop and", "我们去了商店", "", false],
      ["s1:e1:0:00:02.20", "bought some bread.", "买了面包。", "", false]
    ]
  );
  assert.equal(current.bufferTranslation, "然后");
  assert.equal(current.translationError, "llama busy");
  assert.equal(current.displayCaption.source, "bought some bread. and then");
  // The translation slot follows the newest row's own translation; the buffer
  // translation is only the fallback when that row has none.
  assert.equal(current.displayCaption.translation, "买了面包。");
  assert.equal(result.patch.status, "capturing", "a transcript ends the reconnecting state");
  assert.equal(result.historyLines.length, 2);
});

test("an epoch switch shifts timecodes by the reconnect offset and replaces the runtime rows", () => {
  const first = reduce(
    state(),
    message([{ text: "Before the reconnect we said this.", start: "0:00:01.00", end: "0:00:02.00" }])
  );
  const afterFirst = { ...state(), ...first.patch };
  afterFirst.current.lines[0].translation = "重连之前说的。";

  const second = reduce(
    afterFirst,
    message(
      [{ text: "After the reconnect we said that.", start: "0:00:01.00", end: "0:00:02.50" }],
      { epochId: "e2", epochStartedAt: STARTED_AT + 30_000 }
    )
  );

  assert.deepEqual(
    second.patch.current.lines.map((row) => [row.id, row.epochId, row.start, row.end, row.order]),
    [["s1:e2:0:00:01.00", "e2", "0:00:31.00", "0:00:32.50", STARTED_AT + 31_000]]
  );
  assert.equal(second.patch.current.epochId, "e2");
  // The new epoch's display falls back to the previous translated row only
  // while it is still in the runtime window; here it is not.
  assert.equal(second.patch.current.displayCaption.translation, "");
  // The new epoch's row is untranslated, so it is screen-only until a
  // translation lands.
  assert.deepEqual(second.historyLines, []);
});

test("unchanged rows keep their translation and are not written to history again", () => {
  const first = reduce(
    state(),
    message([{ text: "A sentence that is already translated.", start: "0:00:01.00", end: "0:00:02.00" }])
  );
  const translated = { ...first.patch.current.lines[0], translation: "已经翻译的句子。", translationPending: false };
  const knownLines = new Map([[translated.id, rememberLine(translated)]]);
  const before = { ...state(), ...first.patch, current: { ...first.patch.current, lines: [translated] } };

  const again = reduce(
    before,
    message([{ text: "A sentence that is already translated.", start: "0:00:01.00", end: "0:00:02.00" }]),
    { knownLines }
  );
  assert.equal(again.patch.current.lines[0].translation, "已经翻译的句子。");
  assert.equal(again.patch.current.lines[0].translationPending, false);
  assert.deepEqual(again.historyLines, []);
  assert.equal(knownLines.get(translated.id).signature, lineSignature(translated.source, "已经翻译的句子。"));

  // A row that fell out of the runtime window is still recognized via knownLines.
  const outOfWindow = reduce(
    { ...before, current: { ...before.current, lines: [] } },
    message([{ text: "A sentence that is already translated.", start: "0:00:01.00", end: "0:00:02.00" }]),
    { knownLines }
  );
  assert.equal(outOfWindow.patch.current.lines[0].translation, "已经翻译的句子。");
  assert.deepEqual(outOfWindow.historyLines, []);
});

test("a failed row stays failed until its source changes", () => {
  const id = "s1:e1:0:00:01.00";
  const failedRow = { id, source: "This row failed to translate twice.", translation: "", translationFailed: true };
  const failed = reduce(
    state({ current: { lines: [failedRow], bufferSource: "", bufferTranslation: "" } }),
    message([{ text: "This row failed to translate twice.", start: "0:00:01.00", end: "0:00:02.00" }])
  );
  assert.equal(failed.patch.current.lines[0].translationFailed, true);

  const grown = reduce(
    state({ current: { lines: [failedRow], bufferSource: "", bufferTranslation: "" } }),
    message([{ text: "This row failed to translate twice. Then it grew.", start: "0:00:01.00", end: "0:00:03.00" }])
  );
  assert.equal(grown.patch.current.lines[0].translationFailed, false);
});

test("server mode takes the buffer translation straight from WhisperLiveKit", () => {
  const withBuffer = state({
    current: { lines: [], bufferSource: "and then we", bufferTranslation: "然后我们", translationError: "" }
  });
  // Server mode is the only place a buffer translation exists now; API mode
  // gets its half-sentences from the growing row's stage translation.
  const same = reduce(
    withBuffer,
    message([], { buffer_transcription: "and then  we", buffer_translation: "然后我们" }),
    { useApi: false }
  );
  assert.equal(same.bufferChanged, false);
  assert.equal(same.patch.current.bufferTranslation, "然后我们");

  const moved = reduce(
    withBuffer,
    message([], { buffer_transcription: "and then we went", buffer_translation: "然后我们继续" }),
    { useApi: false }
  );
  assert.equal(moved.bufferChanged, true);
  assert.equal(moved.patch.current.bufferTranslation, "然后我们继续");
});

test("API mode never keeps a buffer translation", () => {
  const withBuffer = state({
    current: { lines: [], bufferSource: "and then we", bufferTranslation: "然后我们", translationError: "" }
  });
  const same = reduce(withBuffer, message([], { buffer_transcription: "and then we" }));
  assert.equal(same.patch.current.bufferTranslation, "");
});

test("runtime rows are capped to the newest window", () => {
  const rows = Array.from({ length: RUNTIME_LINE_LIMIT + 5 }, (_, index) => ({
    text: `Sentence number ${index} is complete.`,
    start: `0:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.00`,
    end: ""
  }));
  const result = reduce(state(), message(rows), { useApi: false });
  assert.equal(result.patch.current.lines.length, RUNTIME_LINE_LIMIT);
  assert.equal(result.patch.current.lines[0].source, "Sentence number 5 is complete.");
  // Untranslated rows are screen-only until a translation lands on them.
  assert.deepEqual(result.historyLines, []);
});
