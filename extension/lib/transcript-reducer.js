/**
 * Folds one WhisperLiveKit transcript message into the runtime caption state:
 * normalize and epoch-shift the rows, merge ASR fragments (API mode only),
 * carry translations over from the previous state, detect which rows changed
 * for history and whether the unfinished buffer moved, and pick the caption
 * to display.
 *
 * Pure: no chrome.*, no DOM. The caller applies the returned patch, writes
 * `historyLines` to the history queue and schedules translations.
 */
import {
  cleanText,
  getTranslationText,
  lineChanged,
  mergeCaptionFragments,
  mergeCaptionLines,
  normalizeCaptionLines,
  selectDisplayCaption
} from "./caption-utils.js";
import { polishTranslation } from "./speech-cleanup.js";

/** Rows kept in runtime state; older rows live on in history only. */
export const RUNTIME_LINE_LIMIT = 120;

/** Change marker for a row as written to history: source plus translation. */
export function lineSignature(source, translation) {
  return `${source}\u0000${translation}`;
}

/** The copy of a row the worker remembers after writing it to history. */
export function rememberLine(line) {
  return { ...line, signature: lineSignature(line.source, line.translation) };
}

/** Rows whose text, translation or timing differ from the remembered copy. */
export function linesChangedSince(lines, knownLines) {
  return lines.filter((line) => {
    const known = knownLines.get(line.id);
    return lineChanged(known, line) || known?.signature !== lineSignature(line.source, line.translation);
  });
}

/**
 * @typedef {object} TranscriptMessage
 * @property {any} data The WhisperLiveKit payload (`lines`, `buffer_transcription` ...).
 * @property {string} sessionId
 * @property {string | null} [epochId] One WebSocket connection; a reconnect starts a new one.
 * @property {number} [epochStartedAt]
 */

/**
 * @typedef {object} TranscriptReduceOptions
 * @property {Map<string, any>} knownLines Last known copy of every session row
 *   (see rememberLine); read only.
 * @property {boolean} useApi API mode: the extension translates the rows itself.
 * @property {string} [apiError] The scheduler's last error, shown in API mode.
 * @property {number} now
 */

/**
 * @param {any} state The current runtime state (read only).
 * @param {TranscriptMessage} message
 * @param {TranscriptReduceOptions} options
 */
export function reduceTranscriptUpdate(state, message, options) {
  const { knownLines, useApi, apiError = "", now } = options;
  const previous = state?.current || {};
  const normalized = normalizeCaptionLines(message.data, {
    sessionId: message.sessionId,
    epochId: message.epochId,
    epochStartedAt: message.epochStartedAt,
    sessionStartedAt: state?.startedAt,
    updatedAt: now
  });
  // In API mode the extension translates the rows itself, so ASR fragments are
  // joined first and the overlay, history and SRT all work on whole sentences.
  // In server mode WhisperLiveKit already returned translations aligned to its
  // own segments; merging the rows there would throw those translations away.
  if (useApi) {
    normalized.lines = mergeCaptionFragments(normalized.lines);
  }
  const previousLines = new Map((previous.lines || []).map((line) => [line.id, line]));
  const lines = normalized.lines.map((rawLine) => {
    const earlier = previousLines.get(rawLine.id) || knownLines.get(rawLine.id);
    const serverTranslation = polishTranslation(getTranslationText(rawLine));
    let translation = useApi ? "" : serverTranslation;
    let fallbackTranslation = useApi ? serverTranslation : "";
    if (!translation && earlier?.translation && earlier.source === rawLine.source) {
      translation = earlier.translation;
    }
    if (
      !fallbackTranslation &&
      earlier?.fallbackTranslation &&
      earlier.source === rawLine.source
    ) {
      fallbackTranslation = earlier.fallbackTranslation;
    }
    return {
      ...rawLine,
      translation,
      fallbackTranslation,
      translationPending: Boolean(rawLine.source && !translation),
      translationFailed: Boolean(
        !translation && earlier?.source === rawLine.source && earlier?.translationFailed
      )
    };
  });

  const historyLines = linesChangedSince(lines, knownLines);

  const bufferChanged = cleanText(previous.bufferSource) !== normalized.bufferSource;
  const bufferTranslation = useApi
    ? bufferChanged
      ? ""
      : cleanText(previous.bufferTranslation)
    : normalized.bufferTranslation;
  const caption = {
    lines: mergeCaptionLines([], lines, RUNTIME_LINE_LIMIT),
    bufferSource: normalized.bufferSource,
    bufferTranslation,
    translationError: useApi ? apiError : normalized.translationError,
    epochId: message.epochId || null
  };

  return {
    patch: {
      status: state?.status === "reconnecting" ? "capturing" : state?.status,
      wsConnected: true,
      updatedAt: now,
      current: { ...caption, displayCaption: selectDisplayCaption(caption) }
    },
    // The same row objects as in patch.current, so a translation patched into
    // the runtime row before the history flush reaches the queued write too.
    historyLines,
    bufferChanged
  };
}
