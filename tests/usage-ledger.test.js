import assert from "node:assert/strict";
import test from "node:test";

import {
  USAGE_LEDGER_RETENTION_DAYS,
  addUsageToLedger,
  emptyLedger,
  ledgerDayKey,
  ledgerMonthKey,
  normalizeLedger,
  pruneLedger,
  summarizeLedger,
  totalTokens,
  usageBucketKey
} from "../extension/lib/usage-ledger.js";

// Local noon, so the day key cannot slip across a timezone boundary.
const NOON = new Date(2026, 10, 5, 12, 0, 0).getTime();

test("ledger day and month keys use the local calendar", () => {
  assert.equal(ledgerDayKey(NOON), "2026-11-05");
  assert.equal(ledgerMonthKey(NOON), "2026-11");
});

test("usage buckets keep the model apart from the provider", () => {
  assert.equal(usageBucketKey({ provider: "bailian", model: "qwen-mt-flash" }), "bailian:qwen-mt-flash");
  assert.equal(usageBucketKey({ provider: "deepl" }), "deepl");
  assert.equal(usageBucketKey({}), "unknown");
});

test("addUsageToLedger accumulates per day and per model", () => {
  let ledger = addUsageToLedger(emptyLedger(), {
    key: "bailian:qwen-mt-flash",
    usage: { requests: 2, promptTokens: 100, completionTokens: 30 },
    at: NOON
  });
  ledger = addUsageToLedger(ledger, {
    key: "bailian:qwen-mt-flash",
    usage: { requests: 1, promptTokens: 50, completionTokens: 20 },
    at: NOON
  });
  ledger = addUsageToLedger(ledger, {
    key: "deepl",
    usage: { requests: 1, billedCharacters: 240 },
    at: NOON
  });

  const day = ledger.days["2026-11-05"];
  assert.deepEqual(day["bailian:qwen-mt-flash"], {
    requests: 3,
    promptTokens: 150,
    completionTokens: 50,
    billedCharacters: 0
  });
  assert.deepEqual(day.deepl, {
    requests: 1,
    promptTokens: 0,
    completionTokens: 0,
    billedCharacters: 240
  });
  assert.equal(ledger.updatedAt, NOON);
  assert.equal(totalTokens(day["bailian:qwen-mt-flash"]), 200);
});

test("summarizeLedger reports today, the month, and a per-model split", () => {
  let ledger = addUsageToLedger(emptyLedger(), {
    key: "deepl",
    usage: { requests: 2, billedCharacters: 300 },
    at: NOON
  });
  // Earlier in the same month, a different provider.
  ledger = addUsageToLedger(ledger, {
    key: "bailian:qwen3.7-flash",
    usage: { requests: 4, promptTokens: 400, completionTokens: 100 },
    at: new Date(2026, 10, 1, 9, 0, 0).getTime()
  });
  // Previous month must not count.
  ledger = addUsageToLedger(ledger, {
    key: "deepl",
    usage: { requests: 9, billedCharacters: 900 },
    at: new Date(2026, 9, 28, 9, 0, 0).getTime()
  });

  const summary = summarizeLedger(ledger, NOON);
  assert.equal(summary.today.requests, 2);
  assert.equal(summary.today.billedCharacters, 300);
  assert.equal(summary.month.requests, 6);
  assert.equal(summary.month.billedCharacters, 300);
  assert.equal(summary.month.promptTokens, 400);
  assert.deepEqual(Object.keys(summary.byKey).sort(), ["bailian:qwen3.7-flash", "deepl"]);
});

test("pruneLedger drops days past the retention window", () => {
  const old = new Date(2026, 10, 5, 12, 0, 0).getTime();
  let ledger = addUsageToLedger(emptyLedger(), {
    key: "deepl",
    usage: { requests: 1, billedCharacters: 10 },
    at: old
  });
  const beyond = old + (USAGE_LEDGER_RETENTION_DAYS + 1) * 86400000;
  ledger = pruneLedger(ledger, beyond);
  assert.deepEqual(ledger.days, {});
});

test("a malformed stored ledger degrades to an empty one", () => {
  assert.deepEqual(normalizeLedger(null), emptyLedger());
  assert.deepEqual(normalizeLedger({ days: "nope" }), emptyLedger());
  const cleaned = normalizeLedger({
    days: {
      "2026-11-05": { deepl: { requests: "3", billedCharacters: null } },
      "not-a-day": { deepl: { requests: 1 } }
    }
  });
  assert.deepEqual(Object.keys(cleaned.days), ["2026-11-05"]);
  assert.deepEqual(cleaned.days["2026-11-05"].deepl, {
    requests: 3,
    promptTokens: 0,
    completionTokens: 0,
    billedCharacters: 0
  });
});
