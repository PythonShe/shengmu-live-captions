import assert from "node:assert/strict";
import test from "node:test";

import {
  SEGMENT_MAX_CHARS,
  cutSentences,
  segmentCaptionLines,
  settleSegmentTimes
} from "../extension/lib/caption-segment.js";
import { lineSignature, linesChangedSince, reduceTranscriptUpdate, rememberLine } from "../extension/lib/transcript-reducer.js";
import { createTranslationScheduler } from "../extension/lib/translation-scheduler.js";
import { createFakeClock, settleAsync } from "./helpers/fake-clock.js";

// Shaped like a real WhisperLiveKit run-on: sentences, chunk periods before a
// lowercase word, and a long stretch with no punctuation at all.
const RUN_ON = [
  "We got game of the year from a few places and that was going great.",
  "And player numbers were really good. for like a few days. and then they dropped off.",
  "And this is the thing, when you are releasing a game that has an ending, some percentage of them will say, cool, I am done now.",
  "so we decided we would release an expansion to the game put a lot of effort in the numbers shot right back up again okay so we have a button we can press now which involves months and months of work that makes numbers go up and the problem we were finding was that the numbers were never going as high as initial launch",
  "and so this was a very scary thing for our company!",
  "What did we do about it?",
  "We shipped."
].join(" ");

const SESSION = "s1";
const EPOCH = "e1";
const STARTED_AT = 1_700_000_000_000;
const ROW_ID = `${SESSION}:${EPOCH}:0:00:00.00`;

function clock(seconds) {
  const total = Math.round(seconds * 100);
  const centis = total % 100;
  const whole = Math.floor(total / 100);
  const pad = (value) => String(value).padStart(2, "0");
  return `${Math.floor(whole / 3600)}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}.${pad(centis)}`;
}

function raw(text, start, end) {
  return { speaker: 1, text, start: clock(start), end: clock(end) };
}

function initialState() {
  return { startedAt: STARTED_AT, sessionId: SESSION, status: "capturing", current: { lines: [] } };
}

/** Runs one ASR message through the reducer like the session does. */
function step(state, lines, { useApi = true, knownLines = new Map(), now = STARTED_AT, epochId = EPOCH } = {}) {
  const result = reduceTranscriptUpdate(
    state,
    { data: { lines }, sessionId: SESSION, epochId, epochStartedAt: STARTED_AT },
    { knownLines, useApi, now }
  );
  return { state: { ...state, ...result.patch }, result };
}

/** Grows one raw row word by word at 15 characters a second. */
function growRow(text, { everyWords = 4 } = {}) {
  const words = text.split(" ");
  const frames = [];
  for (let count = everyWords; ; count += everyWords) {
    const value = words.slice(0, Math.min(count, words.length)).join(" ");
    frames.push(raw(value, 0, value.length / 15));
    if (count >= words.length) return frames;
  }
}

test("cutSentences keeps a short row whole", () => {
  assert.deepEqual(cutSentences("Just one short sentence."), ["Just one short sentence."]);
  assert.deepEqual(cutSentences("no punctuation at all here"), ["no punctuation at all here"]);
  assert.deepEqual(cutSentences(""), []);
});

test("cutSentences cuts where the next sentence starts, and never loses text", () => {
  assert.deepEqual(cutSentences("It works well. So we kept it. Then we shipped"), [
    "It works well.",
    "So we kept it.",
    "Then we shipped"
  ]);
  assert.equal(cutSentences(RUN_ON).join(" "), RUN_ON);
});

test("cutSentences waits for the next word before closing a sentence", () => {
  assert.deepEqual(cutSentences("It works well."), ["It works well."]);
});

test("a chunk period before a lowercase word does not end the sentence", () => {
  assert.deepEqual(cutSentences("Numbers were really good. for like a few days."), [
    "Numbers were really good. for like a few days."
  ]);
});

test("abbreviations and initials do not end a sentence", () => {
  for (const text of [
    "We asked Dr. Smith about it.",
    "It launched in the U.S. Then Europe followed.",
    "Compare this vs. That one over there.",
    "Use a flask, e.g. Quicksilver works."
  ]) {
    assert.equal(cutSentences(text)[0].startsWith(text.split(" ").slice(0, 4).join(" ")), true, text);
  }
  assert.deepEqual(cutSentences("We asked Dr. Smith about it."), ["We asked Dr. Smith about it."]);
});

test("a long sentence is cut at a clause once it is long enough", () => {
  const head = "this part of the sentence keeps going on and on without any sign of stopping any time soon at all really,";
  const text = `${head} and here is another part after a comma, which also goes on for a good while longer than that one`;
  const pieces = cutSentences(text, { clauseMinChars: 100 });
  assert.equal(pieces[0], head);
  assert.equal(pieces.join(" "), text);
});

