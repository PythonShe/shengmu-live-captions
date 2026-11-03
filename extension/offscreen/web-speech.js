// Chrome's on-device SpeechRecognition run on the captured tab track: the
// zero-setup speech backend. offscreen.js imports this module only when that
// backend is selected.
import { createLineAccumulator } from "../lib/asr-sessions.js";

// Errors after which restarting the recognizer cannot help.
const FATAL_ERRORS = new Map([
  ["language-not-supported", "Chrome 本机语音识别不支持英语模型，请改用其他识别引擎"],
  ["not-allowed", "Chrome 拒绝了语音识别权限"],
  ["service-not-allowed", "Chrome 不允许在此使用语音识别，请改用其他识别引擎"],
  ["audio-capture", "语音识别读不到标签页音频"]
]);
// A recognizer ends after silence or an error; this pause keeps a broken one
// from spinning.
const RESTART_DELAY_MS = 250;
const STOP_TIMEOUT_MS = 2000;

function recognitionClass() {
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

/**
 * Makes sure the on-device English model is installed. The first download
 * takes about 20 s (Chrome 155 probe, 2026-11-03).
 * @param {{ lang: string, onStatus: (detail: string) => void }} options
 */
export async function prepareWebSpeech({ lang, onStatus }) {
  const Recognition = recognitionClass();
  if (!Recognition?.available) {
    throw new Error("当前 Chrome 不支持本机语音识别，请升级 Chrome 或改用其他识别引擎");
  }
  const options = { langs: [lang], processLocally: true };
  const availability = await Recognition.available(options);
  if (availability === "available") return;
  if (availability === "unavailable") {
    throw new Error("此设备不支持 Chrome 本机英语语音识别，请改用其他识别引擎");
  }
  onStatus("正在下载 Chrome 本机语音模型，首次约需 20 秒");
  if (!(await Recognition.install(options))) {
    throw new Error("Chrome 本机语音模型下载失败，请检查网络后重试");
  }
}

/**
 * @param {{
 *   track: MediaStreamTrack,
 *   lang: string,
 *   phrases?: string[],
 *   onMessage: (data: any) => void,
 *   onFatal: (detail: string) => void,
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
      onFatal(fatal);
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
      onFatal(`语音识别启动失败：${error?.message || error}`);
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
