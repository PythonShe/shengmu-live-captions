/**
 * Groups ASR fragments into translation units.
 *
 * WhisperLiveKit cuts transcripts on acoustic agreement, not on sentence
 * boundaries, so a single spoken sentence routinely arrives as
 * "that he has found." followed by "From here on." Translating each fragment on
 * its own produces dangling Chinese ("他找到了。") that cannot be read without
 * the previous row. This module decides which pending rows must be translated
 * together in one request, and which trailing fragment is worth waiting for.
 *
 * Pure functions only: no chrome.*, no DOM.
 */

/** A row is treated as a fragment below these bounds when it does not end a sentence. */
export const SPEECH_SHARD_MAX_CHARS = 25;
export const SPEECH_SHARD_MAX_WORDS = 4;
/** How long a trailing fragment waits for the row that completes it. */
export const SPEECH_SHARD_HOLD_MS = 2000;
/** Hard caps for one merged unit, so a run-on never becomes a huge request. */
export const UTTERANCE_MAX_CHARS = 180;
export const UTTERANCE_MAX_LINES = 4;
export const DEFAULT_BATCH_LINES = 6;

const SENTENCE_END = /[.?!…。！？]["'”’)\]]?$/;
const HARD_SENTENCE_END = /[?!…。！？]["'”’)\]]?$/;
const TRAILING_COMMA = /[,;:…—-]["'”’)\]]?$/;
const WORD_SPLIT = /\s+/;
/** A row that starts with one of these is a clause continuing an earlier one. */
const FORWARD_CONNECTORS =
  /^(?:and|but|or|that|which|who|whom|whose|with|without|because|if|when|while|than|then)\b/i;
/** A row that ends with one of these cannot stand on its own. */
const TRAILING_FUNCTION_WORD =
  /\b(?:and|but|or|that|which|who|with|without|because|if|when|while|to|of|in|on|for|from|as|at|by|the|a|an|is|are|was|were|will|would|can|could|should|has|have|had|been|be|not|very|just)\s*[.,;:…—-]*$/i;
const MAX_CONNECTOR_SHARD_WORDS = 10;
/**
 * Participle openers that almost always continue the previous sentence
 * ("allowing you to do some specific crafts along the way."). Restricted to a
 * whitelist: a generic -ing test swallows independent sentences such as
 * "Understanding the mechanic is important."
 */
const PARTICIPLE_CONNECTORS =
  /^(?:allowing|using|making|taking|giving|keeping|adding|causing|meaning|leading|bringing|following|including|depending|based)\b/i;
const MAX_PARTICIPLE_SHARD_WORDS = 8;

function textOf(entry) {
  const text = entry?.source;
  return typeof text === "string" ? text.trim() : "";
}

function charCount(entry) {
  return textOf(entry).replace(/\s+/g, " ").length;
}

/**
 * A fragment is a row that cannot stand alone: either it is very short, or it
 * opens with a connector, or it stops on a function word. A full stop is *not*
 * evidence by itself: WhisperLiveKit adds punctuation to every segment, so
 * "and riddled with excitement." arrives looking like a finished sentence while
 * it is only the subordinate clause of the next row.
 */
export function isSpeechShard(text) {
  return startsContinuation(text) || needsCompletion(text);
}

/**
 * The row continues the sentence before it: it opens with a connector, so it
 * has to be joined backwards, not forwards.
 */
export function startsContinuation(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return false;
  if (HARD_SENTENCE_END.test(value)) return false;
  const words = value.split(WORD_SPLIT).filter(Boolean);
  if (FORWARD_CONNECTORS.test(value) && words.length <= MAX_CONNECTOR_SHARD_WORDS) {
    return true;
  }
  return (
    PARTICIPLE_CONNECTORS.test(value) &&
    words.length <= MAX_PARTICIPLE_SHARD_WORDS
  );
}

/**
 * The row itself is unfinished: too short, or it stops on a comma or a function
 * word. The next row has to be joined onto it.
 */
export function needsCompletion(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return false;
  if (HARD_SENTENCE_END.test(value)) return false;
  const words = value.split(WORD_SPLIT).filter(Boolean);
  if (words.length <= SPEECH_SHARD_MAX_WORDS) return true;
  if (value.length <= SPEECH_SHARD_MAX_CHARS) return true;
  if (TRAILING_COMMA.test(value)) return true;
  return TRAILING_FUNCTION_WORD.test(value.replace(SENTENCE_END, ""));
}

/** The text stops on a word that cannot end a sentence, punctuation or not. */
export function endsOnFunctionWord(text) {
  const value = typeof text === "string" ? text.trim() : "";
  return TRAILING_FUNCTION_WORD.test(value.replace(SENTENCE_END, ""));
}

/**
 * Splits the pending rows into the next request and the rows to keep waiting.
 *
 * `entries` is an ordered `[lineId, entry]` list (oldest first) where every
 * entry carries `source` and, for rows already queued, `queuedAt`.
 * A fragment always drags the rows that complete it into the same request; a
 * trailing fragment with nothing after it is held until `holdMs` has passed so
 * it is not translated as an orphan sentence.
 */
export function planTranslationBatch(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const maxLines = Math.max(1, Number(options.maxLines) || DEFAULT_BATCH_LINES);
  const holdMs = Number.isFinite(Number(options.holdMs))
    ? Number(options.holdMs)
    : SPEECH_SHARD_HOLD_MS;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const batch = [];
  const held = [];
  let index = 0;

  while (index < list.length && batch.length < maxLines) {
    const current = list[index];
    const room = maxLines - batch.length;
    if (!isSpeechShard(textOf(current[1]))) {
      batch.push(current);
      index += 1;
      continue;
    }

    const group = [current];
    let chars = charCount(current[1]);
    let next = index + 1;
    while (next < list.length && group.length < UTTERANCE_MAX_LINES) {
      const candidate = list[next];
      const candidateChars = charCount(candidate[1]);
      if (chars + candidateChars > UTTERANCE_MAX_CHARS) break;
      if (group.length >= room) break;
      group.push(candidate);
      chars += candidateChars;
      next += 1;
      // The row that finishes the sentence closes the unit.
      if (!isSpeechShard(textOf(candidate[1]))) break;
    }

    const trailing = next >= list.length;
    if (group.length === 1 && trailing) {
      const queuedAt = Number(current[1]?.queuedAt) || 0;
      if (now - queuedAt < holdMs) {
        held.push(current);
        index += 1;
        continue;
      }
    }
    batch.push(...group);
    index = next;
  }

  while (index < list.length) {
    held.push(list[index]);
    index += 1;
  }
  return { batch, held };
}