test("no piece exceeds the limit, even with no punctuation", () => {
  const text = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  const pieces = cutSentences(text);
  assert.ok(pieces.length > 5);
  for (const piece of pieces) assert.ok(piece.length <= SEGMENT_MAX_CHARS, piece);
  assert.equal(pieces.join(" "), text);
});

test("a forced cut does not leave a function word dangling", () => {
  const filler = Array.from({ length: 34 }, () => "lorem").join(" ");
  const text = `${filler} going to the place where all of the people have to go and more text follows here now`;
  const [first] = cutSentences(text);
  assert.doesNotMatch(first, /\b(?:the|to|of|and|where|have|all)$/);
  assert.ok(first.length <= SEGMENT_MAX_CHARS);
});

test("a forced cut prefers the start of a clause when nothing is punctuated", () => {
  const filler = Array.from({ length: 28 }, () => "lorem").join(" ");
  const text = `${filler} ipsum because something else follows here and goes on for quite a long time after it`;
  const [first, second] = cutSentences(text);
  assert.match(first, /\bipsum$/);
  assert.match(second, /^because\b/);
});

test("a forced cut does not separate a term joined by 'of'", () => {
  const filler = Array.from({ length: 29 }, () => "lorem").join(" ");
  const text = `${filler} Path of Exile keeps going on after that with many more words than would fit`;
  for (const padding of ["", "x ", "xx ", "xxx ", "xxxx ", "xxxxx ", "xxxxxx "]) {
    for (const piece of cutSentences(`${padding}${text}`)) {
      assert.doesNotMatch(piece, /\bPath$/);
      assert.doesNotMatch(piece, /^of\b/);
    }
  }
});

test("surrounding whitespace is not part of a piece", () => {
  const word = "x".repeat(200);
  assert.deepEqual(cutSentences(`  ${word}  `), [word.slice(0, 180), word.slice(180)]);
});

test("text without spaces is still cut, on sentence marks first and inside surrogates never", () => {
  assert.deepEqual(cutSentences("第一句话。第二句话！第三句"), ["第一句话。", "第二句话！", "第三句"]);
  const emoji = "😀".repeat(200);
  const pieces = cutSentences(emoji);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(""), emoji);
  for (const piece of pieces) {
    assert.ok(piece.length <= SEGMENT_MAX_CHARS);
    assert.doesNotMatch(piece, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  }
});

test("appending text never moves an earlier cut", () => {
  // Row ids are the piece index, so this is what keeps every row's id stable.
  const words = RUN_ON.split(" ");
  const full = cutSentences(RUN_ON);
  for (let count = 1; count <= words.length; count += 1) {
    const pieces = cutSentences(words.slice(0, count).join(" "));
    // Only the last piece is still open.
    for (const [index, piece] of pieces.slice(0, -1).entries()) {
      assert.equal(piece, full[index], `prefix of ${count} words, piece ${index}`);
    }
  }
});

test("a row that fits passes through the same object, with no bookkeeping added", () => {
  const line = { id: "a", source: "A short row.", start: "0:00:01.00", end: "0:00:02.00" };
  const [out] = segmentCaptionLines([line], []);
  assert.equal(out, line);
  assert.equal(settleSegmentTimes([line], [], null)[0], line);
});

test("a long row becomes rows with the raw id first and an index after", () => {
  const { state } = step(initialState(), [raw(RUN_ON, 0, 40)]);
  const rows = state.current.lines;
  assert.ok(rows.length > 3);
  assert.equal(rows[0].id, ROW_ID);
  assert.match(rows[1].id, new RegExp(`^${ROW_ID}#\\d+$`));
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(rows.map((row) => row.source).join(" "), RUN_ON);
  const orders = rows.map((row) => row.order);
  assert.deepEqual([...orders].sort((a, b) => a - b), orders);
  assert.equal(new Set(orders).size, orders.length);
});

test("text that arrives in one go is timed by its share of the characters", () => {
  const { state } = step(initialState(), [raw(RUN_ON, 10, 50)]);
  const rows = state.current.lines;
  assert.equal(rows[0].start, "0:00:10.00");
  assert.equal(rows.at(-1).end, "0:00:50.00");
  let cursor = 10;
  for (const row of rows) {
    const [start, end] = [row.start, row.end].map((value) => {
      const [hours, minutes, seconds] = value.split(":").map(Number);
      return hours * 3600 + minutes * 60 + seconds;
    });
    assert.ok(Math.abs(start - cursor) < 0.02, `${row.start} follows ${cursor}`);
    assert.ok(end > start);
    cursor = end;
  }
});

