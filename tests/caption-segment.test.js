import assert from "node:assert/strict";
import test from "node:test";

import { SEGMENT_MAX_CHARS, cutSentences } from "../extension/lib/caption-segment.js";

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

