/**
 * API-mode translation scheduling: which committed rows go to the model, when,
 * in which batch, and how failures retry or fall back. The throttled request
 * for the unfinished ASR buffer lives in buffer-translation.js; this module
 * owns the state both streams share (generation, usage, last error).
 *
 * Pure: no chrome.*, no DOM. Everything outside (runtime state, settings,
 * the HTTP translator, broadcasting, timers) is injected, so tests can drive
 * the whole schedule with a fake clock.
 */
import { createBufferTranslation } from "./buffer-translation.js";
import { cleanText, selectDisplayCaption } from "./caption-utils.js";
import { polishTranslation, stripSpeechFillers } from "./speech-cleanup.js";
import { lineSignature } from "./transcript-reducer.js";
import { isAbortError, recentTranslationContext } from "./translation-api.js";
import { planTranslationBatch } from "./utterance.js";

export {
  TRANSLATION_BUFFER_DEBOUNCE_MS,
  TRANSLATION_BUFFER_MIN_INTERVAL_MS
} from "./buffer-translation.js";

export const TRANSLATION_LINE_DEBOUNCE_MS = 160;
export const TRANSLATION_LINE_BATCH_SIZE = 6;
export const TRANSLATION_LINE_MAX_ATTEMPTS = 3;
export const TRANSLATION_LINE_RETRY_DELAYS_MS = Object.freeze([1200, 3000]);
export const TRANSLATION_STOP_TIMEOUT_MS = 15000;
/** The buffer request yields to the line queue only above this backlog. */
export const TRANSLATION_BUFFER_MAX_BACKLOG = 2;
const LINE_FOLLOW_UP_DELAY_MS = 250;
const MAX_FLUSH_ROUNDS = 12;

const NON_RETRYABLE_CODES = new Set([
  "auth",
  "balance",
  "config",
  "bad_request",
  "thinking_only",
  "empty_translation",
  "truncated"
]);

export function shouldRetryTranslationError(error) {
  return !NON_RETRYABLE_CODES.has(error?.code);
}

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function emptyUsage() {
  return { requests: 0, promptTokens: 0, completionTokens: 0 };
}

/**
 * @typedef {object} TranslationUsage
 * @property {number} requests
 * @property {number} promptTokens
 * @property {number} completionTokens
 */

/**
 * @typedef {object} TranslationSchedulerDeps
 * @property {() => any} getState Live runtime state; the scheduler patches
 *   `current.lines[*]`, `current.bufferTranslation`, `current.translationError`,
 *   `current.displayCaption` and `translation` in place.
 * @property {() => any} getConfig Resolved translation config (mode, enabled,
 *   provider, model, glossary entries ...), read fresh on every decision.
 * @property {(options: any) => Promise<{ translations: string[], usage?: any }>} translateTexts
 * @property {Map<string, any>} knownLines Last known copy of every session row,
 *   including rows that already left the runtime window.
 * @property {(lines: any[]) => void} enqueueHistory
 * @property {(change: { reason: string, lineIds?: string[] }) => (Promise<void> | void)} publish
 *   Persists and broadcasts the patched state. `change` says what moved, for
 *   callers that want to send less than the whole caption state.
 * @property {() => boolean} [isApiEnabled] Defaults to `getConfig().enabled`.
 * @property {() => boolean} [partialEnabled] Whether the unfinished buffer is translated.
 * @property {(callback: () => void, ms: number) => any} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 * @property {() => number} [now]
 */

