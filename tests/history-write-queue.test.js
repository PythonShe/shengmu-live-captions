import assert from "node:assert/strict";
import test from "node:test";

import { HistoryWriteQueue } from "../extension/lib/history-write-queue.js";

function line(id, translation = "") {
  return { id, sessionId: "session", source: id, translation };
}

test("HistoryWriteQueue restores a failed batch and retries without losing lines", async () => {
  const batches = [];
  let fail = true;
  const queue = new HistoryWriteQueue({
    writeBatch: async (batch) => {
      batches.push(batch.map((item) => item.id));
      if (fail) throw new Error("write failed");
    },
    retryDelaysMs: [],
    debounceMs: 60_000
  });

  queue.enqueue([line("one")]);
  await assert.rejects(() => queue.flush({ drain: true }), /write failed/);
  assert.equal(queue.pendingCount, 1);

  fail = false;
  await queue.flush({ drain: true });
  assert.deepEqual(batches, [["one"], ["one"]]);
  assert.equal(queue.pendingCount, 0);
});

test("HistoryWriteQueue keeps lines added while a write is in flight", async () => {
  let releaseFirstWrite;
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const batches = [];
  let calls = 0;
  const queue = new HistoryWriteQueue({
    writeBatch: async (batch) => {
      calls += 1;
      batches.push(batch.map((item) => `${item.id}:${item.translation}`));
      if (calls === 1) await firstWriteGate;
    },
    retryDelaysMs: [],
    debounceMs: 60_000
  });

  queue.enqueue([line("one", "first")]);
  const flushing = queue.flush({ drain: true });
  queue.enqueue([line("one", "updated"), line("two", "new")]);
  releaseFirstWrite();
  await flushing;

  assert.deepEqual(batches, [
    ["one:first"],
    ["one:updated", "two:new"]
  ]);
  assert.equal(queue.pendingCount, 0);
});

test("HistoryWriteQueue does not let an old write erase a newer line", async () => {
  let releaseWrite;
  const gate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const queue = new HistoryWriteQueue({
    writeBatch: async () => gate,
    retryDelaysMs: [],
    debounceMs: 60_000
  });

  queue.enqueue([line("one", "old")]);
  const flushing = queue.flush();
  queue.enqueue([line("one", "new")]);
  releaseWrite();
  await flushing;

  assert.equal(queue.pendingCount, 1);
  const batch = await queue.flush({ drain: true });
  assert.equal(batch[0].translation, "new");
});