test("a row in server mode stays whole, its translation is aligned to it", () => {
  const { state } = step(initialState(), [{ ...raw(RUN_ON, 0, 40), translation: "服务端译文" }], { useApi: false });
  assert.equal(state.current.lines.length, 1);
  assert.equal(state.current.lines[0].source, RUN_ON);
  assert.equal(state.current.lines[0].translation, "服务端译文");
});

test("a growing row keeps its row ids and finished rows stop changing", () => {
  let state = initialState();
  const knownLines = new Map();
  const finished = new Map();
  const everSeen = new Set();
  for (const frame of growRow(RUN_ON)) {
    ({ state } = step(state, [frame], { knownLines }));
    const rows = state.current.lines;
    for (const row of rows) everSeen.add(row.id);
    // Finished rows are the ones before the row that is still growing and the
    // one before it, which the merge may still reach.
    for (const row of rows.slice(0, -2)) {
      const before = finished.get(row.id);
      if (before) {
        assert.equal(row.source, before.source, row.id);
        assert.equal(row.start, before.start, row.id);
        assert.equal(row.end, before.end, row.id);
      }
      finished.set(row.id, row);
    }
    for (const row of rows) knownLines.set(row.id, rememberLine(row));
  }
  const final = state.current.lines;
  assert.equal(final.map((row) => row.source).join(" "), RUN_ON);
  // An id the final state no longer has would be a row left behind in history.
  for (const id of everSeen) assert.ok(final.some((row) => row.id === id), `${id} vanished`);
});

test("a finished row is not rewritten to history on every update", () => {
  let state = initialState();
  const knownLines = new Map();
  const writes = new Map();
  for (const frame of growRow(RUN_ON)) {
    const { state: next, result } = step(state, [frame], { knownLines });
    state = next;
    for (const row of result.historyLines) {
      writes.set(row.id, (writes.get(row.id) || 0) + 1);
      knownLines.set(row.id, rememberLine(row));
    }
    // A translation lands right away, the way the scheduler would patch it in.
    for (const row of state.current.lines) {
      if (row === state.current.lines.at(-1)) continue;
      Object.assign(row, { translation: `译${row.source.length}`, translatedSource: row.source, translationPending: false });
      const remembered = rememberLine(row);
      remembered.signature = lineSignature(row.source, row.translation);
      if (knownLines.get(row.id)?.signature !== remembered.signature) {
        writes.set(row.id, (writes.get(row.id) || 0) + 1);
        knownLines.set(row.id, remembered);
      }
    }
  }
  assert.ok(writes.size > 2);
  // A few writes while the merge settles are fine; one per frame is not.
  const frames = growRow(RUN_ON).length;
  for (const [id, count] of writes) assert.ok(count < frames / 3, `${id} written ${count} times`);
  assert.deepEqual(linesChangedSince(state.current.lines.slice(0, -1), knownLines), []);
});

test("a row pruned from the front keeps its ids", () => {
  // Past --retention-seconds WhisperLiveKit drops the row's oldest words, which
  // moves its start: the raw id derived from that start changes on every frame.
  let state = initialState();
  ({ state } = step(state, [raw(RUN_ON, 0, 40)]));
  const before = new Map(state.current.lines.map((row) => [row.source, row]));
  const words = RUN_ON.split(" ");
  const expectedTail = state.current.lines.at(-1).id;

  for (const [dropped, start] of [[3, 1.1], [6, 2.2], [40, 14]]) {
    ({ state } = step(state, [raw(words.slice(dropped).join(" "), start, 40)]));
    const rows = state.current.lines;
    assert.equal(rows.at(-1).id, expectedTail, `after dropping ${dropped} words`);
    for (const row of rows) {
      const earlier = before.get(row.source);
      assert.ok(earlier, `${row.id} is a row the state already had`);
      assert.equal(row.id, earlier.id);
      assert.equal(row.start, earlier.start);
    }
    // The row the cut falls into stays whole until all of it is older than the
    // window; rows entirely before the cut leave, like any row past retention.
    assert.ok(rows[0].source.includes(words[dropped]) || rows[0].source.includes(words[dropped - 1]));
  }
});