/** @param {TranslationSchedulerDeps} deps */
export function createTranslationScheduler(deps) {
  const {
    getState,
    getConfig,
    translateTexts,
    knownLines,
    enqueueHistory,
    publish,
    isApiEnabled = () => Boolean(getConfig().enabled),
    partialEnabled = () => true,
    setTimeout: setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimeout: clearTimer = globalThis.clearTimeout.bind(globalThis),
    now = Date.now
  } = deps;

  const pending = new Map();
  const failed = new Map();
  let flushTimer = null;
  let flushPromise = null;
  let retryTimer = null;
  let lineAbort = null;
  /** @type {TranslationUsage} */
  let usage = emptyUsage();
  let lastError = "";
  let generation = 0;

  function delay(ms) {
    return new Promise((resolve) => {
      setTimer(resolve, ms);
    });
  }

  function sessionActive() {
    return Boolean(getState().active);
  }

  function runtimeLines() {
    return getState().current?.lines || [];
  }

  function refreshSummary() {
    const config = getConfig();
    getState().translation = {
      mode: config.mode,
      provider: config.provider,
      providerLabel: config.providerLabel,
      model: config.model,
      enabled: config.enabled,
      usage: { ...usage },
      error: lastError
    };
  }

  function abortLine() {
    if (!lineAbort) return;
    try {
      lineAbort.abort();
    } catch {
      // Ignore abort races.
    }
    lineAbort = null;
  }

  function addUsage(value) {
    usage.requests += 1;
    usage.promptTokens += Number(value?.promptTokens) || 0;
    usage.completionTokens += Number(value?.completionTokens) || 0;
  }

  const buffer = createBufferTranslation({
    getState,
    getConfig,
    isApiEnabled,
    partialEnabled,
    translateTexts,
    isLineBacklogged: () => pending.size > TRANSLATION_BUFFER_MAX_BACKLOG || Boolean(flushPromise),
    generation: () => generation,
    recordSuccess: (value) => {
      addUsage(value);
      lastError = "";
    },
    recordFailure: (error) => {
      lastError = cleanText(error?.message || error);
      return shouldRetryTranslationError(error);
    },
    publish: (change) => publishCaptions(change),
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    now
  });

  function patchRuntimeLine(lineId, patch) {
    const line = runtimeLines().find((item) => item?.id === lineId);
    if (line) Object.assign(line, patch);
    return line || null;
  }

  function markLineFailed(lineId) {
    const patch = { translationPending: false, translationFailed: true };
    const line = patchRuntimeLine(lineId, patch) || knownLines.get(lineId);
    if (!line) return;
    const updated = { ...line, ...patch };
    knownLines.set(lineId, updated);
    enqueueHistory([updated]);
  }

  async function publishCaptions(change) {
    const state = getState();
    if (!state.current) return;
    if (getConfig().mode === "api") {
      state.current.translationError = lastError;
    }
    state.current.displayCaption = selectDisplayCaption(state.current);
    refreshSummary();
    await publish(change);
  }

  async function applyLineTranslations(entries, translations, fallback = false) {
    const startGeneration = generation;
    const applied = [];
    const emptyEntries = [];
    let sourceChanged = false;
    for (let index = 0; index < entries.length; index += 1) {
      if (startGeneration !== generation) {
        return { applied: 0, sourceChanged, emptyEntries };
      }
      const [lineId, entry] = entries[index];
      const runtimeLine = runtimeLines().find((item) => item?.id === lineId);
      // A slow response may arrive after the line fell out of the 120-line
      // runtime window. Keep translating it into history from the last known
      // copy instead of silently losing a final subtitle.
      const line = runtimeLine || knownLines.get(lineId);
      if (!line || line.source !== entry.source) {
        const queued = pending.get(lineId);
        if (queued && line?.source) {
          queued.source = line.source;
          queued.attempts = 0;
          queued.fallback = cleanText(line.fallbackTranslation);
          sourceChanged = true;
        } else {
          pending.delete(lineId);
        }
        continue;
      }
      const text = polishTranslation(cleanText(translations[index]));
      if (!text) {
        // The model returned an empty slot. Count it so one untranslatable
        // marker cannot be retried forever and starve later lines.
        emptyEntries.push([lineId, entry]);
        continue;
      }
      const patch = {
        translation: text,
        translationPending: false,
        translationFailed: false,
        translationFallback: fallback
      };
      if (runtimeLine) patchRuntimeLine(lineId, patch);
      const updated = {
        ...line,
        ...patch,
        signature: lineSignature(line.source, text)
      };
      knownLines.set(lineId, updated);
      enqueueHistory([updated]);
      pending.delete(lineId);
      applied.push(updated);
    }
    if (applied.length > 0) {
      await publishCaptions({ reason: "lines", lineIds: applied.map((item) => item.id) });
    }
    return { applied: applied.length, sourceChanged, emptyEntries };
  }

  async function applyPendingFallbacks() {
    const fallbacks = [];
    for (const [lineId, entry] of [...pending.entries()]) {
      if (entry.fallback) {
        fallbacks.push([lineId, entry]);
      } else {
        pending.delete(lineId);
        failed.set(lineId, entry.source);
        markLineFailed(lineId);
      }
    }
    if (fallbacks.length > 0) {
      await applyLineTranslations(
        fallbacks,
        fallbacks.map(([, entry]) => entry.fallback),
        true
      );
    }
  }

  function collectPending() {
    if (!isApiEnabled()) return;
    for (const line of runtimeLines()) {
      if (!line?.id || !line.source || line.translation) continue;
      if (failed.get(line.id) === line.source) continue;
      const existing = pending.get(line.id);
      if (existing) {
        if (existing.source !== line.source) {
          existing.source = line.source;
          existing.attempts = 0;
        }
        existing.promptText = stripSpeechFillers(line.source);
        existing.fallback = cleanText(line.fallbackTranslation) || existing.fallback;
        continue;
      }
      pending.set(line.id, {
        source: line.source,
        // Only what leaves for the API is cleaned; the displayed transcript
        // keeps the verbatim ASR text.
        promptText: stripSpeechFillers(line.source),
        attempts: 0,
        fallback: cleanText(line.fallbackTranslation),
        // queuedAt lets planTranslationBatch decide when a trailing fragment
        // has waited long enough for the row that would complete its sentence.
        queuedAt: now()
      });
    }
  }

  function scheduleLines(wait = TRANSLATION_LINE_DEBOUNCE_MS) {
    if (!isApiEnabled() || !sessionActive()) return;
    collectPending();
    if (pending.size === 0) return;
    if (retryTimer) return;
    if (flushTimer || flushPromise) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      void flushLines();
    }, Math.max(0, wait));
  }

  async function handleFailure(entries, error) {
    const startGeneration = generation;
    lastError = cleanText(error?.message || error);
    const retryable = shouldRetryTranslationError(error);
    const fallbacks = [];
    let nextRetryAttempts = Infinity;
    for (const [lineId, entry] of entries) {
      if (startGeneration !== generation) return;
      entry.attempts += 1;
      if (!retryable || entry.attempts >= TRANSLATION_LINE_MAX_ATTEMPTS) {
        if (entry.fallback) {
          fallbacks.push([lineId, entry]);
        } else {
          failed.set(lineId, entry.source);
          markLineFailed(lineId);
        }
        pending.delete(lineId);
      } else {
        nextRetryAttempts = Math.min(nextRetryAttempts, entry.attempts);
      }
    }
    if (fallbacks.length > 0) {
      await applyLineTranslations(
        fallbacks,
        fallbacks.map(([, entry]) => entry.fallback),
        true
      );
    } else {
      await publishCaptions({ reason: "error" });
    }
    if (
      retryable &&
      Number.isFinite(nextRetryAttempts) &&
      sessionActive() &&
      startGeneration === generation
    ) {
      const wait =
        TRANSLATION_LINE_RETRY_DELAYS_MS[
          Math.min(nextRetryAttempts - 1, TRANSLATION_LINE_RETRY_DELAYS_MS.length - 1)
        ];
      clearTimer(retryTimer);
      retryTimer = setTimer(() => {
        retryTimer = null;
        scheduleLines(0);
      }, wait);
    }
  }

  async function flushLines() {
    if (flushPromise) return flushPromise;
    const startGeneration = generation;
    const promise = (async () => {
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
        if (!sessionActive() || startGeneration !== generation || !isApiEnabled()) {
          return;
        }
        collectPending();
        if (pending.size === 0) return;
        // Fragments are translated together with the rows that complete them;
        // a trailing fragment is held briefly instead of becoming an orphan
        // sentence ("他找到了。" with no object on screen).
        const plan = planTranslationBatch([...pending.entries()], {
          maxLines: TRANSLATION_LINE_BATCH_SIZE,
          now: now()
        });
        const entries = plan.batch;
        if (entries.length === 0) return;
        const batchIds = new Set(entries.map(([lineId]) => lineId));
        const config = getConfig();
        if (!config.enabled) {
          await handleFailure(entries, codedError(config.issue || "翻译 API 未启用", "config"));
          return;
        }
        let result;
        const controller = new AbortController();
        lineAbort = controller;
        try {
          result = await translateTexts({
            texts: entries.map(([, entry]) => entry.promptText || entry.source),
            // The batch ids keep this request's own rows out of the context,
            // otherwise a sentence appears in both segments and context.
            context: recentTranslationContext(runtimeLines(), undefined, batchIds),
            config,
            signal: controller.signal
          });
        } catch (error) {
          if (isAbortError(error)) return;
          await handleFailure(entries, error);
          return;
        } finally {
          if (lineAbort === controller) lineAbort = null;
        }
        if (startGeneration !== generation) return;
        lastError = "";
        addUsage(result.usage);
        const outcome = await applyLineTranslations(entries, result.translations);
        if (outcome.emptyEntries.length > 0) {
          await handleFailure(
            outcome.emptyEntries,
            codedError("翻译 API 返回了空译文", "empty_translation")
          );
          if (pending.size > 0 && sessionActive() && !retryTimer) {
            scheduleLines(LINE_FOLLOW_UP_DELAY_MS);
          }
          return;
        }
        if (outcome.applied === 0) {
          if (outcome.sourceChanged) {
            // The ASR row grew while the request was in flight. Retranslate
            // the newest source on the next loop instead of counting it as
            // missing.
            continue;
          }
          await handleFailure(
            entries,
            codedError("翻译 API 没有返回对应译文", "empty_translation")
          );
          return;
        }
      }
    })();
    flushPromise = promise;
    try {
      await promise;
    } finally {
      if (flushPromise === promise) flushPromise = null;
      if (
        pending.size > 0 &&
        sessionActive() &&
        !retryTimer &&
        startGeneration === generation
      ) {
        scheduleLines(LINE_FOLLOW_UP_DELAY_MS);
      }
    }
    return promise;
  }

  async function settle(timeoutMs = TRANSLATION_STOP_TIMEOUT_MS) {
    if (!isApiEnabled()) {
      await applyPendingFallbacks();
      return;
    }
    buffer.cancel();
    const startGeneration = generation;
    const deadline = now() + timeoutMs;
    collectPending();
    while (now() < deadline && startGeneration === generation && isApiEnabled()) {
      collectPending();
      if (pending.size === 0 && !flushPromise) break;
      const remaining = Math.max(0, deadline - now());
      await Promise.race([flushPromise || flushLines(), delay(Math.min(remaining, 600))]);
      if (pending.size === 0) break;
      await delay(30);
    }
    const inFlight = flushPromise;
    if (inFlight) {
      await Promise.race([inFlight, delay(1200)]);
    }
    if (flushPromise) {
      // Abort a request that outlived the stop deadline; otherwise it could
      // finish after the summary and be discarded.
      abortLine();
      await Promise.race([flushPromise, delay(500)]);
    }
    if (startGeneration === generation) await applyPendingFallbacks();
  }

  function reset({ keepUsage = false } = {}) {
    generation += 1;
    clearTimer(flushTimer);
    clearTimer(retryTimer);
    flushTimer = null;
    retryTimer = null;
    flushPromise = null;
    abortLine();
    pending.clear();
    failed.clear();
    lastError = "";
    buffer.reset();
    if (!keepUsage) usage = emptyUsage();
    refreshSummary();
  }

  /** Translation settings changed: forget failures and retry with the new config. */
  function handleConfigChanged() {
    failed.clear();
    lastError = "";
    clearTimer(retryTimer);
    retryTimer = null;
    buffer.reset({ keepInterval: true });
    if (sessionActive() && isApiEnabled()) {
      scheduleLines(0);
      buffer.schedule();
    }
  }

  return {
    scheduleLines,
    flushLines,
    scheduleBuffer: buffer.schedule,
    flushBuffer: buffer.flush,
    cancelBuffer: buffer.cancel,
    abortStaleBuffer: buffer.abortStale,
    settle,
    reset,
    handleConfigChanged,
    refreshSummary,
    /** Rebuild the queue from the rows already in runtime state. */
    resume() {
      scheduleLines(0);
      buffer.schedule();
    },
    /**
     * Restores the counters a recycled worker persisted in runtime state.
     * @param {{ usage?: Partial<TranslationUsage> | null, error?: string }} [stored]
     */
    restore({ usage: storedUsage = null, error = "" } = {}) {
      if (storedUsage) {
        usage = {
          requests: Number(storedUsage.requests) || 0,
          promptTokens: Number(storedUsage.promptTokens) || 0,
          completionTokens: Number(storedUsage.completionTokens) || 0
        };
      }
      lastError = error || "";
    },
    /** Makes every request still in flight discard its result. */
    invalidate() {
      generation += 1;
    },
    get lastError() {
      return lastError;
    },
    get usage() {
      return { ...usage };
    },
    /** Read-only view of the internals, for tests and diagnostics. */
    inspect() {
      return {
        pending: new Map([...pending].map(([id, entry]) => [id, { ...entry }])),
        failed: new Map(failed),
        generation,
        lineInFlight: Boolean(flushPromise),
        lineTimer: Boolean(flushTimer),
        retryTimer: Boolean(retryTimer),
        ...buffer.inspect(),
        lastError
      };
    }
  };
}
