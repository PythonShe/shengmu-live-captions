/**
 * Cross-session translation usage totals.
 *
 * `runtimeState.translation.usage` only covers the running session: stopping the
 * capture clears it. This module keeps a small per-day ledger in storage so the
 * panel can answer "how much did I use today / this month", whether or not the
 * provider exposes an account-level counter.
 *
 * Pure: no chrome.*, no DOM, so Node's test runner can drive it with a fake
 * clock.
 */

export const USAGE_LEDGER_VERSION = 1;
/**
 * Days kept per provider+model. Long enough to see a month of use, short enough
 * that the record stays a few KB.
 */
export const USAGE_LEDGER_RETENTION_DAYS = 90;

/**
 * @typedef {object} UsageTotals
 * @property {number} requests
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} billedCharacters DeepL bills characters, not tokens.
 */

/** @returns {UsageTotals} */
export function emptyUsageTotals() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, billedCharacters: 0 };
}

/** @returns {{ version: number, days: Record<string, Record<string, UsageTotals>>, updatedAt: number }} */
export function emptyLedger() {
  return { version: USAGE_LEDGER_VERSION, days: {}, updatedAt: 0 };
}

/**
 * Local calendar day (`YYYY-MM-DD`), because "today" is what the user sees.
 * @param {number} at
 */
export function ledgerDayKey(at) {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local calendar month (`YYYY-MM`). @param {number} at */
export function ledgerMonthKey(at) {
  return ledgerDayKey(at).slice(0, 7);
}

/**
 * One bucket per provider + model: qwen-mt-flash and qwen3.7-flash bill
 * differently, so their totals must not be merged.
 * @param {{ provider?: string, model?: string, builtin?: boolean }} config
 */
export function usageBucketKey(config = {}) {
  const provider = String(config.provider || "unknown").trim() || "unknown";
  const model = String(config.model || "").trim();
  return model ? `${provider}:${model}` : provider;
}

/** @param {UsageTotals | undefined} totals */
export function totalTokens(totals) {
  return (Number(totals?.promptTokens) || 0) + (Number(totals?.completionTokens) || 0);
}

/**
 * Adds one session's totals to the ledger, immutably.
 * @param {any} ledger Stored ledger (may be missing or malformed).
 * @param {{ key?: string, usage?: Partial<UsageTotals> | null, at?: number }} [input]
 */
export function addUsageToLedger(ledger, { key, usage, at = Date.now() } = {}) {
  const base = normalizeLedger(ledger);
  if (!key) return base;
  const day = ledgerDayKey(at);
  const days = { ...base.days };
  const bucket = { ...(days[day] || {}) };
  const previous = bucket[key] || emptyUsageTotals();
  bucket[key] = {
    requests: previous.requests + (Number(usage?.requests) || 0),
    promptTokens: previous.promptTokens + (Number(usage?.promptTokens) || 0),
    completionTokens: previous.completionTokens + (Number(usage?.completionTokens) || 0),
    billedCharacters: previous.billedCharacters + (Number(usage?.billedCharacters) || 0)
  };
  days[day] = bucket;
  return pruneLedger({ ...base, days, updatedAt: at }, at);
}

/**
 * Drops days older than the retention window.
 * @param {any} ledger
 * @param {number} [at]
 * @param {number} [days]
 */
export function pruneLedger(ledger, at = Date.now(), days = USAGE_LEDGER_RETENTION_DAYS) {
  const base = normalizeLedger(ledger);
  const cutoff = ledgerDayKey(at - days * 86400000);
  /** @type {Record<string, any>} */
  const kept = {};
  for (const [day, bucket] of Object.entries(base.days)) {
    if (day >= cutoff) kept[day] = bucket;
  }
  return { ...base, days: kept };
}

/** @param {any} ledger */
export function normalizeLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || typeof ledger.days !== "object" || !ledger.days) {
    return emptyLedger();
  }
  /** @type {Record<string, Record<string, UsageTotals>>} */
  const days = {};
  for (const [day, bucket] of Object.entries(ledger.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !bucket || typeof bucket !== "object") continue;
    /** @type {Record<string, UsageTotals>} */
    const clean = {};
    for (const [key, totals] of Object.entries(bucket)) {
      if (!totals || typeof totals !== "object") continue;
      clean[key] = {
        requests: Number(totals.requests) || 0,
        promptTokens: Number(totals.promptTokens) || 0,
        completionTokens: Number(totals.completionTokens) || 0,
        billedCharacters: Number(totals.billedCharacters) || 0
      };
    }
    days[day] = clean;
  }
  return {
    version: USAGE_LEDGER_VERSION,
    days,
    updatedAt: Number(ledger.updatedAt) || 0
  };
}

/**
 * Today's and this month's totals across every provider.
 * @param {any} ledger
 * @param {number} [at]
 * @returns {{ today: UsageTotals, month: UsageTotals, byKey: Record<string, UsageTotals> }}
 */
export function summarizeLedger(ledger, at = Date.now()) {
  const base = normalizeLedger(ledger);
  const today = ledgerDayKey(at);
  const month = ledgerMonthKey(at);
  const todayTotals = emptyUsageTotals();
  const monthTotals = emptyUsageTotals();
  /** @type {Record<string, UsageTotals>} */
  const byKey = {};
  for (const [day, bucket] of Object.entries(base.days)) {
    if (!day.startsWith(month)) continue;
    for (const [key, totals] of Object.entries(bucket)) {
      addInto(monthTotals, totals);
      const entry = byKey[key] || emptyUsageTotals();
      addInto(entry, totals);
      byKey[key] = entry;
      if (day === today) addInto(todayTotals, totals);
    }
  }
  return { today: todayTotals, month: monthTotals, byKey };
}

/** @param {UsageTotals} target @param {UsageTotals} source */
function addInto(target, source) {
  target.requests += source.requests;
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.billedCharacters += source.billedCharacters;
}