test("a row pruned right up to a piece keeps its ids when the piece's start is an estimate", () => {
  // Real WLK frames: the raw start was 2.28 s, the estimate for that piece 2.29 s.
  let state = initialState();
  ({ state } = step(state, [raw(RUN_ON, 0, 40)]));
  const rows = state.current.lines;
  const second = rows[1];
  const rest = RUN_ON.slice(RUN_ON.indexOf(second.source));
  const [hours, minutes, seconds] = second.start.split(":").map(Number);
  const justBefore = hours * 3600 + minutes * 60 + seconds - 0.01;

  ({ state } = step(state, [raw(rest, justBefore, 40)]));
  assert.deepEqual(state.current.lines.map((row) => row.id), rows.slice(1).map((row) => row.id));
});

test("repeated words do not misplace a pruned row", () => {
  // The first 48 characters of what is left also occur earlier in the row.
  const refrain = "and that is exactly why we kept on doing the very same thing again";
  const text = `${refrain}. Something else was said in between all of this for a while here. ${refrain}. And the row carries on after that with another full sentence.`;
  let state = initialState();
  ({ state } = step(state, [raw(text, 0, 30)]));
  const rows = state.current.lines;
  const rest = text.slice(text.lastIndexOf(refrain));

  ({ state } = step(state, [raw(rest, 15, 30)]));
  assert.ok(state.current.lines.at(-1).id === rows.at(-1).id);
  assert.equal(state.current.lines.at(-1).source, rows.at(-1).source);
  assert.equal(state.current.lines.map((row) => row.source).join(" ").split(refrain).length - 1, 1);
});

test("a finished short row that took a piece of a growing row stops changing", () => {
  // "Okay." cannot stand alone, so the first piece of the next row joins it.
  const words = RUN_ON.split(" ");
  let state = initialState();
  const seen = [];
  for (let count = 40; count <= words.length; count += 6) {
    const text = words.slice(0, count).join(" ");
    ({ state } = step(state, [raw("Okay.", 10, 10.5), raw(text, 11, 11 + text.length / 15)]));
    seen.push(state.current.lines[0]);
  }
  const first = seen.at(-1);
  assert.match(first.source, /^Okay\. /);
  assert.equal(first.start, "0:00:10.00");
  const settled = seen.filter((row) => row.source === first.source);
  assert.ok(settled.length > 3);
  assert.deepEqual([...new Set(settled.map((row) => row.end))], [settled[0].end]);
  assert.ok(first.end < state.current.lines.at(-1).end);
});

test("the row that took the first piece of the next split row stops changing too", () => {
  const head = "A long first sentence that goes on for a good while and then stops right there. ".repeat(3).trim();
  const words = RUN_ON.split(" ");
  let state = initialState();
  const ends = new Map();
  for (let count = 40; count <= words.length; count += 6) {
    const text = words.slice(0, count).join(" ");
    ({ state } = step(state, [raw(`${head} Okay.`, 0, 20), raw(text, 21, 21 + text.length / 15)]));
    const row = state.current.lines.find((line) => line.source.includes("Okay. "));
    ends.set(row.source, [...(ends.get(row.source) || []), row.end]);
  }
  const lastSource = [...ends.keys()].at(-1);
  assert.equal(new Set(ends.get(lastSource)).size, 1, ends.get(lastSource).join());
});

test("a row after a split row keeps its own timing, and the split row's last piece its end", () => {
  const head = "A long first sentence that goes on for a good while and then stops right there. ".repeat(3).trim();
  const { state } = step(initialState(), [raw(head, 0, 20), raw("This row stands on its own after the pause.", 24, 26)]);
  const rows = state.current.lines;
  assert.equal(rows.at(-1).start, "0:00:24.00");
  assert.equal(rows.at(-1).end, "0:00:26.00");
  assert.equal(rows.at(-2).end, "0:00:20.00");
  assert.ok(rows.at(-3).end < rows.at(-2).end);
});

test("a row pruned after it gave its first piece to a short row keeps its later ids", () => {
  let state = initialState();
  ({ state } = step(state, [raw("Okay.", 0, 0.5), raw(RUN_ON, 1, 40)]));
  assert.match(state.current.lines[0].source, /^Okay\. /);
  const later = state.current.lines.slice(1).map((row) => row.id);
  const words = RUN_ON.split(" ");

  // The short row is older, so it left first; then the long row loses words.
  ({ state } = step(state, [raw(words.slice(2).join(" "), 1.5, 40)]));
  const ids = state.current.lines.map((row) => row.id);
  for (const id of later) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a pruned row keeps growing on its own ids, and closes on a silence", () => {
  let state = initialState();
  ({ state } = step(state, [raw(RUN_ON, 0, 40)]));
  const tailId = state.current.lines.at(-1).id;
  const trimmed = RUN_ON.split(" ").slice(3).join(" ");
  // "We shipped." is too short to stand alone, so the new sentence joins it.
  const grownText = `${trimmed} And here is one more sentence for it.`;

  ({ state } = step(state, [raw(grownText, 1.1, 42)]));
  assert.equal(state.current.lines.at(-1).id, tailId);
  assert.match(state.current.lines.at(-1).source, /one more sentence for it\.$/);

  // The silence freezes the trimmed row, and a new row starts after it.
  ({ state } = step(state, [raw(grownText, 1.1, 42), raw("A new row after the pause.", 44, 46)]));
  assert.equal(state.current.lines.at(-2).id, tailId);
  assert.equal(state.current.lines.at(-1).id, `${SESSION}:${EPOCH}:0:00:44.00`);
});

