/**
 * Usage accounting for the panel: a persistent local ledger plus the
 * account-level number when the provider publishes one.
 *
 * The ledger is written on a short throttle because one request can land every
 * few hundred milliseconds; the remote call is cached because DeepL and
 * DeepSeek rate-limit their own usage endpoints and the panel only opens
 * occasionally.
 *
 * This module touches chrome.* on purpose (background layer); the arithmetic and
 * the endpoint shapes live in lib/usage-ledger.js and lib/provider-usage.js, both
 * unit-tested without Chrome.
 */
import {
  addUsageToLedger,
  emptyLedger,
  normalizeLedger,
  summarizeLedger,
  usageBucketKey
} from "../lib/usage-ledger.js";
import {
  parseProviderUsage,
  providerUsageRequest
} from "../lib/provider-usage.js";

export const USAGE_LEDGER_STORAGE_KEY = "usageLedger";
/** One write per this window, however many requests arrive inside it. */
export const USAGE_FLUSH_DELAY_MS = 2000;
/** The panel asks again on every open; the account number rarely moves. */
export const USAGE_REMOTE_CACHE_MS = 5 * 60 * 1000;

/**
 * @param {{
 *   getConfig: () => any,
 *   storage?: chrome.storage.StorageArea,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   setTimeout?: (callback: () => void, ms: number) => any,
 *   clearTimeout?: (handle: any) => void
 * }} deps
 */
export function createUsageService({
  getConfig,
  storage = chrome.storage.local,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  setTimeout: setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout.bind(globalThis)
}) {
  /** @type {{ key: string, usage: Record<string, number> } | null} */
  let pending = null;
  let flushTimer = null;
  let flushChain = Promise.resolve();
  let remoteCache = { at: 0, value: null };

  /**
   * Adds one request's totals. Merged in memory until the flush window ends, so
   * a burst of requests costs one storage write.
   * @param {Record<string, number>} delta
   * @param {any} [config] Resolved translation config naming the provider/model.
   */
  function record(delta, config = getConfig()) {
    const key = usageBucketKey(config);
    if (!pending) {
      pending = { key, usage: { requests: 0, promptTokens: 0, completionTokens: 0, billedCharacters: 0 } };
    }
    // A provider switch mid-window keeps the two buckets apart instead of
    // crediting the new model with the old model's tokens.
    if (pending.key !== key) {
      const previous = pending;
      pending = {
        key,
        usage: { requests: 0, promptTokens: 0, completionTokens: 0, billedCharacters: 0 }
      };
      flushChain = flushChain.then(() => writeBucket(previous));
    }
    pending.usage.requests += Number(delta?.requests) || 0;
    pending.usage.promptTokens += Number(delta?.promptTokens) || 0;
    pending.usage.completionTokens += Number(delta?.completionTokens) || 0;
    pending.usage.billedCharacters += Number(delta?.billedCharacters) || 0;
    if (!flushTimer) {
      flushTimer = setTimer(() => {
        flushTimer = null;
        const current = pending;
        pending = null;
        if (current) flushChain = flushChain.then(() => writeBucket(current));
      }, USAGE_FLUSH_DELAY_MS);
    }
  }

  /** @param {{ key: string, usage: Record<string, number> }} bucket */
  async function writeBucket(bucket) {
    try {
      const stored = await storage.get(USAGE_LEDGER_STORAGE_KEY);
      const ledger = addUsageToLedger(
        normalizeLedger(stored?.[USAGE_LEDGER_STORAGE_KEY]),
        { key: bucket.key, usage: bucket.usage, at: now() }
      );
      await storage.set({ [USAGE_LEDGER_STORAGE_KEY]: ledger });
    } catch (error) {
      // Losing one bucket must not break translation; the next flush rewrites a
      // fresh ledger from storage.
      console.error("usage ledger write failed", error);
    }
  }

  /** Waits for every queued write to land (used by tests and by shutdown). */
  async function flush() {
    if (flushTimer) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
    const current = pending;
    pending = null;
    if (current) flushChain = flushChain.then(() => writeBucket(current));
    await flushChain;
  }

  /** @returns {Promise<{ today: any, month: any, byKey: any, remote: any }>} */
  async function snapshot() {
    const config = getConfig();
    let ledger = emptyLedger();
    try {
      const stored = await storage.get(USAGE_LEDGER_STORAGE_KEY);
      ledger = normalizeLedger(stored?.[USAGE_LEDGER_STORAGE_KEY]);
    } catch (error) {
      console.error("usage ledger read failed", error);
    }
    // Snapshot what is still in memory so a fresh session shows up immediately.
    if (pending) {
      ledger = addUsageToLedger(ledger, {
        key: pending.key,
        usage: pending.usage,
        at: now()
      });
    }
    const summary = summarizeLedger(ledger, now());
    return {
      today: summary.today,
      month: summary.month,
      byKey: summary.byKey,
      remote: await readRemote(config)
    };
  }

  /**
   * Account-level usage, cached. `unavailable` explains why a provider has no
   * number instead of silently showing nothing.
   * @param {any} config
   */
  async function readRemote(config) {
    const request = providerUsageRequest(config);
    if (!request) {
      return {
        provider: config?.provider || "",
        kind: "unavailable",
        reason: remoteUnavailableReason(config)
      };
    }
    if (
      remoteCache.value &&
      remoteCache.value.provider === config?.provider &&
      now() - remoteCache.at < USAGE_REMOTE_CACHE_MS
    ) {
      return remoteCache.value;
    }
    try {
      const response = await fetchImpl(request.url, {
        headers: { Accept: "application/json", ...request.headers }
      });
      if (!response.ok) {
        return {
          provider: config.provider,
          kind: "error",
          reason: `http_${response.status}`
        };
      }
      const data = await response.json();
      const parsed = { provider: config.provider, ...parseProviderUsage(config.provider, data) };
      remoteCache = { at: now(), value: parsed };
      return parsed;
    } catch (error) {
      return {
        provider: config.provider,
        kind: "error",
        reason: String(error?.message || error).slice(0, 120)
      };
    }
  }

  /** Drops the cached account number so the next open refetches. */
  function invalidateRemote() {
    remoteCache = { at: 0, value: null };
  }

  return { record, flush, snapshot, invalidateRemote };
}

/** Why a provider cannot answer "how much is left" through its API key. */
function remoteUnavailableReason(config) {
  const provider = String(config?.provider || "");
  if (provider === "bailian") return "console_only";
  if (provider === "openai") return "admin_key_required";
  if (config?.builtin) return "free";
  if (provider === "custom") return "local_or_unknown";
  return "unsupported";
}
