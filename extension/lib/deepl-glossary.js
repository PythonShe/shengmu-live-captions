/**
 * DeepL glossary support for the caption term base.
 *
 * DeepL cannot be given a prompt, so a glossary is the only way to steer its
 * wording. Two facts shape everything here:
 *
 * - Entries are matched case-sensitively, so `Spirit` does not cover `spirit`.
 *   Every term therefore ships its lowercase spelling too (when it differs).
 * - The API only maps whole phrases; an ASR misspelling such as `Path of Excel`
 *   has to be listed on its own, which is why alias spellings from the term
 *   base are expanded into separate entries as well.
 *
 * The Free plan may hold a single glossary, so callers replace it wholesale
 * rather than adding to it; see background/deepl-glossary-service.js.
 */

/** DeepL rejects a single source or target longer than this (UTF-8 bytes). */
export const DEEPL_GLOSSARY_MAX_TERM_BYTES = 1024;
/** Creation must use the root language code; translations may use ZH-HANS. */
export const DEEPL_GLOSSARY_SOURCE_LANG = "EN";
export const DEEPL_GLOSSARY_TARGET_LANG = "ZH";
export const DEEPL_GLOSSARY_NAME = "shengmu-captions";

/** Byte length in UTF-8 without Node's Buffer: lib/ also runs in the browser. */
function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * A term DeepL can actually match: printable, single-line, plain ASCII source.
 * Chinese source text is dropped because the ASR feeds English.
 * @param {{ source?: string, target?: string }} pair
 */
function usablePair(pair) {
  const rawSource = String(pair?.source ?? "");
  const rawTarget = String(pair?.target ?? "");
  // Tabs and newlines are the TSV delimiters; a term containing one would be
  // split into different entries server-side. Checked before collapsing
  // whitespace, which would turn a tab into an innocent-looking space.
  if (/[\t\r\n]/.test(rawSource) || /[\t\r\n]/.test(rawTarget)) return null;
  const source = rawSource.replace(/\s+/g, " ").trim();
  const target = rawTarget.replace(/\s+/g, " ").trim();
  if (!source || !target) return null;
  if (!/[A-Za-z]/.test(source) || /[^\x20-\x7E]/.test(source)) return null;
  if (utf8Length(source) > DEEPL_GLOSSARY_MAX_TERM_BYTES) return null;
  if (utf8Length(target) > DEEPL_GLOSSARY_MAX_TERM_BYTES) return null;
  return { source, target };
}

/**
 * Term base entries -> glossary pairs, aliases expanded and lowercase spellings
 * added. The first entry to claim a source spelling wins, matching the order
 * `resolveEffectiveGlossary` produces (custom terms before presets).
 * @param {{ sources?: string[], source?: string, target?: string }[]} entries
 * @param {{ lowercaseVariants?: boolean }} [options]
 * @returns {{ source: string, target: string }[]}
 */
export function buildDeepLGlossaryPairs(entries, { lowercaseVariants = true } = {}) {
  const pairs = [];
  const seen = new Set();
  const push = (source, target) => {
    const usable = usablePair({ source, target });
    if (!usable || seen.has(usable.source)) return;
    seen.add(usable.source);
    pairs.push(usable);
  };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const spellings = Array.isArray(entry.sources) && entry.sources.length > 0
      ? entry.sources
      : [entry.source];
    for (const spelling of spellings) {
      push(spelling, entry.target);
      if (!lowercaseVariants) continue;
      const lower = String(spelling ?? "").trim().toLowerCase();
      if (lower && lower !== String(spelling ?? "").trim()) push(lower, entry.target);
    }
  }
  return pairs;
}

/**
 * TSV body for `POST /v2/glossaries`. One `source<TAB>target` per line; a term
 * that would break the format was already dropped by buildDeepLGlossaryPairs.
 * @param {{ source: string, target: string }[]} pairs
 */
export function serializeDeepLGlossaryTsv(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .map((pair) => usablePair(pair))
    .filter(Boolean)
    .map((pair) => `${pair.source}\t${pair.target}`)
    .join("\n");
}

/**
 * Stable short hash of the entry set, used to decide whether the glossary that
 * is already on DeepL still matches the term base. Sorted, so a reordering of
 * presets does not force a rebuild.
 * @param {{ source: string, target: string }[]} pairs
 */
export function deepLGlossaryFingerprint(pairs) {
  const lines = (Array.isArray(pairs) ? pairs : [])
    .map((pair) => usablePair(pair))
    .filter(Boolean)
    .map((pair) => `${pair.source}\t${pair.target}`)
    .sort();
  // FNV-1a over the joined text; the count guards against a hash collision
  // silently keeping a glossary with the wrong number of terms.
  let hash = 0x811c9dc5;
  const text = lines.join("\n");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${lines.length}-${hash.toString(16).padStart(8, "0")}`;
}
