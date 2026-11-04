/**
 * API-mode translation scheduling: which committed rows go to the model, when,
 * in which batch, and how failures retry or fall back. Half-sentence Chinese
 * comes from the growing row's stage translation (see caption-utils.js), so
 * there is no separate request for the unfinished ASR buffer.
 *
 * Pure: no chrome.*, no DOM. Everything outside (runtime state, settings,
 * the HTTP translator, broadcasting, timers) is injected, so tests can drive
 * the whole schedule with a fake clock.
 */
import {
  TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS,
  cleanText,
  selectDisplayCaption,
  shouldRetranslateLine
} from "./caption-utils.js";
import { LocalizedError, errorMessage, isLocalMessage, msg, renderWith } from "./i18n-message.js";
import { polishTranslation, stripSpeechFillers } from "./speech-cleanup.js";
import { lineSignature } from "./transcript-reducer.js";
import { createTranslationCooldown } from "./translation-cooldown.js";
import {
  isAbortError,
  isSplittableTranslationError,
  recentTranslationContext
} from "./translation-api.js";
import { planTranslationBatch } from "./utterance.js";

export const TRANSLATION_LINE_DEBOUNCE_MS = 160;
export const TRANSLATION_LINE_BATCH_SIZE = 6;
/**
 * Line requests in flight at once. A request costs about a second whatever
 * its size (measured on DeepSeek: 1 row 0.94 s, 6 rows 1.24 s), so a row that
 * finished while another request ran used to wait up to twice that.
 */
export const TRANSLATION_LINE_CONCURRENCY = 2;
export const TRANSLATION_LINE_MAX_ATTEMPTS = 3;
export const TRANSLATION_LINE_RETRY_DELAYS_MS = Object.freeze([1200, 3000]);
export const TRANSLATION_STOP_TIMEOUT_MS = 15000;
const LINE_FOLLOW_UP_DELAY_MS = 250;

const MAX_FLUSH_ROUNDS = 12;

const NON_RETRYABLE_CODES = new Set([
  "auth",
  "balance",
  "config",
  "bad_request",
  "quota",
  "thinking_only",
  "empty_translation",
  "truncated"
]);

export function shouldRetryTranslationError(error) {
  return !NON_RETRYABLE_CODES.has(error?.code);
}

/** @param {import("./i18n-message.js").LocalMessage | string} message */
function codedError(message, code) {
  const error = isLocalMessage(message) ? new LocalizedError(message) : new Error(message);
  return Object.assign(error, { code });
}

function emptyUsage() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, billedCharacters: 0 };
}

