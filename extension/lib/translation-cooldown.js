/**
 * Provider cooldown shared by every translation request of a session. A 429
 * or 503 that the line queue earns must also hold back the buffer request (and
 * the other way round), otherwise the two streams keep each other rate-limited.
 *
 * Pure: timers, clock and randomness are injected.
 */

/** Cooldown after a 429 that carries no Retry-After header. */
export const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 1500;
/** Up to this share of the cooldown is added at random, so requests that
 * waited together do not hit the provider again in the same instant. */
export const COOLDOWN_JITTER = 0.2;

function abortReason(signal) {
  return signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
}

/**
 * @param {{
 *   now?: () => number,
 *   random?: () => number,
 *   setTimeout?: (callback: () => void, ms: number) => any,
 *   clearTimeout?: (handle: any) => void
 * }} [deps]
 */
export function createTranslationCooldown({
  now = Date.now,
  random = Math.random,
  setTimeout: setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout.bind(globalThis)
} = {}) {
  let until = 0;

  return {
    /** Milliseconds left before the next request may go out. */
    remainingMs() {
      return Math.max(0, until - now());
    },

    /**
     * Resolves once the cooldown is over; rejects with the abort reason if
     * the request is cancelled while waiting.
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>}
     */
    wait(signal) {
      if (until - now() <= 0) return Promise.resolve();
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise((resolve, reject) => {
        let timer = null;
        const onAbort = () => {
          clearTimer(timer);
          reject(abortReason(signal));
        };
        // Reads `until` again on every wake: another request may have extended
        // the cooldown since this one parked.
        const arm = () => {
          const ms = until - now();
          if (ms > 0) {
            timer = setTimer(arm, ms);
            return;
          }
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        arm();
      });
    },

    /**
     * Extends the cooldown from a failed request: the server's Retry-After
     * when it sent one, a default pause for a bare 429, nothing otherwise.
     * @param {any} error
     */
    note(error) {
      let ms = Number(error?.retryAfterMs);
      if (!Number.isFinite(ms) || ms <= 0) {
        if (error?.code !== "rate_limit") return;
        ms = RATE_LIMIT_DEFAULT_COOLDOWN_MS;
      }
      until = Math.max(until, now() + ms + Math.floor(ms * COOLDOWN_JITTER * random()));
    },

    reset() {
      until = 0;
    }
  };
}
