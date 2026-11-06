/**
 * Cuts one long ASR row into sentence-sized rows.
 *
 * WhisperLiveKit closes a row only on a VAD silence; punctuation plays no part.
 * Under continuous speech, or game audio that keeps the VAD open, a single row
 * grows for minutes (3543 characters on the Gq2r7x5qgmg sample). That row is
 * resent whole on every retranslation, stays pending so it never reaches
 * history, and is unreadable where it is shown.
 *
 * The rest of the pipeline already handles a run of short rows, so a long row is
 * turned into exactly that, before mergeCaptionFragments. The first piece keeps
 * the row's id; a later one is `<id>#<index>`. A row that fits stays untouched.
 *
 * Pure: no chrome.*, no DOM.
 */
import {
  FRAGMENT_MAX_CHARS,
  SEGMENT_CLAUSE_MIN_CHARS,
  parseTimecode,
  shiftTimecode
} from "./caption-utils.js";
import { endsOnFunctionWord } from "./utterance.js";

/** A piece never exceeds what mergeCaptionFragments would still join. */
export const SEGMENT_MAX_CHARS = FRAGMENT_MAX_CHARS;
/** A forced cut looks no further back than this share of the limit. */
const FORCED_CUT_MIN_SHARE = 0.6;

// CJK sentence marks need no following space, so they end a word by themselves.
const WORD = /[^\s。！？]*[。！？]+["'”’)\]]*|[^\s。！？]+/gu;
const SENTENCE_END = /[.?!…。！？]+["'”’)\]]*$/u;
const CJK_SENTENCE_END = /[。！？]["'”’)\]]*$/u;
// A period that endsSentence rejected still marks a pause, so it counts here.
const CLAUSE_END = /[,;:—.?!…]["'”’)\]]*$/u;
const NON_TERMINAL_PERIOD = /^["'“‘([]*(?:(?:mr|mrs|ms|dr|prof|st|vs|etc|approx|e\.g|i\.e)\.|(?:\p{L}\.)+)$/iu;
const OPENING_PUNCTUATION = /^["'“‘([]+/u;
// Speech with no punctuation at all still hands over clause by clause.
const CLAUSE_OPENER = /^(?:and|but|or|so|because|which|while|when|if|then)\b/i;
// Item and skill names hang on it: "Path of Exile", "Orb of Augmentation".
const TERM_JOINER = /^of\b/i;

/**
 * The recogniser closes every decoded chunk with a period, so "really good. for
 * a few days." has one mid-sentence. Its capitalisation is reliable, which makes
 * a lowercase next word the evidence that the sentence goes on.
 * @param {string} word
 * @param {string} next
 */
function endsSentence(word, next) {
  if (!SENTENCE_END.test(word)) return false;
  if (CJK_SENTENCE_END.test(word)) return true;
  if (NON_TERMINAL_PERIOD.test(word)) return false;
  return !/^\p{Ll}/u.test(next.replace(OPENING_PUNCTUATION, ""));
}

/** @param {string} text @param {number} start @param {number} length */
function safeSliceEnd(text, start, length) {
  const end = start + length;
  const code = text.charCodeAt(end - 1);
  // Never leave half of a surrogate pair on either side of the cut.
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * Splits text into pieces of at most `maxChars`, preferring sentence ends, then
 * clause ends, then a word that does not leave the piece dangling.
 *
 * Every decision depends only on the text up to the word after the cut, so
 * appending text never moves an earlier cut. Row ids rely on that: the same
 * piece keeps the same index on every update.
 * @param {string} text
 * @param {{ maxChars?: number, clauseMinChars?: number }} [options]
 * @returns {string[]}
 */
export function cutSentences(text, options = {}) {
  const value = String(text ?? "").trim();
  const maxChars = Number(options.maxChars) || SEGMENT_MAX_CHARS;
  const clauseMinChars = Number(options.clauseMinChars) || SEGMENT_CLAUSE_MIN_CHARS;
  const words = [...value.matchAll(WORD)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
  const pieces = [];
  let start = 0;
  const cutAt = (/** @type {number} */ end, /** @type {number} */ nextStart) => {
    pieces.push(value.slice(start, end));
    start = nextStart;
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.end - start > maxChars) {
      if (word.start > start) {
        const cut = forcedCutIndex(words, index, start, maxChars);
        cutAt(words[cut].end, words[cut + 1].start);
        // Resume on the first word of the new piece.
        index = cut;
        continue;
      }
      // One word longer than the limit: text without spaces has no better cut.
      while (word.end - start > maxChars) {
        const end = safeSliceEnd(value, start, maxChars);
        cutAt(end, end);
      }
    }
    const next = words[index + 1];
    if (!next) break;
    if (
      endsSentence(word.text, next.text) ||
      (word.end - start >= clauseMinChars && CLAUSE_END.test(word.text))
    ) {
      cutAt(word.end, next.start);
    }
  }
  if (start < value.length) pieces.push(value.slice(start));
  return pieces;
}

/**
 * The word to cut after when `overflow` no longer fits: the last clause end in
 * the tail of the piece, else the last word before a clause opener, else the
 * last word that does not dangle.
 * @param {{ text: string, start: number, end: number }[]} words
 * @param {number} overflow
 * @param {number} start
 * @param {number} maxChars
 */
function forcedCutIndex(words, overflow, start, maxChars) {
  const floor = start + maxChars * FORCED_CUT_MIN_SHARE;
  let beforeOpener = -1;
  let solid = -1;
  for (let index = overflow - 1; index >= 0 && words[index].end > floor; index -= 1) {
    if (CLAUSE_END.test(words[index].text)) return index;
    if (endsOnFunctionWord(words[index].text) || TERM_JOINER.test(words[index + 1].text)) continue;
    if (solid < 0) solid = index;
    if (beforeOpener < 0 && CLAUSE_OPENER.test(words[index + 1].text)) beforeOpener = index;
  }
  if (beforeOpener >= 0) return beforeOpener;
  return solid >= 0 ? solid : overflow - 1;
}

/**
 * Replaces every row longer than one piece with its pieces. Pieces carry the raw
 * row's timing until settleSegmentTimes has seen the merged result.
 * @param {any[]} lines Normalised rows of this update.
 * @returns {any[]}
 */
export function segmentCaptionLines(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  const output = [];
  for (const line of rows) {
    const pieces = line?.source ? cutSentences(line.source) : [];
    if (pieces.length <= 1) {
      output.push(line);
      continue;
    }
    pieces.forEach((source, segmentIndex) => {
      output.push({
        ...line,
        id: segmentIndex === 0 ? line.id : `${line.id}#${segmentIndex}`,
        source,
        // A row's own translation cannot be divided between its pieces.
        translation: "",
        translationPending: true,
        order: line.order + segmentIndex,
        segmentOf: line.id,
        segmentIndex
      });
    });
  }
  return output;
}

/**
 * Gives the rows of a split row their own timing, after merging.
 *
 * The recogniser only reports the raw row's start and end, and the raw end moves
 * with every update. A row that stopped growing therefore keeps the end it had
 * on its last update, when the raw end was the end of its last word; this also
 * stops finished rows from being rewritten to history on every frame. Only text
 * that arrived in one go is placed by its share of the characters.
 * @param {any[]} lines Rows of this update, already merged.
 * @param {any[]} [previousLines] Rows of the previous state.
 * @param {Map<string, any> | null} [knownLines] Rows beyond the runtime window.
 * @returns {any[]}
 */
export function settleSegmentTimes(lines, previousLines = [], knownLines = null) {
  const rows = Array.isArray(lines) ? lines : [];
  const isSegmented = (/** @type {any} */ row) => Boolean(row?.segmentOf || row?.segmentTail);
  const byId = new Map();
  for (const row of previousLines) {
    if (isSegmented(row)) byId.set(row.id, row);
  }
  /** @type {Map<string, { last: number, remaining: number, cursor: number, rawEnd: number }>} */
  const groups = new Map();
  rows.forEach((row, index) => {
    if (!isSegmented(row)) return;
    for (const anchor of new Set([row.segmentOf, row.segmentTail])) {
      if (!anchor) continue;
      const group = groups.get(anchor) || {
        last: index,
        remaining: 0,
        cursor: parseTimecode(row.start),
        rawEnd: parseTimecode(row.end)
      };
      group.last = index;
      if (anchor === row.segmentTail) group.remaining += row.source.length;
      groups.set(anchor, group);
    }
  });

  return rows.map((row, index) => {
    if (!isSegmented(row)) return row;
    const known = knownLines?.get(row.id);
    const prior = byId.get(row.id) || (isSegmented(known) ? known : null);
    const head = groups.get(row.segmentOf);
    // A unit that starts on a row of its own keeps that row's start.
    const start = head ? prior?.start || timecodeAt(row.start, head.cursor) : row.start;
    const tail = groups.get(row.segmentTail);
    let end = row.end;
    if (tail && tail.last !== index) {
      if (prior?.source === row.source) {
        end = prior.end;
      } else {
        const from = parseTimecode(start);
        const share = tail.remaining > 0 ? row.source.length / tail.remaining : 0;
        end = timecodeAt(row.start, from + share * Math.max(0, tail.rawEnd - from));
      }
    }
    const reached = parseTimecode(end);
    if (head) head.cursor = reached;
    if (tail) {
      tail.cursor = reached;
      tail.remaining -= row.source.length;
    }
    return { ...row, start, end };
  });
}

/**
 * @param {string} reference The row's own timecode; an empty one stays unknown.
 * @param {number} seconds
 */
function timecodeAt(reference, seconds) {
  return reference ? shiftTimecode("0:00:00.00", seconds) : "";
}
