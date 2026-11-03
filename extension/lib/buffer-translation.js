/**
 * The throttled translation of the unfinished ASR buffer: the half-sentence
 * that is still growing on screen. It runs beside the committed-line queue in
 * translation-scheduler.js and shares its generation, usage and error state
 * through the callbacks below.
 *
 * Pure: no chrome.*, no DOM.
 */
import { cleanText } from "./caption-utils.js";
import { polishTranslation, stripSpeechFillers } from "./speech-cleanup.js";
import { isAbortError, recentTranslationContext } from "./translation-api.js";

export const TRANSLATION_BUFFER_DEBOUNCE_MS = 450;
export const TRANSLATION_BUFFER_MIN_INTERVAL_MS = 1200;
const YIELD_DELAY_MS = 300;

/**
 * @typedef {object} BufferTranslationDeps
 * @property {() => any} getState Live runtime state; `current.bufferSource` is
 *   read and `current.bufferTranslation` written in place.
 * @property {() => any} getConfig
 * @property {() => boolean} isApiEnabled
 * @property {() => boolean} partialEnabled
 * @property {(options: any) => Promise<{ translations: string[], usage?: any }>} translateTexts
 * @property {() => boolean} isLineBacklogged True while committed rows should go first.
 * @property {() => number} generation The scheduler's current generation.
 * @property {(usage: any) => void} recordSuccess
 * @property {(error: any) => boolean} recordFailure Records the error and
 *   reports whether it is worth retrying.
 * @property {(change: { reason: string }) => Promise<void>} publish
 * @property {(callback: () => void, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 * @property {() => number} now
 */

/** @param {BufferTranslationDeps} deps */
export function createBufferTranslation(deps) {
  const {
    getState,
    getConfig,
    isApiEnabled,
    partialEnabled,
    translateTexts,
    isLineBacklogged,
    generation,
    recordSuccess,
    recordFailure,
    publish,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    now
  } = deps;

  let timer = null;
  let inFlight = false;
  let abortSlot = null;
  let requestedText = "";
  let lastRequestAt = 0;

  function sessionActive() {
    return Boolean(getState().active);
  }

  function bufferText() {
    return cleanText(getState().current?.bufferSource);
  }

  function cancel() {
    clearTimer(timer);
    timer = null;
    if (abortSlot) {
      try {
        abortSlot.abort();
      } catch {
        // Ignore abort races.
      }
      abortSlot = null;
    }
    inFlight = false;
  }

  function schedule() {
    if (!isApiEnabled() || !partialEnabled() || !sessionActive()) return;
    const text = bufferText();
    if (!text) {
      cancel();
      requestedText = "";
      return;
    }
    if (text === requestedText) return;
    // Do not restart the debounce on every partial update: live buffers change
    // several times per second, and a reset-on-change timer would never fire.
    if (timer) return;
    const wait = Math.max(
      TRANSLATION_BUFFER_DEBOUNCE_MS,
      lastRequestAt + TRANSLATION_BUFFER_MIN_INTERVAL_MS - now()
    );
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, wait);
  }

  function retryLater() {
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, YIELD_DELAY_MS);
  }

  async function flush() {
    const startGeneration = generation();
    if (!sessionActive() || !isApiEnabled()) return;
    const text = bufferText();
    if (!text) return;
    // The half-sentence on screen matters more than the backlog: waiting for
    // the whole line queue to drain starved the buffer translation completely,
    // so the reader kept seeing the previous sentence while finished rows
    // queued up. Only a real backlog makes it wait.
    if (isLineBacklogged() || inFlight) {
      retryLater();
      return;
    }
    if (text === requestedText) return;
    const config = getConfig();
    if (!config.enabled) return;

    inFlight = true;
    requestedText = text;
    lastRequestAt = now();
    const controller = new AbortController();
    abortSlot = controller;
    try {
      const result = await translateTexts({
        texts: [stripSpeechFillers(text)],
        context: recentTranslationContext(getState().current?.lines || []),
        config,
        partial: true,
        signal: controller.signal
      });
      if (startGeneration !== generation() || !sessionActive()) return;
      recordSuccess(result.usage);
      const state = getState();
      if (cleanText(state.current?.bufferSource) === text) {
        state.current.bufferTranslation = polishTranslation(cleanText(result.translations[0]));
        await publish({ reason: "buffer" });
      }
    } catch (error) {
      if (startGeneration !== generation() || isAbortError(error)) return;
      if (recordFailure(error)) {
        requestedText = "";
      } else {
        // A bad key or balance problem will not fix itself for this text.
        requestedText = text;
        await publish({ reason: "error" });
      }
    } finally {
      // An external abort (new buffer text, cancel) already released the slot
      // and a newer request may own it now; only the owner may clear the flags.
      if (startGeneration === generation() && abortSlot === controller) {
        inFlight = false;
        abortSlot = null;
        if (sessionActive()) {
          const currentText = bufferText();
          if (currentText && currentText !== text) {
            schedule();
          } else if (currentText && currentText === text && !requestedText) {
            schedule();
          }
        }
      }
    }
  }

  /**
   * The ASR buffer text changed: abort the stale half-sentence request, but
   * keep the debounce timer, since live buffers change several times per
   * second and must not reset it forever.
   */
  function abortStale() {
    if (!abortSlot) return;
    try {
      abortSlot.abort();
    } catch {
      // Ignore abort races.
    }
    abortSlot = null;
    inFlight = false;
    requestedText = "";
  }

  /** @param {{ keepInterval?: boolean }} [options] */
  function reset({ keepInterval = false } = {}) {
    cancel();
    requestedText = "";
    if (!keepInterval) lastRequestAt = 0;
  }

  return {
    schedule,
    flush,
    cancel,
    abortStale,
    reset,
    inspect: () => ({
      bufferTimer: Boolean(timer),
      bufferInFlight: inFlight,
      bufferRequestedText: requestedText
    })
  };
}
