/**
 * The speech backends other than WhisperLiveKit (Chrome's on-device
 * SpeechRecognition and Alibaba Bailian fun-asr-realtime) are adapted to the
 * WhisperLiveKit message shape, so the transcript reducer, scheduler and
 * history stay backend-agnostic: every message carries the epoch's rows so
 * far (`lines`, H:MM:SS.cc timecodes) and the unfinished text
 * (`buffer_transcription`).
 *
 * Pure: no chrome.*, no DOM. The offscreen document owns the sockets and the
 * recognizer and imports this module dynamically.
 */

import { cutSentences } from "./caption-segment.js";
import { mergeCaptionFragments, normalizeCaptionLines, parseTimecode } from "./caption-utils.js";
import { msg } from "./i18n-message.js";

/** Rows resent with each message; older ones already reached history. */
export const ASR_MESSAGE_LINE_LIMIT = 120;

/** @param {number} seconds */
export function formatTimecode(seconds) {
  const centis = Math.max(0, Math.round((Number(seconds) || 0) * 100));
  const hours = Math.floor(centis / 360000);
  const minutes = Math.floor((centis % 360000) / 6000);
  const secs = (centis % 6000) / 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Cuts a full window where a merged sentence starts. The reducer merges the
 * rows of every message afresh, so dropping only the first row of a sentence
 * would turn its remaining rows into a new sentence with a new id, repeated in
 * history and translated again. Merging runs left to right and looks only at
 * the current sentence, so dropping whole sentences leaves the others as they
 * were. Noise rows never reach the reducer's merge and are dropped outright.
 * @template {{ start: string }} Row
 * @param {Row[]} rows
 * @param {number} limit
 * @returns {Row[]}
 */
function trimToSentenceStart(rows, limit) {
  if (rows.length <= limit) return rows;
  const centis = (/** @type {string} */ start) => Math.round(parseTimecode(start) * 100);
  const { lines } = normalizeCaptionLines({ lines: rows });
  const alive = new Set(lines.map((line) => centis(line.start)));
  const kept = rows.filter((row) => alive.has(centis(row.start)));
  let index = 0;
  let lastSentence = 0;
  for (const sentence of mergeCaptionFragments(lines)) {
    if (kept.length - index <= limit) return kept.slice(index);
    lastSentence = index;
    index += sentence.fragmentLines;
  }
  // One sentence longer than the limit stays whole; merging caps its rows.
  return kept.slice(lastSentence);
}

/**
 * Collects finished sentences into WhisperLiveKit-shaped messages. Row ids
 * derive from the start timecode, so starts are kept strictly increasing: two
 * rows on the same start would overwrite each other downstream.
 * @param {{ limit?: number }} [options]
 */
export function createLineAccumulator({ limit = ASR_MESSAGE_LINE_LIMIT } = {}) {
  /** @type {{ speaker: number, text: string, start: string, end: string }[]} */
  let lines = [];
  let lastStart = -1;
  let buffer = "";

  return {
    /**
     * @param {string} text
     * @param {number} startSeconds From the epoch start.
     * @param {number} endSeconds
     * @returns {boolean} false when the text was empty
     */
    final(text, startSeconds, endSeconds) {
      const value = clean(text);
      buffer = "";
      if (!value) return false;
      const rowStart = Math.max(Number(startSeconds) || 0, lastStart + 0.01);
      const span = Math.max((Number(endSeconds) || 0) - rowStart, 0);
      // A finished row never grows, so it can be cut here and placed by its share
      // of the characters. Left whole, the window could only be cut between rows,
      // and that is no sentence start once a short last piece joins the next row.
      const pieces = cutSentences(value);
      let offset = 0;
      for (const piece of pieces) {
        const start = Math.max(rowStart + span * (offset / value.length), lastStart + 0.01);
        lastStart = Math.round(start * 100) / 100;
        offset = Math.min(offset + piece.length + 1, value.length);
        const end = Math.max(rowStart + span * (offset / value.length), lastStart);
        lines.push({ speaker: 1, text: piece, start: formatTimecode(lastStart), end: formatTimecode(end) });
      }
      // None of these pieces has been sent yet, so all of them stay this once.
      lines = trimToSentenceStart(lines, Math.max(limit, pieces.length));
      return true;
    },
    /** @param {string} text The sentence still being recognized. */
    interim(text) {
      buffer = clean(text);
    },
    message() {
      return {
        lines: lines.map((line) => ({ ...line })),
        buffer_transcription: buffer,
        buffer_translation: "",
        translation_error: ""
      };
    }
  };
}

/** Phrases Chrome's recognizer is biased towards, from the glossary hotwords. */
export const MAX_SPEECH_PHRASES = 100;

/**
 * @param {{ sources?: string[], source?: string }[]} entries asrEntries order
 * @returns {string[]}
 */
export function speechPhrases(entries) {
  const phrases = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const primary = Array.isArray(entry?.sources) ? entry.sources[0] : String(entry?.source || "").split("|")[0];
    const phrase = clean(primary);
    const key = phrase.toLowerCase();
    // The recognizer is English-only here: a Chinese "source" cannot bias it.
    if (!/[A-Za-z]/.test(phrase) || /[^\x20-\x7E]/.test(phrase) || seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
    if (phrases.length >= MAX_SPEECH_PHRASES) break;
  }
  return phrases;
}

export const BAILIAN_ASR_MODEL = "fun-asr-realtime";
export const BAILIAN_SAMPLE_RATE = 16000;
/** fun-asr-realtime accepts at most this much context text. */
export const BAILIAN_CONTEXT_MAX_CHARS = 400;

const BAILIAN_HOSTS = Object.freeze({
  cn: "dashscope.aliyuncs.com",
  intl: "dashscope-intl.aliyuncs.com"
});

/** @param {string} region "cn" (Beijing) or "intl" (Singapore) */
export function bailianInferenceUrl(region) {
  const host = BAILIAN_HOSTS[/** @type {"cn" | "intl"} */ (region)] || BAILIAN_HOSTS.cn;
  return `wss://${host}/api-ws/v1/inference`;
}

/**
 * The run-task frame that opens a duplex recognition task.
 * @param {{ taskId: string, context?: string, languageHints?: string[] }} options
 */
export function bailianRunTask({ taskId, context = "", languageHints = ["en"] }) {
  const text = clean(context).slice(0, BAILIAN_CONTEXT_MAX_CHARS);
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: BAILIAN_ASR_MODEL,
      parameters: {
        format: "pcm",
        sample_rate: BAILIAN_SAMPLE_RATE,
        language_hints: languageHints,
        // The socket stays open through quiet stretches of a stream.
        heartbeat: true
      },
      input: text ? { context: [{ role: "user", content: [{ type: "input_text", text }] }] } : {}
    }
  };
}

