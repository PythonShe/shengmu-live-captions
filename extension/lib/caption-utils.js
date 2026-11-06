import {
  DEFAULT_TRANSLATION_MODE,
  DEFAULT_TRANSLATION_PROVIDER,
  TRANSLATION_PROVIDERS,
  DEFAULT_TRANSLATION_TIMEOUT_MS,
  normalizeTranslationSettings
} from "./translation-api.js";
import {
  GLOSSARY_PRESET_IDS,
  MAX_CUSTOM_GLOSSARY_CHARS
} from "./glossary.js";
import { LocalizedError, msg } from "./i18n-message.js";
import { polishTranslation } from "./speech-cleanup.js";
import { needsCompletion, startsContinuation } from "./utterance.js";

export const SETTINGS_KEY = "settings";
export const RUNTIME_STATE_KEY = "runtimeState";
export const HISTORY_CHANGED_KEY = "historyRevision";

// Local model ids must match the tiers in scripts/local-service/config.mjs
// (tests/service-manager.test.js enforces it).
export const LOCAL_TRANSLATION_MODELS = Object.freeze(["9b-q4km", "2b-iq4xs"]);
export const LOCAL_ASR_MODELS = Object.freeze(["large-v3-turbo", "medium"]);

// A domain hint is a single short sentence handed to the model; anything longer
// is prompt pollution, so the stored value is clipped.
export const MAX_GLOSSARY_DOMAIN_HINT_CHARS = 120;

/**
 * Speech recognition backends:
 * - chrome: Chrome's on-device SpeechRecognition on the tab track (no setup)
 * - bailian: Alibaba Cloud fun-asr-realtime over WebSocket (key, paid)
 * - wlk: the local WhisperLiveKit service on 8010 (best quality, needs setup)
 */
export const ASR_BACKENDS = Object.freeze(["chrome", "bailian", "wlk"]);
export const BAILIAN_REGIONS = Object.freeze(["cn", "intl"]);

export const DEFAULT_SETTINGS = Object.freeze({
  asrBackend: "chrome",
  bailianRegion: "cn",
  wsUrl: "ws://127.0.0.1:8010/asr?target_language=zh",
  displayMode: "bilingual",
  fontSize: 34,
  opacity: 0.86,
  overlayEnabled: true,
  openPanelOnStart: true,
  autoScroll: true,
  localTranslationModel: "9b-q4km",
  localAsrModel: "large-v3-turbo",
  translationMode: DEFAULT_TRANSLATION_MODE,
  translationProvider: DEFAULT_TRANSLATION_PROVIDER,
  translationBaseUrl: TRANSLATION_PROVIDERS[DEFAULT_TRANSLATION_PROVIDER].baseUrl,
  translationModel: TRANSLATION_PROVIDERS[DEFAULT_TRANSLATION_PROVIDER].model,
  translationApiKeys: Object.freeze({}),
  translationTranslatePartial: true,
  translationTimeoutMs: DEFAULT_TRANSLATION_TIMEOUT_MS,
  // Glossary settings live inside `settings`: the chrome.storage.local top
  // level keys are frozen, and content scripts never receive these fields
  // through sanitizeSettingsPatch.
  glossaryEnabled: true,
  glossaryPresetIds: Object.freeze([]),
  glossaryDomainHint: "",
  customGlossary: ""
});

export const EMPTY_RUNTIME_STATE = Object.freeze({
  active: false,
  status: "idle",
  detail: "",
  sessionId: null,
  epochId: null,
  tabId: null,
  tabTitle: "",
  tabUrl: "",
  startedAt: null,
  updatedAt: null,
  wsConnected: false,
  lineCount: 0,
  // Empty when the page overlay is healthy; otherwise the injection error, so
  // the popup can explain why the switch produces nothing.
  overlayError: "",
  audio: null,
  translation: null,
  current: {
    lines: [],
    bufferSource: "",
    bufferTranslation: "",
    translationError: "",
    epochId: null
  }
});

// Message key of the detail line shown while the page overlay is broken;
// cleared again once an injection succeeds so the status label goes back to
// its normal wording.
export const OVERLAY_UNAVAILABLE_DETAIL = "overlay_unavailable_detail";

