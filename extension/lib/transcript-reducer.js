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
  lineChanged,
  mergeCaptionFragments,
  mergeCaptionLines,
  normalizeCaptionLines,
  reconcileLineTranslations,
  selectDisplayCaption
} from "./caption-utils.js";
import { segmentCaptionLines, settleSegmentTimes } from "./caption-segment.js";

/** Rows kept in runtime state; older rows live on in history only. */
export const RUNTIME_LINE_LIMIT = 120;

/**
 * Change marker for a row as written to history.
 *
 * `translationPending` is part of it so a stage translation leaving the screen
 * as final still triggers one history write, even when its text did not change.
 */
export function lineSignature(source, translation, translationPending = false) {
  return `${source}\u0000${translation}\u0000${translationPending ? "1" : "0"}`;
}

/** The copy of a row the worker remembers after writing it to history. */
export function rememberLine(line) {
  return {
    ...line,
    signature: lineSignature(line.source, line.translation, line.translationPending)
  };
}

/** Rows whose text, translation or timing differ from the remembered copy. */
export function linesChangedSince(lines, knownLines) {
  return lines.filter((line) => {
    // A stage translation describes a source the row has already outgrown, so
    // it is screen-only: no IndexedDB write and no SRT line. The flag turning
    // false later is what writes the final text exactly once.
    if (line.translationPending === true) return false;
    const known = knownLines.get(line.id);
    return (
      lineChanged(known, line) ||
      known?.signature !== lineSignature(line.source, line.translation)
    );
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
  // In API mode the extension translates the rows itself, so a row that ran on
  // for minutes is cut into sentences, ASR fragments are joined, and the overlay,
  // history and SRT all work on whole sentences.
  // In server mode WhisperLiveKit already returned translations aligned to its
  // own segments; merging the rows there would throw those translations away.
  if (useApi) {
    const previousLines = previous.lines || [];
    normalized.lines = settleSegmentTimes(
      mergeCaptionFragments(segmentCaptionLines(normalized.lines, previousLines)),
      previousLines,
      knownLines
    );
  }
  // A row keeps its translation while the recogniser appends to it; the stale
  // copy stays on screen as a stage translation instead of falling back to the
  // previous sentence (see reconcileLineTranslations).
  const lines = reconcileLineTranslations(previous.lines || [], normalized.lines, {
    useApi,
    knownLines
  });

  const historyLines = linesChangedSince(lines, knownLines);

  const bufferChanged = cleanText(previous.bufferSource) !== normalized.bufferSource;
  // API mode has no buffer translation: half-sentences come from the growing
  // row's stage translation, and the scheduler no longer translates the buffer.
  const bufferTranslation = useApi ? "" : normalized.bufferTranslation;
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
