import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  CAPTION_RESYNC_INTERVAL_MS,
  CAPTION_WINDOW_LINES,
  applyCaptionMessage,
  createCaptionDeltaEncoder,
  createCaptionReceiver,
  upsertTailLines
} from "../extension/lib/caption-delta.js";

function line(order, extra = {}) {
  return { id: `l${order}`, order, source: `source ${order}`, translation: "", ...extra };
}

function current(lines, extra = {}) {
  return { lines, bufferSource: "", bufferTranslation: "", translationError: "", ...extra };
}

// Deterministic pseudo-random walk over the mutations the worker makes.
function* mutations(seed = 7) {
  let value = seed;
  const next = () => {
    value = (value * 1103515245 + 12345) % 2 ** 31;
    return value / 2 ** 31;
  };
  let lines = [];
  let order = 0;
  for (let step = 0; step < 400; step += 1) {
    const roll = next();
    if (roll < 0.45 || lines.length === 0) {
      order += 1;
      lines = [...lines, line(order)];
    } else if (roll < 0.75) {
      const index = Math.floor(next() * lines.length);
      lines = lines.map((item, cursor) => (cursor === index ? { ...item, translation: `t${step}` } : item));
    } else if (roll < 0.85 && lines.length > 1) {
      // A fragment merge drops a row from the window.
      const index = Math.floor(next() * lines.length);
      lines = lines.filter((_, cursor) => cursor !== index);
    }
    yield current(lines.slice(-200), { bufferSource: `buffer ${step}` });
  }
}

test("deltas rebuild exactly the window the worker holds", () => {
  const encoder = createCaptionDeltaEncoder();
  let held = null;
  let deltaRows = 0;
  let fullRows = 0;
  for (const state of mutations()) {
    const message = encoder.encode(state);
    held = applyCaptionMessage(held, message);
    assert.ok(held, `seq ${message.seq} applied`);
    const expected = state.lines.slice(-CAPTION_WINDOW_LINES);
    assert.deepEqual(held.current.lines, expected);
    assert.equal(held.current.bufferSource, state.bufferSource);
    if (message.delta) deltaRows += message.delta.lines.length;
    fullRows += expected.length;
  }
  assert.ok(deltaRows * 10 < fullRows, `deltas carried ${deltaRows} rows instead of ${fullRows}`);
});

test("a gap or an unknown row refuses the delta; a reset sends a full message", () => {
  const encoder = createCaptionDeltaEncoder();
  const first = encoder.encode(current([line(1)]));
  assert.ok(first.full);
  const held = applyCaptionMessage(null, first);
  encoder.encode(current([line(1), line(2)]));
  const third = encoder.encode(current([line(1), line(2), line(3)]));
  assert.equal(applyCaptionMessage(held, third), null, "missed seq 2");
  assert.equal(applyCaptionMessage(null, third), null, "nothing held");
  encoder.reset();
  const full = encoder.encode(current([line(1), line(2), line(3)]));
  assert.equal(full.baseSeq, null);
  assert.deepEqual(applyCaptionMessage(held, full).current.lines.map((item) => item.id), ["l1", "l2", "l3"]);
});

test("the receiver asks for a resync at most once per interval", () => {
  let clock = 0;
  let resyncs = 0;
  const receiver = createCaptionReceiver({ requestResync: () => (resyncs += 1), now: () => clock });
  const encoder = createCaptionDeltaEncoder();
  encoder.encode(current([line(1)]));
  receiver.seed(current([line(1)]));
  assert.equal(receiver.apply(encoder.encode(current([line(1), line(2)]))), null);
  assert.equal(receiver.apply(encoder.encode(current([line(1), line(2)]))), null);
  assert.equal(resyncs, 1);
  clock += CAPTION_RESYNC_INTERVAL_MS;
  receiver.apply(encoder.encode(current([line(1), line(2)])));
  assert.equal(resyncs, 2);
  encoder.reset();
  const changed = receiver.apply(encoder.encode(current([line(1), line(2)])));
  assert.deepEqual(changed.map((item) => item.id), ["l1", "l2"]);
  assert.equal(receiver.current.lines.length, 2);
});

test("upsertTailLines patches and appends at the tail, and refuses an out-of-order row", () => {
  const lines = [line(1), line(2), line(3)];
  assert.equal(upsertTailLines(lines, [{ ...line(3), translation: "三" }, line(4)], 10), true);
  assert.deepEqual(lines.map((item) => [item.id, item.translation]), [["l1", ""], ["l2", ""], ["l3", "三"], ["l4", ""]]);
  assert.equal(upsertTailLines(lines, [line(5), line(6)], 4), true);
  assert.deepEqual(lines.map((item) => item.id), ["l3", "l4", "l5", "l6"]);
  assert.equal(upsertTailLines(lines, [line(0)], 10), false);
});

test("the overlay's inline applyCaptionMessage matches the library", () => {
  const source = fs.readFileSync(new URL("../extension/content/content-overlay.js", import.meta.url), "utf8");
  const match = /\n {2}function applyCaptionMessage\(held, message\) \{[\s\S]*?\n {2}\}\n/.exec(source);
  assert.ok(match, "overlay keeps applyCaptionMessage");
  const overlayApply = new Function(`${match[0]}; return applyCaptionMessage;`)();
  const encoder = createCaptionDeltaEncoder();
  let fromLib = null;
  let fromOverlay = null;
  for (const state of mutations(11)) {
    const message = encoder.encode(state);
    fromLib = applyCaptionMessage(fromLib, message);
    fromOverlay = overlayApply(fromOverlay, message);
    assert.deepEqual(fromOverlay, fromLib);
  }
  assert.equal(overlayApply(fromOverlay, { seq: 999, baseSeq: 5, delta: { fields: {}, lineIds: [], lines: [] } }), null);
});