// Idempotent transition for the page-overlay health flag. Mutates the state in
// place and reports whether anything changed, so callers can skip a broadcast.
// `unavailableDetail` is the localized OVERLAY_UNAVAILABLE_DETAIL text.
export function applyOverlayFailure(state, error, unavailableDetail = OVERLAY_UNAVAILABLE_DETAIL) {
  if (!state) return false;
  const message = error ? String(error?.message || error) : "";
  if ((state.overlayError || "") === message) return false;
  state.overlayError = message;
  if (message) {
    state.detail = unavailableDetail;
  } else if (state.detail === unavailableDetail) {
    // The normal status label falls back to the status wording when empty.
    state.detail = "";
  }
  return true;
}

// "dual" keeps the previous translated line above the current one, so a
// sentence cut in two by the ASR segmenter still reads continuously.
export const DISPLAY_MODES = new Set(["bilingual", "dual", "chinese", "english"]);

// Content scripts only need presentation settings. Translation/API settings
// must come from an extension page so a page-side script cannot redirect the
// stored API key to another endpoint.
const TAB_ALLOWED_SETTING_KEYS = new Set([
  "displayMode",
  "fontSize",
  "opacity",
  "overlayEnabled",
  "openPanelOnStart",
  "autoScroll"
]);

export function sanitizeSettingsPatch(patch, { fromExtensionPage = false } = {}) {
  const value = patch && typeof patch === "object" ? patch : {};
  if (fromExtensionPage) return value;
  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (TAB_ALLOWED_SETTING_KEYS.has(key)) safe[key] = entry;
  }
  return safe;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Opacity 0 is a real user choice (text only), so it must not fall back to the
// default the way a plain `Number(value) || default` would.
function normalizeOpacity(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_SETTINGS.opacity;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? clamp(numeric, 0.05, 1)
    : DEFAULT_SETTINGS.opacity;
}

export function normalizeSettings(value = {}) {
  const displayMode = DISPLAY_MODES.has(value.displayMode)
    ? value.displayMode
    : DEFAULT_SETTINGS.displayMode;
  const translation = normalizeTranslationSettings(value);
  const asrBackend = ASR_BACKENDS.includes(value.asrBackend)
    ? value.asrBackend
    : DEFAULT_SETTINGS.asrBackend;
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    asrBackend,
    bailianRegion: BAILIAN_REGIONS.includes(value.bailianRegion)
      ? value.bailianRegion
      : DEFAULT_SETTINGS.bailianRegion,
    wsUrl: normalizeWsUrl(value.wsUrl || DEFAULT_SETTINGS.wsUrl),
    displayMode,
    fontSize: Math.round(clamp(Number(value.fontSize) || DEFAULT_SETTINGS.fontSize, 20, 64)),
    opacity: normalizeOpacity(value.opacity),
    overlayEnabled: value.overlayEnabled !== false,
    openPanelOnStart: value.openPanelOnStart !== false,
    autoScroll: value.autoScroll !== false,
    localTranslationModel: LOCAL_TRANSLATION_MODELS.includes(
      value.localTranslationModel
    )
      ? value.localTranslationModel
      : DEFAULT_SETTINGS.localTranslationModel,
    localAsrModel: LOCAL_ASR_MODELS.includes(value.localAsrModel)
      ? value.localAsrModel
      : DEFAULT_SETTINGS.localAsrModel,
    // Server mode means WhisperLiveKit translates; the other speech backends
    // have no translator of their own.
    translationMode: asrBackend === "wlk" ? translation.mode : "api",
    translationProvider: translation.provider,
    translationBaseUrl: translation.baseUrl,
    translationModel: translation.model,
    translationApiKeys: translation.apiKeys,
    translationTranslatePartial: translation.translatePartial,
    translationTimeoutMs: translation.timeoutMs,
    glossaryEnabled: value.glossaryEnabled !== false,
    glossaryPresetIds: normalizeGlossaryPresetIds(value.glossaryPresetIds),
    glossaryDomainHint: normalizeGlossaryDomainHint(value.glossaryDomainHint),
    customGlossary: normalizeCustomGlossary(value.customGlossary)
  };
}

/** Unknown or duplicated preset ids are dropped, so a stale storage value (a
 * preset that no longer ships) cannot enable anything. */
