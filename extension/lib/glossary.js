/**
 * Glossary primitives for 声幕: parsing, matching, and prompt serialisation.
 *
 * This module deliberately has no Chrome extension or DOM imports so it can be
 * unit-tested with Node's built-in test runner and reused by the service
 * worker, the popup, and the local control service alike.
 */

import { POE_PRESET_ENTRIES } from "./glossary-poe.js";

// Custom entries are parsed on every translation batch, so the stored text is
// capped to keep chrome.storage.local small and prompt building predictable.
export const MAX_CUSTOM_GLOSSARY_CHARS = 32 * 1024;
// WhisperLiveKit accepts up to 1000 characters of per-session context; the
// remainder is left for safer URL encoding and rolling ASR history.
export const MAX_ASR_CONTEXT_CHARS = 360;
export const MAX_GLOSSARY_MATCHES = 24;
// Windows caps a command line near 32k characters; the WLK glossary travels as
// a PowerShell argument, so keep a wide safety margin.
export const MAX_WLK_GLOSSARY_CHARS = 4000;

export const GLOSSARY_PRESETS = Object.freeze({
  poe: Object.freeze({
    id: "poe",
    label: "流放之路 (Path of Exile 1/2)",
    domainHint: "Path of Exile (流放之路) 游戏直播",
    entries: POE_PRESET_ENTRIES
  })
});

export const GLOSSARY_PRESET_IDS = Object.freeze(Object.keys(GLOSSARY_PRESETS));

// Recognised separators between the source side and the target side. `=>` and
// `->` come before `=` so the first index found is the longest separator.
const ENTRY_DELIMITERS = ["->", "=>", "=", ",", "，", "	"];
const COMMENT_PREFIXES = ["#", "//"];
// Any of these inside a source term would be read back as line syntax instead of
// text, so the exporter quotes such a term. `=` covers `=>`; `->` is explicit.
const LINE_UNSAFE = /[|｜,，	"“”=]|->|^#|^\/\//;
// WhisperLiveKit splits an entry on `;`/newline and takes the text before the
// first `->`, `=>`, `=` or `:`. A source term containing one of those cannot be
// expressed at all; it is skipped instead of being silently rewritten.
const WLK_UNSAFE_SOURCE = /[;\uFF1B:\r\n]|=|->/;
const CSV_HEADER_SOURCES = new Set(["source", "src", "原文"]);
const CSV_HEADER_TARGETS = new Set(["target", "tgt", "target_lang", "tgt_lng", "译文"]);

// Matching runs over every enabled entry for every batch, so compiled regular
// expressions are cached. The cap keeps a pathological import from growing the
// cache without bound.
const PATTERN_CACHE = new Map();
const PATTERN_CACHE_LIMIT = 2000;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function rawText(value) {
  return String(value ?? "").trim();
}

function unquote(value) {
  const text = rawText(value);
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    const inner = text.slice(1, -1);
    return first === '"' ? inner.replace(/""/g, '"') : inner;
  }
  return text;
}

function dedupeSources(items) {
  const aliases = [];
  const seen = new Set();
  for (const item of items) {
    const alias = cleanText(unquote(item));
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

function splitAliases(value) {
  const text = String(value ?? "");
  // Quote-aware: an alias may legally contain `|` once the exporter quoted it.
  const masked = maskQuotedSpans(text);
  const ranges = [];
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== "|" && masked[index] !== "｜") continue;
    ranges.push([start, index]);
    start = index + 1;
  }
  ranges.push([start, text.length]);
  return dedupeSources(ranges.map(([from, to]) => text.slice(from, to)));
}

/**
 * Blanks out quoted spans (same length, so indexes map back) before looking for
 * a separator. Without this, an exported CSV row whose source contains a comma
 * (`"Chaos, Orb",混沌石`) would be split at the comma inside the quotes and
 * silently produce a wrong entry.
 */
function maskQuotedSpans(line) {
  let masked = "";
  let inQuotes = false;
  // Iterate by UTF-16 index, not with for...of: the mask must keep the exact
  // same length as the input, and an astral character (emoji) would otherwise
  // occupy two code units in indexOf/slice but only one masked slot. Only the
  // ASCII quote opens a field; the exporter never emits the curly ones, so a
  // curly quote inside a term must stay plain text.
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      masked += char;
      continue;
    }
    masked += inQuotes ? '\u0000' : char;
  }
  return masked;
}