/**
 * @typedef {object} TranslationUsage
 * @property {number} requests
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} billedCharacters DeepL bills characters, not tokens.
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
 * @property {(callback: () => void, ms: number) => any} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 * @property {() => number} [now]
 * @property {() => number} [random] Jitter source in [0, 1); defaults to Math.random.
 * @property {(error: unknown) => string} [describeError] Localized text for a
 *   failure; lib errors carry a message key (see i18n-message.js).
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
    setTimeout: setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimeout: clearTimer = globalThis.clearTimeout.bind(globalThis),
    now = Date.now,
    random = Math.random,
    describeError = (error) => String(renderWith((key) => key, errorMessage(error)))
  } = deps;

  const pending = new Map();
  const failed = new Map();
  let flushTimer = null;
  /** @type {Set<Promise<void>>} running flush workers */
  const workers = new Set();
  let retryTimer = null;
  /** Waits out the retranslate throttle of a growing row (see shouldRetranslateLine). */
  let wakeTimer = null;
  /** @type {Set<AbortController>} */
  const lineAborts = new Set();
  /**
   * What the last request asked for, per row, and when. A row that grew by two
   * words is not retranslated just because another ASR update landed.
   * @type {Map<string, { source: string, at: number }>}
   */
  let retranslateGuards = new Map();
  /** @type {TranslationUsage} */
  let usage = emptyUsage();
  let lastError = "";
  let generation = 0;

  function delay(ms) {
    return new Promise((resolve) => {
      setTimer(resolve, ms);
    });
  }

  // One cooldown for both streams (see translation-cooldown.js).
  const cooldown = createTranslationCooldown({
    now,
    random,
    setTimeout: setTimer,
    clearTimeout: clearTimer
  });

  /** translateTexts behind the shared provider cooldown. */
  async function guardedTranslate(options) {
    await cooldown.wait(options?.signal);
    try {
      return await translateTexts(options);
    } catch (error) {
      cooldown.note(error);
      throw error;
    }
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
      model: config.model,
      enabled: config.enabled,
      usage: { ...usage },
      error: lastError
    };
  }

  function abortLine() {
    for (const controller of lineAborts) {
      try {
        controller.abort();
      } catch {
        // Ignore abort races.
      }
    }
    lineAborts.clear();
  }

  /**
   * Rows waiting for a request, as [lineId, entry]; in-flight rows excluded.
   * A growing row that already shows a stage translation is held until either
   * enough new text or enough time has passed (see shouldRetranslateLine), and
   * the wake timer makes sure the newer source is not dropped silently.
   */
  function waitingEntries() {
    const at = now();
    const waiting = [];
    for (const [lineId, entry] of pending) {
      if (entry.inFlight) continue;
      if (shouldHoldRetranslation(lineId, entry, at)) continue;
      waiting.push([lineId, entry]);
    }
    return waiting;
  }

  /**
   * Whether this row's newer source has to wait for the throttle window.
   * The wake timer re-runs the queue once the window is over, so a held row is
   * delayed, never lost.
   */
  function shouldHoldRetranslation(lineId, entry, at) {
    const line =
      runtimeLines().find((item) => item?.id === lineId) || knownLines.get(lineId);
    if (!line?.translation) return false;
    const guard = retranslateGuards.get(lineId);
    const allowed = shouldRetranslateLine(line, guard, { now: at });
    if (allowed) return false;
    scheduleTranslationWake(
      TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS - (at - Number(guard?.at || 0))
    );
    return true;
  }

  function scheduleTranslationWake(delay) {
    if (wakeTimer || !sessionActive()) return;
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      scheduleLines(0);
    }, Math.max(50, Math.min(Number(delay) || 0, TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS)));
  }

  function addUsage(value) {
    usage.requests += 1;
    usage.promptTokens += Number(value?.promptTokens) || 0;
    usage.completionTokens += Number(value?.completionTokens) || 0;
    usage.billedCharacters += Number(value?.billedCharacters) || 0;
  }

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
      if (!line) {
        pending.delete(lineId);
        continue;
      }
      const text = polishTranslation(cleanText(translations[index]));
      if (!text) {
        // The model returned an empty slot. Count it so one untranslatable
        // marker cannot be retried forever and starve later lines.
        emptyEntries.push([lineId, entry]);
        continue;
      }
      // The recogniser kept appending to this row while the request was in
      // flight. Dropping the response was what postponed every subtitle to the
      // end of the sentence: apply it as a stage translation, keep it on
      // screen, and let the next round translate the newer source.
      const stale = line.source !== entry.source;
      if (stale) sourceChanged = true;
      const patch = {
        translation: text,
        translatedSource: entry.source,
        translationPending: stale,
        translationFailed: false,
        translationFallback: fallback
      };
      if (runtimeLine) patchRuntimeLine(lineId, patch);
      const updated = { ...line, ...patch };
      updated.signature = lineSignature(updated.source, updated.translation, stale);
      knownLines.set(lineId, updated);
      // Only a translation that matches the row's current source belongs in the
      // history and the SRT export; stage translations are screen-only.
      if (!stale) {
        enqueueHistory([updated]);
        retranslateGuards.delete(lineId);
      }
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
      if (!line?.id || !line.source) continue;
      // A row whose translation still matches its source is done. A row holding
      // a stage translation is not: the source grew under it and the newest
      // words have no translation yet.
      if (line.translation && !line.translationPending) continue;
      if (!line.translation && failed.get(line.id) === line.source) continue;
      const existing = pending.get(line.id);
      if (existing) {
        existing.fallback = cleanText(line.fallbackTranslation) || existing.fallback;
        // An in-flight entry has to keep saying what was sent: comparing it with
        // the row is how applyLineTranslations tells a stage translation from a
        // final one. The grown source gets its own entry after the response.
        if (existing.inFlight) continue;
        if (existing.source !== line.source) {
          existing.source = line.source;
          existing.attempts = 0;
        }
        existing.promptText = stripSpeechFillers(line.source);
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
    if (waitingEntries().length === 0) return;
    if (retryTimer) return;
    if (flushTimer || workers.size >= TRANSLATION_LINE_CONCURRENCY) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      void flushLines();
    }, Math.max(0, wait));
  }

  async function handleFailure(entries, error) {
    const startGeneration = generation;
    lastError = cleanText(describeError(error));
    const retryable = shouldRetryTranslationError(error);
    const fallbacks = [];
    let nextRetryAttempts = Infinity;
    for (const [lineId, entry] of entries) {
      if (startGeneration !== generation) return;
      // Another worker already finished this row.
      if (pending.get(lineId) !== entry) continue;
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

  /**
   * One line request. A batch-shape failure (wrong count, unparseable or
   * truncated output) is retried in halves before it counts as a failed
   * attempt: one awkward line no longer drags five good ones into a retry.
   * Returns null when the round was cancelled, { failed: true } when the
   * failure was recorded, { split: true } when the halves were handled here,
   * or the translator result. `excludeIds` keeps this request's rows and any
   * later rows of the original batch out of the context.
   */
  async function requestBatch(entries, excludeIds, config, startGeneration) {
    const controller = new AbortController();
    lineAborts.add(controller);
    // Remember what was asked and when, so a row that grew by two words is not
    // retranslated immediately (see shouldHoldRetranslation).
    const requestedAt = now();
    for (const [lineId, entry] of entries) {
      retranslateGuards.set(lineId, { source: entry.source, at: requestedAt });
    }
    let result;
    try {
      result = await guardedTranslate({
        texts: entries.map(([, entry]) => entry.promptText || entry.source),
        // The batch ids keep this request's own rows out of the context,
        // otherwise a sentence appears in both segments and context.
        context: recentTranslationContext(runtimeLines(), undefined, excludeIds),
        config,
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error) || startGeneration !== generation) return null;
      if (isSplittableTranslationError(error, entries.length)) {
        const middle = Math.ceil(entries.length / 2);
        const first = entries.slice(0, middle);
        // The second half may read the first half's fresh translations as
        // context; the first half must not see the later rows.
        const secondExclude = new Set(excludeIds);
        for (const [lineId] of first) secondExclude.delete(lineId);
        for (const [half, halfExclude] of [
          [first, excludeIds],
          [entries.slice(middle), secondExclude]
        ]) {
          if (startGeneration !== generation || !sessionActive()) return null;
          const halfResult = await requestBatch(half, halfExclude, config, startGeneration);
          if (!halfResult) return null;
          if (halfResult.split || halfResult.failed) continue;
          const outcome = await applyLineTranslations(half, halfResult.translations);
          if (outcome.emptyEntries.length > 0) {
            await handleFailure(
              outcome.emptyEntries,
              codedError(msg("translation_empty_translation"), "empty_translation")
            );
          }
        }
        return { split: true };
      }
      await handleFailure(entries, error);
      return { failed: true };
    } finally {
      lineAborts.delete(controller);
    }
    if (startGeneration !== generation) return null;
    lastError = "";
    addUsage(result.usage);
    return result;
  }

  /**
   * Starts flush workers up to TRANSLATION_LINE_CONCURRENCY while rows wait,
   * and resolves when every running worker has finished.
   */
  function flushLines() {
    collectPending();
    while (
      workers.size < TRANSLATION_LINE_CONCURRENCY &&
      waitingEntries().length > 0 &&
      sessionActive() &&
      isApiEnabled()
    ) {
      const before = workers.size;
      startWorker();
      // A worker that found nothing to send (only held fragments) is done.
      if (workers.size === before) break;
    }
    return Promise.all([...workers]).then(() => undefined);
  }

  function startWorker() {
    const startGeneration = generation;
    let claimed = false;
    const promise = (async () => {
      for (let round = 0; round < MAX_FLUSH_ROUNDS; round += 1) {
        if (!sessionActive() || startGeneration !== generation || !isApiEnabled()) {
          return;
        }
        collectPending();
        const waiting = waitingEntries();
        if (waiting.length === 0) return;
        // Fragments are translated together with the rows that complete them;
        // a trailing fragment is held briefly instead of becoming an orphan
        // sentence ("他找到了。" with no object on screen).
        const plan = planTranslationBatch(waiting, {
          maxLines: TRANSLATION_LINE_BATCH_SIZE,
          now: now()
        });
        const entries = plan.batch;
        if (entries.length === 0) return;
        claimed = true;
        const batchIds = new Set(entries.map(([lineId]) => lineId));
        const config = getConfig();
        if (!config.enabled) {
          await handleFailure(entries, codedError(config.issue || msg("translation_disabled"), "config"));
          return;
        }
        for (const [, entry] of entries) entry.inFlight = true;
        let result;
        try {
          result = await requestBatch(entries, batchIds, config, startGeneration);
        } finally {
          for (const [, entry] of entries) entry.inFlight = false;
        }
        if (!result || result.failed) return;
        // Halves that failed armed the retry timer; honour its delay.
        if (result.split) {
          if (retryTimer) return;
          continue;
        }
        const outcome = await applyLineTranslations(entries, result.translations);
        if (outcome.emptyEntries.length > 0) {
          await handleFailure(
            outcome.emptyEntries,
            codedError(msg("translation_empty_translation"), "empty_translation")
          );
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
            codedError(msg("translation_missing_line"), "empty_translation")
          );
          return;
        }
      }
    })();
    workers.add(promise);
    const release = () => {
      workers.delete(promise);
      // A stage translation leaves the queue, so a worker that ended on its
      // last round would otherwise leave that row behind with nothing to wake it.
      collectPending();
      if (
        waitingEntries().length > 0 &&
        sessionActive() &&
        !retryTimer &&
        startGeneration === generation
      ) {
        scheduleLines(LINE_FOLLOW_UP_DELAY_MS);
      }
    };
    void promise.then(release, release);
    // The planning above ran synchronously; a worker that claimed no rows
    // has already finished and must not count against the limit.
    if (!claimed) workers.delete(promise);
    return promise;
  }

  async function settle(timeoutMs = TRANSLATION_STOP_TIMEOUT_MS) {
    if (!isApiEnabled()) {
      await applyPendingFallbacks();
      return;
    }
    const startGeneration = generation;
    const deadline = now() + timeoutMs;
    collectPending();
    while (now() < deadline && startGeneration === generation && isApiEnabled()) {
      collectPending();
      if (pending.size === 0 && workers.size === 0) break;
      const remaining = Math.max(0, deadline - now());
      await Promise.race([flushLines(), delay(Math.min(remaining, 600))]);
      if (pending.size === 0) break;
      await delay(30);
    }
    if (workers.size > 0) {
      await Promise.race([Promise.all([...workers]), delay(1200)]);
    }
    if (workers.size > 0) {
      // Abort a request that outlived the stop deadline; otherwise it could
      // finish after the summary and be discarded.
      abortLine();
      await Promise.race([Promise.all([...workers]), delay(500)]);
    }
    if (startGeneration === generation) await applyPendingFallbacks();
  }

  function reset({ keepUsage = false } = {}) {
    generation += 1;
    clearTimer(flushTimer);
    clearTimer(retryTimer);
    clearTimer(wakeTimer);
    flushTimer = null;
    retryTimer = null;
    wakeTimer = null;
    workers.clear();
    abortLine();
    pending.clear();
    failed.clear();
    retranslateGuards = new Map();
    lastError = "";
    cooldown.reset();
    if (!keepUsage) usage = emptyUsage();
    refreshSummary();
  }

  /** Translation settings changed: forget failures and retry with the new config. */
  function handleConfigChanged() {
    failed.clear();
    lastError = "";
    clearTimer(retryTimer);
    retryTimer = null;
    if (sessionActive() && isApiEnabled()) scheduleLines(0);
  }

  return {
    scheduleLines,
    flushLines,
    settle,
    reset,
    handleConfigChanged,
    refreshSummary,
    /** Rebuild the queue from the rows already in runtime state. */
    resume() {
      scheduleLines(0);
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
          completionTokens: Number(storedUsage.completionTokens) || 0,
          billedCharacters: Number(storedUsage.billedCharacters) || 0
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
        lineInFlight: workers.size > 0,
        lineWorkers: workers.size,
        lineTimer: Boolean(flushTimer),
        retryTimer: Boolean(retryTimer),
        wakeTimer: Boolean(wakeTimer),
        cooldownMs: cooldown.remainingMs(),
        lastError
      };
    }
  };
}