function normalizeGlossaryPresetIds(value) {
  const ids = [];
  for (const item of Array.isArray(value) ? value : []) {
    const id = String(item || "").trim();
    if (!GLOSSARY_PRESET_IDS.includes(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

function normalizeGlossaryDomainHint(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_GLOSSARY_DOMAIN_HINT_CHARS);
}

function normalizeCustomGlossary(value) {
  return String(value ?? "").slice(0, MAX_CUSTOM_GLOSSARY_CHARS);
}

/**
 * 0.3.x settings predate translationMode and used the WhisperLiveKit
 * translation server. Preserve that behavior on upgrade; a fresh install
 * (empty object) keeps the new API/DeepSeek default.
 */
export function migrateLegacySettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const existing = Object.keys(source).length > 0;
  // Installs from before the speech backend and built-in translator existed
  // keep what they ran: WhisperLiveKit and the DeepSeek preset.
  const settings = normalizeSettings({
    ...source,
    ...(existing && source.asrBackend === undefined ? { asrBackend: "wlk" } : {}),
    ...(existing && source.translationProvider === undefined
      ? {
          translationProvider: "deepseek",
          translationBaseUrl: source.translationBaseUrl ?? TRANSLATION_PROVIDERS.deepseek.baseUrl,
          translationModel: source.translationModel ?? TRANSLATION_PROVIDERS.deepseek.model
        }
      : {})
  });
  if (existing && source.translationMode === undefined) {
    settings.translationMode = "server";
  }
  return settings;
}

/**
 * Settings that are safe to send to content scripts and extension views.
 * API keys stay in the background service worker and are never broadcast.
 */
export function settingsForBroadcast(value = {}) {
  const normalized = normalizeSettings(value);
  const { translationApiKeys = {}, ...safe } = normalized;
  return {
    ...safe,
    translationApiKeyConfigured: Object.fromEntries(
      Object.keys(translationApiKeys).map((provider) => [
        provider,
        Boolean(translationApiKeys[provider])
      ])
    )
  };
}

/**
 * Settings a page-side content script may see. The caption overlay never reads
 * the glossary text, and a 32 KB custom dictionary would otherwise ride along
 * on every caption-state broadcast, so it is dropped here while extension
 * pages keep using settingsForBroadcast.
 */
export function settingsForCaptions(value = {}) {
  const { customGlossary, ...safe } = settingsForBroadcast(value);
  return safe;
}

export function normalizeWsUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_SETTINGS.wsUrl).trim());
  } catch {
    throw new LocalizedError(msg("ws_url_invalid"));
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new LocalizedError(msg("ws_url_protocol"));
  }
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/asr";
  }
  if (!url.searchParams.has("target_language")) {
    url.searchParams.set("target_language", "zh");
  }
  return url.toString();
}

export function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// A silent or noisy source still makes the ASR emit tiny non-words (a PoE run
// produced a lone "7.8."). Such a fragment is short (it sits inside a pause),
// so a letterless caption is dropped only when it is a decimal/clock shape and
// the line itself is shorter than a spoken word: a 6-second line that transcribes
// as "3.14" can be real speech and is kept. Captions made only of punctuation
// or symbols ("...", "♪") carry no text at all and are always dropped.
const DECIMAL_FRAGMENT = /^\d+(?:\.\d+)+\.*$/;
const CLOCK_FRAGMENT = /^\d{1,2}:\d{2}(?:\.\d+)?$/;
const SYMBOLS_ONLY = /^[\p{P}\p{S}]+$/u;
const NOISE_MAX_DURATION_SECONDS = 1.5;
// Same shape parseTimecode accepts. Both ends must be present and well formed:
// parseTimecode maps anything unparsable to 0, so a missing start would
// otherwise turn "the line ends at 1 s" into a 1-second (noise) duration.
const TIMECODE_SHAPE = /^(?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?$/;

// WhisperLiveKit serialises timestamps as "H:MM:SS.cc" strings, but a numeric
// seconds value is accepted too. Anything else is unknown (null), never zero.
function timecodeSeconds(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, value) : null;
  }
  const text = String(value ?? "").trim();
  return TIMECODE_SHAPE.test(text) ? parseTimecode(text) : null;
}

/**
 * Duration of an ASR line, or null when either timestamp is missing or out of
 * order. null means "unknown" and must never be treated as "very short",
 * otherwise a line without timecodes would be dropped as noise.
 */
export function transcriptDuration(line) {
  const start = timecodeSeconds(line?.start);
  const end = timecodeSeconds(line?.end);
  if (start === null || end === null) return null;
  return end > start ? end - start : null;
}

export function isNoiseTranscript(value, durationSeconds) {
  const text = cleanText(value);
  if (!text) return true;
  if (/\p{L}/u.test(text)) return false;
  if (SYMBOLS_ONLY.test(text)) return true;
  if (!DECIMAL_FRAGMENT.test(text) && !CLOCK_FRAGMENT.test(text)) return false;
  const duration = Number(durationSeconds);
  // An unknown duration is not evidence of noise: keep the line.
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return duration <= NOISE_MAX_DURATION_SECONDS;
}