const CSV_LANG_TAG = /^(?:auto|tgt_lng|target_lang|[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?)$/i;

function stripCsvLanguageColumn(targetPart) {
  const masked = maskQuotedSpans(targetPart);
  const commaIndex = masked.indexOf(",");
  if (commaIndex < 0) return targetPart;
  const thirdColumn = cleanText(unquote(targetPart.slice(commaIndex + 1)));
  if (!thirdColumn || CSV_LANG_TAG.test(thirdColumn)) {
    return targetPart.slice(0, commaIndex);
  }
  return targetPart;
}

/**
 * Splits one glossary line into its source side and target side. Returns null
 * for a line that carries no separator or has an empty side, so malformed input
 * is skipped instead of throwing: the text usually comes from a pasted file.
 */
function splitEntryLine(line) {
  const masked = maskQuotedSpans(line);
  let chosen = null;
  for (const delimiter of ENTRY_DELIMITERS) {
    const index = masked.indexOf(delimiter);
    if (index <= 0) continue;
    if (!chosen || index < chosen.index) chosen = { delimiter, index };
  }
  if (!chosen) return null;
  const sourcePart = line.slice(0, chosen.index);
  const rawTargetPart = line.slice(chosen.index + chosen.delimiter.length);
  const targetPart =
    chosen.delimiter === "," ? stripCsvLanguageColumn(rawTargetPart) : rawTargetPart;
  const target = cleanText(unquote(targetPart));
  const sources = splitAliases(sourcePart);
  if (!target || sources.length === 0) return null;
  // A pasted CSV may keep its header row; it is not a term.
  if (
    sources.length === 1 &&
    CSV_HEADER_SOURCES.has(sources[0].toLowerCase()) &&
    CSV_HEADER_TARGETS.has(target.toLowerCase())
  ) {
    return null;
  }
  return { sources, target };
}

function isCommentLine(line) {
  return COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * Parses the multi-line glossary text written in the popup text area. Accepts
 * `A | B -> 译文`, `A => 译文`, `A = 译文`, CSV `source,target` (one entry per
 * line, quoted fields allowed) and `#` / `//` comments. Later entries win when
 * two lines declare the same primary source.
 */
export function parseGlossaryText(text) {
  const entries = [];
  const index = new Map();
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawText(rawLine);
    if (!line || isCommentLine(line)) continue;
    const entry = splitEntryLine(line);
    if (!entry) continue;
    const key = entry.sources[0].toLowerCase();
    const previous = index.get(key);
    if (previous) {
      entries[entries.indexOf(previous)] = entry;
    } else {
      entries.push(entry);
    }
    index.set(key, entry);
  }
  return entries;
}

/** Normalises caller-provided entries; accepts `{ source }` as a shorthand. */
function normalizeEntries(entries) {
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const target = cleanText(entry.target);
    if (!target) continue;
    // A structured `sources` array is already split: re-running the alias
    // parser on it would turn a literal `|` inside a spelling into two terms.
    const sources = Array.isArray(entry.sources)
      ? dedupeSources(entry.sources)
      : splitAliases(entry.source);
    if (sources.length === 0) continue;
    result.push({ sources, target });
  }
  return result;
}

/**
 * Merges the selected presets with the user's custom text. A custom entry with
 * the same primary source replaces the preset one, which is how a user fixes a
 * disputed translation without editing the bundled dictionary.
 */