test("a reconnect starts its rows over instead of continuing the old epoch", () => {
  let state = initialState();
  ({ state } = step(state, [raw(RUN_ON, 0, 40)]));
  ({ state } = step(state, [raw(RUN_ON, 5, 40)], { epochId: "e2" }));
  assert.ok(state.current.lines.every((row) => row.id.startsWith(`${SESSION}:e2:0:00:05.00`)));
});

test("a row that only starts inside a split row is not taken for it", () => {
  let state = initialState();
  ({ state } = step(state, [raw(RUN_ON, 0, 40)]));
  ({ state } = step(state, [raw("Completely different words that were never in that row.", 10, 12)]));
  assert.deepEqual(state.current.lines.map((row) => row.id), [`${SESSION}:${EPOCH}:0:00:10.00`]);
});

test("a following 'and ...' stays off a row that was cut on purpose", () => {
  const long = Array.from({ length: 26 }, () => "lorem").join(" ");
  const text = `${long} ipsum, and then a few more words came.`;
  const { state } = step(initialState(), [raw(text, 0, 12)]);
  assert.deepEqual(
    state.current.lines.map((row) => row.source),
    [`${long} ipsum,`, "and then a few more words came."]
  );
});

test("a short 'and ...' after a short sentence still joins it", () => {
  const { state } = step(initialState(), [raw("We went to the old shop. and bought some bread there.", 0, 5)]);
  assert.equal(state.current.lines.length, 1);
});

test("every request stays small and every row gets translated", async () => {
  const fake = createFakeClock(STARTED_AT);
  const state = { ...initialState(), active: true };
  const knownLines = new Map();
  const requests = [];
  const scheduler = createTranslationScheduler({
    getState: () => state,
    getConfig: () => ({ mode: "api", enabled: true, provider: "custom", model: "mock", apiKey: "key" }),
    translateTexts: async ({ texts }) => {
      requests.push(texts);
      return { translations: texts.map((text) => `译[${text}]`), usage: {} };
    },
    knownLines,
    enqueueHistory: (rows) => {
      for (const row of rows) knownLines.set(row.id, rememberLine(row));
    },
    publish: () => {},
    setTimeout: fake.setTimeout,
    clearTimeout: fake.clearTimeout,
    now: fake.now,
    random: () => 0
  });

  for (const frame of growRow(RUN_ON)) {
    const { state: next } = step(state, [frame], { knownLines, now: fake.now() });
    Object.assign(state, next);
    scheduler.scheduleLines();
    await fake.advance(800);
  }
  await fake.advance(10_000);
  await settleAsync();

  const rows = state.current.lines;
  assert.ok(rows.length > 3);
  for (const row of rows) {
    assert.equal(row.translationPending, false, row.source);
    assert.ok(row.translation.includes(row.source.slice(0, 16)), `${row.translation} covers ${row.source}`);
  }
  for (const texts of requests) {
    assert.ok(texts.join("").length <= SEGMENT_MAX_CHARS * 6);
    for (const text of texts) assert.ok(text.length <= SEGMENT_MAX_CHARS);
  }
  const sent = requests.flat().join("").length;
  assert.ok(sent < RUN_ON.length * 8, `sent ${sent} for ${RUN_ON.length}`);
});

test("a piece is cut no further when it is cut again", () => {
  // The accumulator cuts finished rows and the reducer sees them again as rows.
  const inputs = [
    "We finished the map. Then the boss spawned, and we ran. ".repeat(12),
    "so we keep going through the whole map with the same build because it clears fast ".repeat(12),
    "really good. for like a few days. and then, you know, it stopped; we moved on. ".repeat(12),
    `${"x".repeat(500)} then some more words after the very long one. Okay.`,
    "这一段没有空格但是有句号。下一句也很长，一直说下去。".repeat(30)
  ];
  for (const input of inputs) {
    for (const piece of cutSentences(input)) {
      assert.deepEqual(cutSentences(piece), [piece]);
    }
  }
});