export function getTranslationText(line) {
  const translation = line?.translation;
  if (typeof translation === "string") {
    return cleanText(translation);
  }
  if (translation && typeof translation === "object") {
    return cleanText(translation.text);
  }
  return "";
}

export function selectDisplayCaption(current = {}) {
  const lines = Array.isArray(current.lines) ? current.lines : [];
  const reversedLines = [...lines].reverse();
  const latestLine = reversedLines.find((line) => line?.source || line?.translation);
  const translatedLine = reversedLines.find((line) => getTranslationText(line));
  const bufferSource = cleanText(current.bufferSource);
  const bufferTranslation = cleanText(current.bufferTranslation);

  // The source slot never waits for a translation, and it never goes backwards
  // either: the buffer only carries the words *after* the newest row, so the
  // slot is that row plus whatever has not been committed yet. Replacing the
  // row with the buffer is what made the English line jump between a whole
  // sentence and two words.
  const latestSource = composeLiveSourceParts(latestLine?.source, bufferSource);
  // The translation slot reads the newest row's own translation first. A row
  // that is still growing keeps the stage translation it already had (see
  // reconcileLineTranslations), so the slot moves forward instead of falling
  // back to the previous sentence on every ASR update.
  const lineTranslation = getTranslationText(latestLine);
  const latestTranslation = lineTranslation || bufferTranslation || getTranslationText(translatedLine);
  const failed = Boolean(latestLine?.translationFailed && !lineTranslation);

  return {
    // The row the translation belongs to, not the buffer: the overlay uses this
    // id to keep the current sentence out of the "previous sentence" slot.
    lineId: latestLine?.id || null,
    // Never copy a translation into the source slot: a translation-only line
    // would otherwise print Chinese in the English row of bilingual mode.
    source: composeLiveSourceText(latestSource),
    // The split itself, so the overlay can dim the words the recogniser has not
    // committed yet. `sourceStable + " " + sourceStash` is always `source`.
    sourceStable: latestSource.stable,
    sourceStash: latestSource.stash,
    translation: latestTranslation,
    error: cleanText(current.translationError),
    // `pending` means "the Chinese on screen is not the newest source yet":
    // either the row has no translation at all, or it still shows a stage
    // translation the growing source has overtaken. The buffer being non-empty
    // is not a wait: WhisperLiveKit keeps a buffer almost all the time, and a
    // dot that glows constantly reads as a permanent failure.
    pending: Boolean(
      latestSource.stable && !failed && (latestLine?.translationPending || !lineTranslation)
    ),
    failed
  };
}

/**
 * English slot text: the newest committed row plus the words the recogniser has
 * not committed yet.
 *
 * WhisperLiveKit writes its buffer as the words *after* the row it is still
 * working on. On 90 s of real samples the buffer never overlapped the row's
 * tail, yet `bufferSource || latestLine.source` made the English slot jump
 * between the whole sentence and one or two words 88 times a minute. Appending
 * keeps the slot monotonic and still shows the newest words.
 *
 * content-overlay.js keeps an inlined copy (it is a classic script and cannot
 * import ES modules); change both or the old-worker fallback and the new path
 * disagree.
 */
export function composeLiveSource(lineSource, bufferSource) {
  return composeLiveSourceText(composeLiveSourceParts(lineSource, bufferSource));
}

/**
 * Same split as `composeLiveSource`, kept apart because the overlay renders the
 * two halves at different opacities: the committed row stays solid, the tail the
 * recogniser is still revising is dimmed.
 *
 * @returns {{ stable: string, stash: string }} `stable` is the committed row,
 *   `stash` the words after it (empty when the buffer adds nothing new).
 */
export function composeLiveSourceParts(lineSource, bufferSource) {
  const line = cleanText(lineSource);
  const buffer = cleanText(bufferSource);
  if (!line) return { stable: buffer, stash: "" };
  if (!buffer) return { stable: line, stash: "" };
  const lineWords = line.split(" ");
  const bufferWords = buffer.split(" ");
  const shorter = Math.min(lineWords.length, bufferWords.length);
  for (let count = shorter; count > 0; count -= 1) {
    const tail = lineWords.slice(-count).join(" ").toLowerCase();
    const head = bufferWords.slice(0, count).join(" ").toLowerCase();
    if (tail !== head) continue;
    // The buffer only repeats the row's tail: nothing new to append.
    return count === bufferWords.length
      ? { stable: line, stash: "" }
      : { stable: line, stash: bufferWords.slice(count).join(" ") };
  }
  return { stable: line, stash: buffer };
}