export function collectGlossaryEntries({ presetIds = [], customText = "" } = {}) {
  const merged = new Map();
  for (const id of Array.isArray(presetIds) ? presetIds : []) {
    const preset = GLOSSARY_PRESETS[String(id || "").trim()];
    if (!preset) continue;
    for (const entry of normalizeEntries(preset.entries)) {
      merged.set(entry.sources[0].toLowerCase(), entry);
    }
  }
  for (const entry of parseGlossaryText(customText)) {
    merged.set(entry.sources[0].toLowerCase(), entry);
  }
  return [...merged.values()];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the word-boundary pattern for one source term. English word tails get
 * an optional plural/possessive suffix so a single `sceptre` entry also covers
 * `sceptres` and `sceptre's`; a consonant + `y` tail inflects to `ies`.
 */
export function buildGlossaryTermPattern(source) {
  const collapsed = cleanText(source);
  if (!collapsed) return "";
  const body = escapeRegex(collapsed).replace(/ /g, "\\s+");
  const last = collapsed[collapsed.length - 1];
  const previous = collapsed[collapsed.length - 2] || "";
  let stem = body;
  let suffix = "";
  if (/[A-Za-z]/.test(last)) {
    if (last === "y" && !/[aeiou]/i.test(previous)) {
      stem = body.slice(0, -1);
      suffix = "(?:y|ies|y['’]s)";
    } else {
      suffix = "(?:s|es|['’]s)?";
    }
  }
  const head = /^[A-Za-z0-9_]/.test(collapsed) ? "(?<![A-Za-z0-9_])" : "";
  const tail = /[A-Za-z0-9_]$/.test(collapsed) ? "(?![A-Za-z0-9_])" : "";
  return `${head}${stem}${suffix}${tail}`;
}

function termRegex(source) {
  const key = source.toLowerCase();
  const cached = PATTERN_CACHE.get(key);
  if (cached) return new RegExp(cached.source, "gi");
  const pattern = buildGlossaryTermPattern(source);
  if (!pattern) return null;
  if (PATTERN_CACHE.size >= PATTERN_CACHE_LIMIT) PATTERN_CACHE.clear();
  PATTERN_CACHE.set(key, new RegExp(pattern, "gi"));
  return new RegExp(pattern, "gi");
}

function overlaps(spans, start, end) {
  return spans.some(([from, to]) => start < to && end > from);
}

/**
 * Returns the glossary entries that actually occur in `texts`, longest source
 * first, at most `maxMatches`. Only the entries found in this batch are meant
 * to reach the prompt: injecting the whole dictionary makes a short sentence
 * recite the term list.
 *
 * Each result is `{ source, target, matched }`, where `source` is the entry's
 * primary spelling and `matched` is the text as it appeared in the caption (an
 * ASR alias such as "Path of Excel" keeps its own spelling).
 */
export function matchGlossaryTerms(texts, entries, maxMatches = MAX_GLOSSARY_MATCHES) {
  const prepared = (Array.isArray(texts) ? texts : []).map((text) => cleanText(text)).filter(Boolean);
  if (prepared.length === 0) return [];
  const limit = Math.max(0, Number(maxMatches) || 0);
  if (limit === 0) return [];
  const candidates = normalizeEntries(entries);
  if (candidates.length === 0) return [];

  // Flatten to (entry, spelling) pairs sorted by the spelling that will be
  // matched so a short alias of a long entry cannot steal a longer phrase span.
  const pairs = [];
  for (const entry of candidates) {
    for (const source of entry.sources) pairs.push({ entry, source });
  }
  pairs.sort((left, right) => right.source.length - left.source.length);

  const spans = new Map();
  const results = [];
  const recorded = new Set();
  for (const { entry, source } of pairs) {
    if (results.length >= limit) break;
    if (recorded.has(entry)) continue;
    const regex = termRegex(source);
    if (!regex) continue;
    let matched = "";
    for (let index = 0; index < prepared.length; index += 1) {
      const text = prepared[index];
      const used = spans.get(index) || [];
      regex.lastIndex = 0;
      let match = regex.exec(text);
      while (match) {
        const start = match.index;
        const end = start + match[0].length;
        if (match[0].length > 0 && !overlaps(used, start, end)) {
          matched = match[0];
          used.push([start, end]);
          spans.set(index, used);
          break;
        }
        regex.lastIndex = Math.max(regex.lastIndex, start + 1);
        match = regex.exec(text);
      }
      if (matched) break;
    }
    if (!matched) continue;
    recorded.add(entry);
    results.push({ source: entry.sources[0], target: entry.target, matched });
  }
  return results;
}

/**
 * `{ matched: target }` map for the translation request body. Keys keep the
 * spelling the ASR produced so the model can see the error it must correct.
 */
export function buildGlossaryMap(matches) {
  const map = {};
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match?.matched || !match?.target) continue;
    map[match.matched] = match.target;
  }
  return map;
}

/**
 * Resolves the active glossary state from stored extension settings. Custom
 * entries are placed ahead of preset entries for ASR context priority while
 * still overriding matching preset keys for translation.
 */