/** @param {string} taskId */
export function bailianFinishTask(taskId) {
  return {
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: {} }
  };
}

/**
 * @typedef {{ kind: "started" | "finished" | "ignored" }
 *   | { kind: "failed", code: string, message: string | import("./i18n-message.js").LocalMessage }
 *   | { kind: "sentence", text: string, beginSeconds: number, endSeconds: number | null, final: boolean }} BailianEvent
 */

/**
 * @param {string} raw One text frame from the server.
 * @returns {BailianEvent}
 */
export function parseBailianEvent(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "failed", code: "parse_error", message: msg("bailian_unparsable") };
  }
  const event = data?.header?.event;
  if (event === "task-started") return { kind: "started" };
  if (event === "task-finished") return { kind: "finished" };
  if (event === "task-failed") {
    return {
      kind: "failed",
      code: String(data.header.error_code || "task_failed"),
      message: data.header.error_message ? String(data.header.error_message) : msg("bailian_task_failed")
    };
  }
  if (event !== "result-generated") return { kind: "ignored" };
  const sentence = data?.payload?.output?.sentence;
  if (!sentence || sentence.heartbeat) return { kind: "ignored" };
  const end = Number(sentence.end_time);
  return {
    kind: "sentence",
    text: String(sentence.text || ""),
    beginSeconds: (Number(sentence.begin_time) || 0) / 1000,
    endSeconds: sentence.end_time == null || !Number.isFinite(end) ? null : end / 1000,
    final: sentence.sentence_end === true
  };
}

/**
 * Plain-language messages for the task-failed codes users can act on.
 * @param {string} code
 * @param {import("./i18n-message.js").LocalMessage | string} message
 */
export function bailianErrorDetail(code, message) {
  if (/InvalidApiKey|Unauthorized|AccessDenied/i.test(code)) {
    return msg("bailian_error_auth");
  }
  if (/Throttling|RateQuota|Arrearage/i.test(code)) {
    return msg("bailian_error_quota", message);
  }
  return msg("bailian_error_failed", code, message);
}