/** Join the two halves back into the single string the slots measure. */
export function composeLiveSourceText({ stable = "", stash = "" } = {}) {
  if (!stable) return stash;
  return stash ? `${stable} ${stash}` : stable;
}

export function parseTimecode(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  const match = String(value ?? "").trim().match(
    /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/
  );
  if (!match) return 0;
  const [, hours = "0", minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function shiftTimecode(value, offsetSeconds) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const shifted = parseTimecode(text) + Math.max(0, Number(offsetSeconds) || 0);
  const totalCentiseconds = Math.round(shifted * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return (
    `${hours}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.` +
    String(centiseconds).padStart(2, "0")
  );
}

export function formatClock(value) {
  const seconds = Math.max(0, Math.floor(parseTimecode(value)));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function normalizeCaptionLines(data, options = {}) {
  const sessionId = String(options.sessionId || "");
  const epochId = String(options.epochId || "epoch");
  const epochStartedAt = Number(options.epochStartedAt) || Date.now();
  const sessionStartedAt = Number(options.sessionStartedAt) || 0;
  const epochOffsetSeconds =
    sessionStartedAt > 0
      ? Math.max(0, (epochStartedAt - sessionStartedAt) / 1000)
      : 0;
  const sourceLines = Array.isArray(data?.lines) ? data.lines : [];
  const lines = [];
  const seen = new Map();

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index] || {};
    if (Number(line.speaker) === -2) continue;
    const source = cleanText(line.text);
    const translation = getTranslationText(line);
    if (!source && !translation) continue;
    if (source && isNoiseTranscript(source, transcriptDuration(line))) {
      continue;
    }
    const rawStart = String(line.start || "");
    const rawEnd = String(line.end || "");
    const start = shiftTimecode(rawStart, epochOffsetSeconds);
    const end = shiftTimecode(rawEnd, epochOffsetSeconds);
    const relativeOrder = parseTimecode(rawStart) * 1000;
    const baseKey = `${epochId}:${rawStart || `line-${index}`}`;
    const key = `${sessionId}:${baseKey}`;
    const previous = seen.get(key);
    const normalized = {
      id: key,
      sessionId,
      epochId,
      start,
      end,
      source,
      translation,
      translationPending: Boolean(source && !translation),
      speaker: Number.isFinite(Number(line.speaker)) ? Number(line.speaker) : 1,
      detectedLanguage: line.detected_language || line.detectedLanguage || "en",
      order: epochStartedAt + relativeOrder,
      updatedAt: Number(options.updatedAt) || Date.now()
    };

    if (previous) {
      const previousIndex = lines.indexOf(previous);
      lines[previousIndex] = normalized;
      seen.set(key, normalized);
    } else {
      seen.set(key, normalized);
      lines.push(normalized);
    }
  }

  const bufferSource = cleanText(data?.buffer_transcription || data?.bufferSource);

  return {
    lines,
    bufferSource: isNoiseTranscript(bufferSource) ? "" : bufferSource,
    bufferTranslation: cleanText(data?.buffer_translation || data?.bufferTranslation),
    translationError: cleanText(data?.translation_error || data?.translationError),
    status: data?.status || "active_transcription",
    remainingTranscription: Number(data?.remaining_time_transcription) || 0
  };
}

export function mergeCaptionLines(existingLines, incomingLines, limit = 20000) {
  const merged = new Map();
  for (const line of existingLines || []) {
    if (line?.id) merged.set(line.id, line);
  }
  for (const line of incomingLines || []) {
    if (!line?.id) continue;
    const previous = merged.get(line.id);
    merged.set(line.id, previous ? { ...previous, ...line } : line);
  }
  const result = [...merged.values()].sort(
    (left, right) => (left.order || 0) - (right.order || 0)
  );
  return result.length > limit ? result.slice(result.length - limit) : result;
}

/** A growing row is retranslated only after this much new text or this long. */
export const TRANSLATION_RETRANSLATE_MIN_NEW_CHARS = 8;
export const TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS = 400;
/**
 * Same throttle for a backend that bills per character.
 *
 * Every retranslation resends the whole row, so at the free-backend cadence a
 * 120 s session sent about 4.3x its final character count (measured on real
 * DeepL traffic, see PROGRESS.md). The 400 ms window is always satisfied by the
 * ASR cadence (0.5-1.5 s per frame), so the cadence is what has to move: 24
 * characters is about four English words, which lands at 2.6x and still keeps
 * the stage translation following the recogniser.
 */
export const TRANSLATION_RETRANSLATE_PAID_MIN_NEW_CHARS = 24;
export const TRANSLATION_RETRANSLATE_PAID_MIN_INTERVAL_MS = 1200;

/**
 * Which retranslate throttle applies to a resolved translation config.
 *
 * A key means someone pays for the characters, whatever the endpoint is: Chrome
 * builtin and a keyless custom endpoint (a local llama.cpp / Ollama) stay at the
 * responsive cadence, everything else waits for a bigger chunk of the row.
 * @param {{ apiKey?: string }} [config] Resolved translation config.
 * @returns {{ minNewChars: number, minIntervalMs: number }}
 */
export function resolveRetranslateThrottle(config = {}) {
  if (!cleanText(config?.apiKey)) {
    return {
      minNewChars: TRANSLATION_RETRANSLATE_MIN_NEW_CHARS,
      minIntervalMs: TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS
    };
  }
  return {
    minNewChars: TRANSLATION_RETRANSLATE_PAID_MIN_NEW_CHARS,
    minIntervalMs: TRANSLATION_RETRANSLATE_PAID_MIN_INTERVAL_MS
  };
}

/** A fragment is only merged when the next row really follows it. */
export const FRAGMENT_GAP_SECONDS = 2.0;
export const FRAGMENT_MAX_LINES = 4;
export const FRAGMENT_MAX_CHARS = 180;
/**
 * From this length on a row of a split row counts as finished: the cut was made
 * on purpose (see caption-segment.js), so a following "and ..." stays on its own
 * instead of joining back and falling off again a few words later.
 */
export const SEGMENT_CLAUSE_MIN_CHARS = 120;

/**
 * Joins ASR fragments into sentence-level rows.
 *
 * WhisperLiveKit cuts on acoustic agreement, so one spoken sentence often
 * arrives as "that he has found." followed by "From here on." Translated row by
 * row each fragment becomes a dangling Chinese half-sentence. Merging the rows
 * before they reach the translator keeps the unit intact for the subtitle, the
 * history list and the SRT export.
 *
 * The merged row keeps the first row's id, so a growing unit updates an
 * existing row instead of adding one; the id only changes when a new sentence
 * starts.
 */
export function mergeCaptionFragments(lines, options = {}) {
  const source = Array.isArray(lines) ? lines : [];
  const gapSeconds = Number.isFinite(Number(options.gapSeconds))
    ? Number(options.gapSeconds)
    : FRAGMENT_GAP_SECONDS;
  const maxLines = Number(options.maxLines) || FRAGMENT_MAX_LINES;
  const maxChars = Number(options.maxChars) || FRAGMENT_MAX_CHARS;
  const merged = [];
  let unit = null;

  const startUnit = (line) => {
    const next = {
      ...line,
      fragmentLines: 1,
      // Every raw row that went into this unit, first row included. A growing
      // row can push the unit past FRAGMENT_MAX_CHARS and split it again; the
      // row that falls out then keeps a reference to the unit whose stage
      // translation it has to inherit (see reconcileLineTranslations).
      fragmentIds: line.id ? [line.id] : [],
      open: needsCompletion(line.source)
    };
    if (line.segmentOf) next.segmentTail = line.segmentOf;
    merged.push(next);
    return next;
  };

  for (const line of source) {
    if (!line?.source) {
      merged.push(line);
      unit = null;
      continue;
    }
    if (!unit) {
      unit = startUnit(line);
      continue;
    }
    const gapOk =
      !unit.end ||
      !line.start ||
      parseTimecode(line.start) - parseTimecode(unit.end) <= gapSeconds;
    // Join backwards when the row continues the previous sentence, and forwards
    // while the unit itself is still unfinished.
    const joinable =
      gapOk &&
      unit.fragmentLines < maxLines &&
      unit.source.length + line.source.length + 1 <= maxChars &&
      ((startsContinuation(line.source) &&
        !(line.segmentOf && unit.source.length >= SEGMENT_CLAUSE_MIN_CHARS)) ||
        unit.open);
    if (!joinable) {
      unit = startUnit(line);
      continue;
    }
    unit.source = `${unit.source} ${line.source}`.replace(/\s+/g, " ").trim();
    unit.end = line.end || unit.end;
    unit.fragmentLines += 1;
    if (line.id) unit.fragmentIds = [...(unit.fragmentIds || []), line.id];
    // The split row the unit now ends in, which is what decides its end time
    // (see settleSegmentTimes).
    if (line.segmentOf) unit.segmentTail = line.segmentOf;
    else delete unit.segmentTail;
    // A server translation may stand in for the unit only if it covers all of
    // it (see reconcileLineTranslations).
    const unitTranslation = getTranslationText(unit);
    const rowTranslation = getTranslationText(line);
    if (unit.translationPartial || !unitTranslation || !rowTranslation) {
      unit.translationPartial = true;
    } else {
      unit.translation = `${unitTranslation}${rowTranslation}`;
    }
    // Only "this row is itself unfinished" keeps the unit open. A row that
    // merely continues the previous sentence closes it, otherwise a whole
    // paragraph gets glued together and never gets translated.
    unit.open = needsCompletion(line.source);
    // The unit grew, so any translation it already had is stale. It is not
    // dropped here: reconcileLineTranslations keeps it on screen as a stage
    // translation until the new one lands.
    unit.translationPending = true;
    unit.translationFailed = false;
  }
  return merged;
}

/**
 * Carries row translations across one ASR update.
 *
 * The recogniser appends to the row it is still working on, so a row's source
 * changes several times per sentence. Clearing the translation on every change
 * is what made the caption flash a stage translation, drop back to the previous
 * sentence, then dump the whole paragraph once the sentence stopped growing.
 * Here a row keeps its translation and records which source it describes; a
 * translation that no longer matches the source is flagged `translationPending`
 * and retranslated, but it stays on screen until the newer one arrives.
 *
 * In API mode the extension translates rows itself, so rows are merged first and
 * any per-row translation coming from the ASR is discarded. In server mode
 * WhisperLiveKit returns its own row translations aligned to its own segments,
 * so those are kept as-is.
 * @param {any[]} previousLines Rows of the previous state, newest window first.
 * @param {any[]} nextLines Rows from this update, already normalised and merged.
 * @param {{ useApi?: boolean, knownLines?: Map<string, any> }} [options]
 *   `knownLines` is the session-wide copy, read only for rows that have already
 *   fallen out of the 120-row runtime window.
 * @returns {any[]}
 */
export function reconcileLineTranslations(previousLines, nextLines, options = {}) {
  const useApi = Boolean(options.useApi);
  const knownLines = options.knownLines instanceof Map ? options.knownLines : null;
  const previous = Array.isArray(previousLines) ? previousLines : [];
  const byId = new Map();
  for (const line of previous) {
    if (line?.id) byId.set(line.id, line);
  }
  // A unit can split again when one of its rows keeps growing past the size
  // limit. The row that falls out never existed on its own, so it has no
  // previous copy; it inherits the unit's stage translation instead of letting
  // the caption fall back to the first row's much older short translation.
  const byFragmentId = new Map();
  for (const line of previous) {
    if (!getTranslationText(line)) continue;
    for (const id of line.fragmentIds || []) {
      if (id && id !== line.id && !byFragmentId.has(id)) {
        byFragmentId.set(id, line);
      }
    }
  }

  return (Array.isArray(nextLines) ? nextLines : []).map((nextLine) => {
    const { translationPartial, ...rawLine } = nextLine;
    const own = byId.get(rawLine.id) || knownLines?.get(rawLine.id) || null;
    const carrier = own || byFragmentId.get(rawLine.id) || null;
    const carried = getTranslationText(carrier);
    // WhisperLiveKit's own translation for this row. In API mode it is the only
    // thing that saves a row when the external API gives up, so it is kept as
    // the fallback for the same source only: a grown row has to be translated
    // again. A merged row missing a fragment's translation has no fallback,
    // because the scheduler stores a fallback as this source's final translation.
    const serverTranslation = polishTranslation(getTranslationText(rawLine));
    const translation = useApi ? carried : serverTranslation;
    const translatedSource = translation
      ? useApi
        ? cleanText(carrier?.translatedSource) || cleanText(carrier?.source)
        : cleanText(rawLine.source)
      : "";
    const fallbackTranslation = useApi
      ? (translationPartial ? "" : serverTranslation) ||
        (carrier?.source === rawLine.source
          ? compactTextOf(carrier?.fallbackTranslation)
          : "")
      : "";
    // The last attempt failed for this exact row, whether or not a stage
    // translation is still on screen. A grown row is a new attempt, never a
    // permanent failure.
    const failed = Boolean(carrier?.translationFailed && carrier.source === rawLine.source);
    return {
      ...rawLine,
      translation,
      translatedSource,
      fallbackTranslation,
      translationPending: useApi
        ? Boolean(rawLine.source && translatedSource !== rawLine.source && !failed)
        : Boolean(rawLine.source && !translation),
      translationFailed: failed
    };
  });
}

function compactTextOf(value) {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value && typeof value === "object") {
    return String(value.text ?? "").replace(/\s+/g, " ").trim();
  }
  return "";
}