export function resolveEffectiveGlossary(settings = {}) {
  const enabled = settings?.glossaryEnabled !== false;
  const presetIds = [];
  for (const rawId of Array.isArray(settings?.glossaryPresetIds) ? settings.glossaryPresetIds : []) {
    const id = String(rawId || "").trim();
    if (GLOSSARY_PRESET_IDS.includes(id) && !presetIds.includes(id)) presetIds.push(id);
  }
  const customText = String(settings?.customGlossary ?? "");
  const customEntries = parseGlossaryText(customText);
  const presetEntries = collectGlossaryEntries({ presetIds, customText: "" });
  const entries = enabled ? collectGlossaryEntries({ presetIds, customText }) : [];
  // Put custom entries first in the ASR prompt candidate list so user-typed
  // proper nouns never get crowded out by a large preset dictionary.
  const asrEntries = enabled ? [...customEntries, ...entries] : [];
  const explicitHint = cleanText(settings?.glossaryDomainHint);
  const presetHint = presetIds.map((id) => cleanText(GLOSSARY_PRESETS[id]?.domainHint)).find(Boolean) || "";
  const domainHint = enabled ? explicitHint || presetHint : "";
  return {
    enabled,
    presetIds,
    presetCount: presetEntries.length,
    customCount: customEntries.length,
    entries,
    asrEntries,
    domainHint
  };
}

/**
 * English-only term list for the faster-whisper `initial_prompt` (passed to
 * WhisperLiveKit as the WebSocket `context` query parameter). Only each entry's
 * canonical spelling (`sources[0]`) is included: feeding homophone error
 * aliases (such as "Path of Excel" or "Isamite") to the ASR decoder would bias
 * Whisper toward the wrong spelling.
 */
export function buildAsrContextPrompt(entries, options = {}) {
  const maxChars = Number(options.maxChars) > 0
    ? Number(options.maxChars)
    : MAX_ASR_CONTEXT_CHARS;
  const picked = [];
  const seen = new Set();
  let length = 0;
  for (const entry of normalizeEntries(entries)) {
    const source = entry.sources[0];
    if (!source || !/[A-Za-z]/.test(source) || /[^\x20-\x7E]/.test(source)) {
      continue;
    }
    const key = source.toLowerCase();
    if (seen.has(key)) continue;
    // `+ 2` for the ", " join so the result never exceeds maxChars.
    const addition = (picked.length > 0 ? 2 : 0) + source.length;
    if (length + addition > maxChars) continue;
    seen.add(key);
    picked.push(source);
    length += addition;
  }
  return picked.join(", ");
}

/**
 * WhisperLiveKit's `--openai-translation-glossary` splits on `;`/newlines and
 * matches the left side of `source -> target`, so every alias is expanded into
 * its own pair: WLK has no `|` alias syntax and no plural folding.
 */
export function serializeWlkGlossary(entries, options = {}) {
  const maxChars = Number(options.maxChars) > 0
    ? Number(options.maxChars)
    : MAX_WLK_GLOSSARY_CHARS;
  const parts = [];
  let length = 0;
  for (const entry of normalizeEntries(entries)) {
    const target = entry.target.replace(/[;；\r\n]+/g, " ").trim();
    if (!target) continue;
    for (const source of entry.sources) {
      // Skipping is deliberate: rewriting `A;B` into `A B` would ship a term
      // that never matches the caption, and WLK would truncate `A:B` to `A`.
      if (WLK_UNSAFE_SOURCE.test(source)) continue;
      const pair = `${source} -> ${target}`;
      const addition = (parts.length > 0 ? 2 : 0) + pair.length;
      if (length + addition > maxChars) return parts.join("; ");
      parts.push(pair);
      length += addition;
    }
  }
  return parts.join("; ");
}

function quoted(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvField(value) {
  const text = String(value ?? "");
  // The CSV path goes through the same line parser, so a field that would be
  // read as an alias, a separator or a comment needs quotes even without a
  // comma of its own.
  return /[",\r\n]/.test(text) || LINE_UNSAFE.test(text)
    ? quoted(text)
    : text;
}

/** Quotes a source term that would otherwise collide with the line syntax. */
function textField(value) {
  const text = String(value ?? "");
  return LINE_UNSAFE.test(text) || /[\r\n]/.test(text) ? quoted(text) : text;
}

/**
 * Serialises entries for the popup's export buttons. `text` keeps the editable
 * alias form; `csv` yields one row per alias and round-trips through
 * parseGlossaryText (the Immersive Translate `source,target` shape).
 */
export function exportGlossaryText(entries, format = "text") {
  const normalized = normalizeEntries(entries);
  if (String(format).toLowerCase() === "csv") {
    const rows = [];
    for (const entry of normalized) {
      for (const source of entry.sources) {
        rows.push(`${csvField(source)},${csvField(entry.target)}`);
      }
    }
    return rows.join("\n");
  }
  return normalized
    .map(
      (entry) => `${entry.sources.map(textField).join(" | ")} -> ${entry.target}`
    )
    .join("\n");
}
