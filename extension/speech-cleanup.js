/**
 * Removes spoken-language noise that makes machine translation read badly.
 *
 * Two directions, two different risks:
 *  - `stripSpeechFillers` runs on the English transcript *before* translation.
 *    The displayed/history English never changes; only the text sent to the
 *    model is cleaned.
 *  - `polishTranslation` runs on the Chinese output for both translation
 *    engines. It only touches drops that cannot carry meaning (sentence-initial
 *    interjections, doubled punctuation).
 *
 * Pure functions only: no chrome.*, no DOM.
 */

/** Interjections that never carry meaning, removed wherever they stand alone. */
const STANDALONE_FILLERS = [
  "uh-huh", "uh huh", "mm-hmm", "mm hmm", "mhm", "hmm+", "um+", "uh+", "erm",
  "er", "ah", "eh", "hm"
];

/**
 * Phrases that are filler only as a comma-bounded aside: "it's kind of weird"
 * loses the aside, while "what kind of weapon" keeps it because no comma
 * surrounds the phrase.
 */
const ASIDE_FILLERS = [
  "you know", "i mean", "kind of", "sort of", "kinda", "sorta", "basically",
  "literally", "honestly", "actually", "like"
];

/** Sentence-initial remarks that only add noise to a subtitle line. */
const LEADING_FILLERS = ["okay so", "ok so", "so yeah", "yeah so", "well", "now"];

const DOUBLED_WORD_EXCEPTIONS = new Set([
  "had", "has", "have", "that", "is", "are", "was", "were", "no", "not",
  "do", "does", "did", "can", "will", "so"
]);

const CN_LEADING_FILLERS = [
  "嗯", "呃", "啊", "哦", "噢", "唉", "欸", "那个", "就是说", "然后呢"
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseSpaces(text) {
  return text.replace(/\s+/g, " ").trim();
}

function tidyEnglishPunctuation(text) {
  return collapseSpaces(
    text
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,.;:!?])\1+/g, "$1")
      .replace(/^[,;:.!?]+\s*/, "")
      .replace(/([,;:])\s*([.!?])/g, "$2")
    );
}

function restoreLeadingCase(original, cleaned) {
  if (!cleaned || !/^[A-Z]/.test(original)) return cleaned;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** "is kind of weird" / "was sort of broken": no comma needed to be filler. */
const COPULA_FILLER = new RegExp(
  `\\b(is|are|was|were|it's|that's|i'm|we're|they're|he's|she's)\\s+(?:kind of|sort of|kinda|sorta)\\s+`,
  "gi"
);

/**
 * Drops filler words, false starts and stutters from an English segment.
 * Returns the original text when cleaning would leave nothing to translate.
 */
export function stripSpeechFillers(value) {
  const original = typeof value === "string" ? value : "";
  if (!original.trim()) return original;
  let text = collapseSpaces(original);

  // 1. Comma-bounded asides: ", you know," -> "," and "you know, ..." -> "".
  for (const filler of ASIDE_FILLERS) {
    const word = escapeRegExp(filler);
    text = text.replace(new RegExp(`[,;:]\\s*${word}\\s*[,;:]`, "gi"), ",");
    text = text.replace(new RegExp(`^${word}\\s*[,;:]\\s*`, "i"), "");
  }

  // 2. "it is kind of weird" -> "it is weird".
  text = text.replace(COPULA_FILLER, "$1 ");

  // 3. Standalone interjections: "Um," / " uh " / "Hmm.".
  for (const filler of STANDALONE_FILLERS) {
    const pattern = new RegExp(`(^|[\\s,;:])${filler}(?=$|[\\s,;:.!?])`, "gi");
    text = text.replace(pattern, (match, before) => before || "");
  }

  // 4. Sentence-initial remarks ("Well," / "Now,").
  for (const filler of LEADING_FILLERS) {
    const pattern = new RegExp(`^${escapeRegExp(filler)}\\s*[,;:]?\\s+`, "i");
    text = text.replace(pattern, "");
  }

  // 5. Stutters: "I I think", "the the map". Legal repeats are left alone.
  text = text.replace(/\b([a-z']{1,6})(?:\s+\1\b)+/gi, (match, word) =>
    DOUBLED_WORD_EXCEPTIONS.has(word.toLowerCase()) ? match : word
  );

  const cleaned = restoreLeadingCase(original, tidyEnglishPunctuation(text));
  if (!/[a-z0-9]/i.test(cleaned)) return original;
  return cleaned;
}

/**
 * Removes the Chinese equivalents of the fillers the model may still emit.
 * Sentence-initial only, so "啊" inside a sentence (a real interjection the
 * speaker used) survives.
 */
export function polishTranslation(value) {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  for (const filler of CN_LEADING_FILLERS) {
    const pattern = new RegExp(
      `^(?:${escapeRegExp(filler)})[，,、。！？\\s]*`,
      "u"
    );
    // Repeat until stable, so "嗯嗯，" loses every leading interjection.
    let next = text.replace(pattern, "");
    while (next !== text) {
      text = next;
      next = text.replace(pattern, "");
    }
  }
  text = text
    .replace(/([，。！？；、])\1+/gu, "$1")
    .replace(/^(?:[，,、；;：:]+)/u, "")
    .replace(/\s+/g, " ")
    .trim();
  // Never return an empty string for a non-empty input: the caller would see
  // it as a failed translation and retry the same row forever.
  return text || (typeof value === "string" ? value.trim() : "");
}