/**
 * Whether a growing row is worth retranslating now.
 *
 * A row appends a few words every 0.5-1 s. Translating each append costs a full
 * request (billed per character on DeepL) for a translation the next append
 * makes stale again. Either enough new text or enough time has to pass.
 * @param {any} line The runtime row.
 * @param {{ source?: string, at?: number } | null | undefined} guard What the
 *   last request asked for, and when.
 * @param {{ now?: number, minNewChars?: number, minIntervalMs?: number }} [options]
 * @returns {boolean} true when the row may be sent now.
 */
export function shouldRetranslateLine(line, guard, options = {}) {
  if (!guard) return true;
  // A row with nothing on screen has no reason to wait.
  if (!cleanText(line?.translation)) return true;
  const minNewChars = Number(options.minNewChars) || TRANSLATION_RETRANSLATE_MIN_NEW_CHARS;
  const minIntervalMs =
    Number(options.minIntervalMs) || TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS;
  const at = Number(options.now) || Date.now();
  const grew = cleanText(line?.source).length - cleanText(guard.source).length;
  return grew >= minNewChars || at - Number(guard.at || 0) >= minIntervalMs;
}

/**
 * Decides how to update an append-only transcript list.
 *
 * The live caption page keeps a window of the newest rows, so a new line can
 * either be appended at the end or push the oldest row out of the window. Any
 * other change (filter, session switch, reordering) needs a full rebuild.
 */
