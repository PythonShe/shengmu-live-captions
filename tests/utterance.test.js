import assert from "node:assert/strict";
import test from "node:test";

import {
  SPEECH_SHARD_HOLD_MS,
  UTTERANCE_MAX_CHARS,
  isSpeechShard,
  planTranslationBatch
} from "../extension/lib/utterance.js";

function entry(source, queuedAt = 0) {
  return { source, queuedAt };
}

test("isSpeechShard uses connectors, weak endings and length, not the full stop", () => {
  // WhisperLiveKit punctuates every segment, so a full stop proves nothing.
  assert.equal(isSpeechShard("and riddled with excitement."), true);
  assert.equal(isSpeechShard("with the ancient."), true);
  assert.equal(isSpeechShard("many options here that."), true);
  assert.equal(isSpeechShard("unlock."), true);
  assert.equal(isSpeechShard("your items."), true);
  // "so" opens plenty of complete sentences, so it is not a connector here.
  assert.equal(isSpeechShard("So I think people will be experimenting."), false);
  assert.equal(isSpeechShard("that Danig has been leading."), true);
  // Complete short utterances must not be merged forward.
  assert.equal(isSpeechShard("Really?"), false);
  assert.equal(isSpeechShard("Thanks for watching!"), false);
  // 25 characters: treated as a fragment and merged forward, which is the
  // closest a suffix-merging rule can get to an appositive that belongs to the
  // previous sentence. The model still sees it next to the sentence that
  // follows, which is better than translating it alone.
  assert.equal(isSpeechShard("a real Kalgurin runesmith"), true);
  assert.equal(isSpeechShard("a real Kalgurin runesmith from the north"), false);
  assert.equal(isSpeechShard(""), false);
  assert.equal(
    isSpeechShard(
      "There are honestly so many options here that unlock all sorts of crazy crafting projects"
    ),
    false
  );
});

test("participle openers continue the previous sentence, generic -ing does not", () => {
  assert.equal(isSpeechShard("using the near lake crafting mechanic."), true);
  assert.equal(
    isSpeechShard("allowing you to do some specific crafts along the way."),
    false
  );
  assert.equal(isSpeechShard("Understanding the mechanic is important."), false);
});

test("a fragment is translated together with the row that completes it", () => {
  const entries = [
    ["l1", entry("and riddled with excitement")],
    ["l2", entry("he wants to learn how to merge modern Kalgurin techniques.")],
    ["l3", entry("From here on, Pharaoh joins the expedition.")]
  ];
  const { batch, held } = planTranslationBatch(entries, { now: 10_000 });
  assert.deepEqual(
    batch.map(([id]) => id),
    ["l1", "l2", "l3"]
  );
  assert.deepEqual(held, []);
});

test("a trailing fragment waits for the next row instead of being orphaned", () => {
  const entries = [["l1", entry("with the ancient knowledge", 9_500)]];
  const { batch, held } = planTranslationBatch(entries, { now: 10_000 });
  assert.deepEqual(batch, []);
  assert.deepEqual(
    held.map(([id]) => id),
    ["l1"]
  );
});

test("a trailing fragment is released once the hold window expires", () => {
  const entries = [["l1", entry("with the ancient knowledge", 7_000)]];
  const { batch } = planTranslationBatch(entries, {
    now: 7_000 + SPEECH_SHARD_HOLD_MS + 1
  });
  assert.deepEqual(
    batch.map(([id]) => id),
    ["l1"]
  );
});

test("complete rows are not delayed and keep their own request", () => {
  const entries = [
    ["l1", entry("Once you get to King's March in Act 4, Pharaoh finally meets Danig.", 0)],
    ["l2", entry("For those of you who haven't played it, the mechanic involves explosives.", 0)]
  ];
  const { batch } = planTranslationBatch(entries, { now: 10 });
  assert.deepEqual(
    batch.map(([id]) => id),
    ["l1", "l2"]
  );
});

test("a run-on fragment chain is capped by the utterance size limits", () => {
  const long = "x".repeat(UTTERANCE_MAX_CHARS - 10);
  const entries = [
    ["l1", entry(long, 0)],
    ["l2", entry("and then another fragment here", 0)],
    ["l3", entry("another fragment that does not fit", 0)]
  ];
  const { batch } = planTranslationBatch(entries, { now: 10_000, maxLines: 6 });
  // The first fragment already fills the budget, so the rest stays separate.
  const firstGroup = batch.slice(0, 1).map(([id]) => id);
  assert.deepEqual(firstGroup, ["l1"]);
  assert.ok(batch.length >= 1);
});

test("batch length never exceeds maxLines", () => {
  const entries = Array.from({ length: 10 }, (_, index) => [
    `l${index}`,
    entry(`fragment number ${index}`)
  ]);
  const { batch, held } = planTranslationBatch(entries, { now: 10_000, maxLines: 3 });
  assert.equal(batch.length, 3);
  assert.equal(held.length, 7);
});

test("an empty pending list produces an empty batch", () => {
  assert.deepEqual(planTranslationBatch([], { now: 1 }), { batch: [], held: [] });
  assert.deepEqual(planTranslationBatch(null), { batch: [], held: [] });
});
