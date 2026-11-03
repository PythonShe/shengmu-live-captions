import assert from "node:assert/strict";
import test from "node:test";

// The overlay helper is a classic content script that publishes itself on the
// global object; importing it for side effects mirrors that environment.
import "../extension/content/overlay-history.js";

const { createHistoryLog, resetHistoryLog, syncHistoryLog } =
  globalThis.ShengmuOverlayHistory;

function line(id, order, source, translation = "") {
  return { id, order, source, translation };
}

test("history log appends normalized lines in order", () => {
  const log = createHistoryLog(60);
  assert.equal(
    syncHistoryLog(log, [
      line("a", 1, "hello", "你好"),
      line("b", 2, "world")
    ]),
    true
  );
  assert.deepEqual(
    log.entries.map((entry) => entry.id),
    ["a", "b"]
  );
  assert.equal(log.byId.get("b").translation, "");
  assert.equal(log.entries.length, 2);
});

test("history log keeps the same array and entries when nothing changed", () => {
  const log = createHistoryLog(60);
  const lines = [line("a", 1, "hello", "你好")];
  syncHistoryLog(log, lines);
  const entriesRef = log.entries;
  const entryRef = log.entries[0];

  assert.equal(syncHistoryLog(log, lines), false);
  assert.equal(log.entries, entriesRef);
  assert.equal(log.entries[0], entryRef);
  assert.equal(log.entries.length, 1);
});

test("history log patches late translations in place", () => {
  const log = createHistoryLog(60);
  syncHistoryLog(log, [line("a", 1, "hello"), line("b", 2, "world")]);
  const entryRef = log.byId.get("a");

  assert.equal(
    syncHistoryLog(log, [line("a", 1, "hello", "你好"), line("b", 2, "world")]),
    true
  );
  assert.equal(log.byId.get("a"), entryRef);
  assert.equal(entryRef.translation, "你好");
  assert.equal(log.entries.length, 2);
});

test("history log inserts out-of-order lines by order", () => {
  const log = createHistoryLog(60);
  syncHistoryLog(log, [line("c", 5, "third")]);
  syncHistoryLog(log, [line("a", 1, "first"), line("b", 3, "second")]);
  assert.deepEqual(
    log.entries.map((entry) => entry.id),
    ["a", "b", "c"]
  );
});

test("history log trims to the limit and forgets dropped ids", () => {
  const log = createHistoryLog(3);
  syncHistoryLog(log, [
    line("a", 1, "one"),
    line("b", 2, "two"),
    line("c", 3, "three"),
    line("d", 4, "four")
  ]);
  assert.deepEqual(
    log.entries.map((entry) => entry.id),
    ["b", "c", "d"]
  );
  assert.equal(log.byId.has("a"), false);
  assert.equal(log.byId.size, 3);
});

test("history log ignores empty lines and missing ids", () => {
  const log = createHistoryLog(60);
  assert.equal(
    syncHistoryLog(log, [
      { id: "", order: 1, source: "no id" },
      line("empty", 2, "", ""),
      null,
      line("ok", 3, "text")
    ]),
    true
  );
  assert.deepEqual(
    log.entries.map((entry) => entry.id),
    ["ok"]
  );
});

test("history log ignores lines older than the retained window", () => {
  const log = createHistoryLog(3);
  const windowLines = [1, 2, 3, 4, 5, 6].map((order) =>
    line(`s${order}`, order, `source ${order}`)
  );
  assert.equal(syncHistoryLog(log, windowLines), true);
  assert.deepEqual(
    log.entries.map((entry) => entry.id),
    ["s4", "s5", "s6"]
  );
  const entriesRef = log.entries;
  const firstEntryRef = log.entries[0];

  // The caller keeps broadcasting its whole window; the trimmed rows must not
  // be re-inserted and trimmed again on every sync.
  assert.equal(syncHistoryLog(log, windowLines), false);
  assert.equal(log.entries, entriesRef);
  assert.equal(log.entries[0], firstEntryRef);
});

test("history log reset clears entries and the id index", () => {
  const log = createHistoryLog(60);
  syncHistoryLog(log, [line("a", 1, "hello")]);
  resetHistoryLog(log);
  assert.equal(log.entries.length, 0);
  assert.equal(log.byId.size, 0);
});