export function planTranscriptDiff(previousIds = [], nextIds = []) {
  const previous = Array.isArray(previousIds) ? previousIds : [];
  const next = Array.isArray(nextIds) ? nextIds : [];
  let drop = 0;
  if (previous.length > 0 && next.length > 0) {
    drop = previous.indexOf(next[0]);
    if (drop < 0) return { rebuild: true, drop: 0 };
  }
  if (next.length < previous.length - drop) {
    return { rebuild: true, drop: 0 };
  }
  const aligned = previous
    .slice(drop)
    .every((id, index) => id === next[index]);
  return aligned ? { rebuild: false, drop } : { rebuild: true, drop: 0 };
}

export function lineChanged(previous, next) {
  if (!previous) return true;
  return (
    previous.source !== next.source ||
    previous.translation !== next.translation ||
    previous.start !== next.start ||
    previous.end !== next.end
  );
}

export function lineNeedsTranslation(line) {
  return Boolean(cleanText(line?.source)) && !getTranslationText(line);
}

export function formatSrtTimestamp(value) {
  const totalMilliseconds = Math.max(0, Math.round(Number(value) || 0));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")},` +
    String(milliseconds).padStart(3, "0")
  );
}

export function buildSrt(lines) {
  const ordered = [...(lines || [])].sort(
    (left, right) => (left.order || 0) - (right.order || 0)
  );
  const cues = [];
  let index = 1;
  let previousEnd = 0;

  for (const line of ordered) {
    const startSeconds = Math.max(previousEnd, parseTimecode(line.start));
    const parsedEnd = parseTimecode(line.end);
    let endSeconds = Math.max(startSeconds + 0.45, parsedEnd);
    if (endSeconds - startSeconds > 12) {
      endSeconds = startSeconds + 12;
    }
    const text = cleanText(line.translation || line.source);
    if (!text) continue;
    cues.push(
      `${index}\n${formatSrtTimestamp(startSeconds * 1000)} --> ` +
      `${formatSrtTimestamp(endSeconds * 1000)}\n${text}\n`
    );
    previousEnd = endSeconds + 0.03;
    index += 1;
  }
  return cues.join("\n");
}

export function safeFileStem(value) {
  return cleanText(value || "caption")
    // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80) || "caption";
}

export function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
