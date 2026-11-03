// Chrome's on-device SpeechRecognition run on the captured tab track: the
// zero-setup speech backend. offscreen.js imports this module only when that
// backend is selected.
import { createLineAccumulator } from "../lib/asr-sessions.js";
import { LocalizedError, msg } from "../lib/i18n-message.js";

// The model is downloaded by the popup's start click (install() needs a user
// gesture); a download that is still running is waited for this long.
const DOWNLOAD_WAIT_MS = 120000;
const DOWNLOAD_POLL_MS = 1000;
// Errors after which restarting the recognizer cannot help.
// Values are messages.json keys.
const FATAL_ERRORS = new Map([
  ["language-not-supported", "speech_language_not_supported"],
  ["not-allowed", "speech_not_allowed"],
  ["service-not-allowed", "speech_service_not_allowed"],
  ["audio-capture", "speech_audio_capture"]
]);
// A recognizer ends after silence or an error; this pause keeps a broken one
// from spinning.
const RESTART_DELAY_MS = 250;
const STOP_TIMEOUT_MS = 2000;

function recognitionClass() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

/**
 * Makes sure the on-device English model is installed. install() needs a
 * user gesture, which an offscreen document never has, so the popup starts
 * the download (about 20 s, Chrome 155 probe, 2026-11-03) and this only
 * waits for it.
 * @param {{ lang: string, onStatus: (detail: import("../lib/i18n-message.js").LocalMessage) => void }} options
 */
export async function prepareWebSpeech({ lang, onStatus }) {
  const Recognition = recognitionClass();
  if (!Recognition?.available) {
    throw new LocalizedError(msg("speech_unsupported"));
  }
  const options = { langs: [lang], processLocally: true };
  const availability = await Recognition.available(options);
  if (availability === "available") return;
  if (availability === "unavailable") {
    throw new LocalizedError(msg("speech_unavailable"));
  }
  if (availability !== "downloading") {
    throw new LocalizedError(msg("speech_model_not_downloaded"));
  }
  onStatus(msg("speech_downloading"));
  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, DOWNLOAD_POLL_MS);
    });
    const now = await Recognition.available(options);
    if (now === "available") return;
    if (now !== "downloading") break;
  }
  throw new LocalizedError(msg("speech_download_failed"));
}

/**
 * @param {{
 *   track: MediaStreamTrack,
 *   lang: string,
 *   phrases?: string[],
 *   onMessage: (data: any) => void,
 *   onFatal: (detail: import("../lib/i18n-message.js").LocalMessage) => void,
 *   now?: () => number
 * }} options
 */
export function createWebSpeechSession({ track, lang, phrases = [], onMessage, onFatal, now = () => performance.now() }) {
  const Recognition = recognitionClass();
  const lines = createLineAccumulator();
  const startedAt = now();
  let recognizer = null;
  let restartTimer = null;
  let stopped = false;
  let endWaiter = null;
  let lastSignature = "";

  const elapsed = () => (now() - startedAt) / 1000;

  function emit() {
    const data = lines.message();
    const signature = JSON.stringify(data);
    if (signature === lastSignature) return;
    lastSignature = signature;
    onMessage(data);
  }

  function start() {
    restartTimer = null;
    if (stopped) return;
    const current = new Recognition();
    recognizer = current;
    current.lang = lang;
    current.continuous = true;
    current.interimResults = true;
    current.processLocally = true;
    if (phrases.length > 0 && globalThis.SpeechRecognitionPhrase) {
      try {
        current.phrases = phrases.map((phrase) => new globalThis.SpeechRecognitionPhrase(phrase, 5.0));
      } catch (error) {
        console.warn("声幕语音识别热词设置失败", error);
      }
    }
    // Result indexes restart with every recognizer, so these do too.
    const firstHeard = new Map();
    const committed = new Set();

    current.onresult = (event) => {
      if (recognizer !== current) return;
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!firstHeard.has(index)) firstHeard.set(index, elapsed());
        if (committed.has(index)) continue;
        const text = result[0]?.transcript || "";
        if (result.isFinal) {
          committed.add(index);
          lines.final(text, firstHeard.get(index), elapsed());
        } else {
          interim += `${text} `;
        }
      }
      lines.interim(interim);
      emit();
    };
    current.onerror = (event) => {
      const fatal = FATAL_ERRORS.get(event.error);
      if (!fatal || stopped) return;
      stopped = true;
      onFatal(msg(fatal));
    };
    current.onend = () => {
      if (recognizer !== current) return;
      recognizer = null;
      if (stopped) {
        endWaiter?.();
        return;
      }
      restartTimer = setTimeout(start, RESTART_DELAY_MS);
    };
    try {
      current.start(track);
    } catch (error) {
      recognizer = null;
      stopped = true;
      onFatal(msg("speech_start_failed", error?.message || String(error)));
    }
  }

  start();

  return {
    /** Lets the recognizer deliver the sentence in progress, then ends. */
    async stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const current = recognizer;
      if (!current) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
        endWaiter = () => {
          clearTimeout(timer);
          resolve();
        };
        current.stop();
      });
      recognizer = null;
      lines.interim("");
      emit();
    }
  };
}
