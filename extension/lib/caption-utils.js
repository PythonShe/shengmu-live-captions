import {
  DEFAULT_TRANSLATION_MODE,
  DEFAULT_TRANSLATION_PROVIDER,
  DEFAULT_TRANSLATION_TIMEOUT_MS,
  normalizeTranslationSettings
} from "./translation-api.js";
import {
  GLOSSARY_PRESET_IDS,
  MAX_CUSTOM_GLOSSARY_CHARS
} from "./glossary.js";
import { needsCompletion, startsContinuation } from "./utterance.js";

export const SETTINGS_KEY = "settings";
export const RUNTIME_STATE_KEY = "runtimeState";
export const HISTORY_CHANGED_KEY = "historyRevision";

// Local model ids must match .research/local-service/server.mjs and the
// presets in scripts/Start-Services.ps1.
export const LOCAL_TRANSLATION_MODELS = Object.freeze(["9b-q4km", "2b-iq4xs"]);
export const LOCAL_ASR_MODELS = Object.freeze(["large-v3-turbo", "medium"]);

// A domain hint is a single short sentence handed to the model; anything longer
// is prompt pollution, so the stored value is clipped.
export const MAX_GLOSSARY_DOMAIN_HINT_CHARS = 120;

export const DEFAULT_SETTINGS = Object.freeze({
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
  translationBaseUrl: "https://api.deepseek.com/v1",
  translationModel: "deepseek-chat",
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
  detail: "等待开始",
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

// Detail line shown while the page overlay is broken; cleared again once an
// injection succeeds so the status label goes back to its normal wording.
export const OVERLAY_UNAVAILABLE_DETAIL =
  "页面浮层不可用，可在字幕窗口中继续观看";

// Idempotent transition for the page-overlay health flag. Mutates the state in
// place and reports whether anything changed, so callers can skip a broadcast.
export function applyOverlayFailure(state, error) {
  if (!state) return false;
  const message = error ? String(error?.message || error) : "";
  if ((state.overlayError || "") === message) return false;
  state.overlayError = message;
  if (message) {
    state.detail = OVERLAY_UNAVAILABLE_DETAIL;
  } else if (state.detail === OVERLAY_UNAVAILABLE_DETAIL) {
    // The normal status label falls back to the status wording when empty.
    state.detail = "";
  }
  return true;
}

// "dual" keeps the previous translated line above the current one, so a
// sentence cut in two by the ASR segmenter still reads continuously.
const DISPLAY_MODES = new Set(["bilingual", "dual", "chinese", "english"]);

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
  return {
    ...DEFAULT_SETTINGS,
    ...value,
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
    translationMode: translation.mode,
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
  const settings = normalizeSettings(source);
  if (Object.keys(source).length > 0 && source.translationMode === undefined) {
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
    throw new Error("WebSocket 地址格式不正确");
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new Error("WebSocket 地址必须以 ws:// 或 wss:// 开头");
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

  // The source slot never waits for a translation: the newest English (the
  // uncommitted buffer while it is still growing, otherwise the newest
  // committed line) goes on screen as soon as the ASR produces it. The
  // translation slot keeps the previous sentence, flagged `pending`, until the
  // matching translation lands.
  const latestSource = bufferSource || cleanText(latestLine?.source);
  const latestTranslation = bufferSource
    ? bufferTranslation
    : getTranslationText(latestLine);
  const lineId = bufferSource ? null : latestLine?.id || null;
  const failed = Boolean(
    !bufferSource && latestLine?.translationFailed && !latestTranslation
  );

  return {
    lineId,
    // Never copy a translation into the source slot: a translation-only line
    // would otherwise print Chinese in the English row of bilingual mode.
    source: latestSource,
    translation:
      latestTranslation || (failed ? "" : getTranslationText(translatedLine)),
    error: cleanText(current.translationError),
    pending: Boolean(latestSource && !latestTranslation && !failed),
    failed
  };
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

/** A fragment is only merged when the next row really follows it. */
export const FRAGMENT_GAP_SECONDS = 2.0;
export const FRAGMENT_MAX_LINES = 4;
export const FRAGMENT_MAX_CHARS = 180;

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
    const next = { ...line, fragmentLines: 1, open: needsCompletion(line.source) };
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
      (startsContinuation(line.source) || unit.open);
    if (!joinable) {
      unit = startUnit(line);
      continue;
    }
    unit.source = `${unit.source} ${line.source}`.replace(/\s+/g, " ").trim();
    unit.end = line.end || unit.end;
    unit.fragmentLines += 1;
    // Only "this row is itself unfinished" keeps the unit open. A row that
    // merely continues the previous sentence closes it, otherwise a whole
    // paragraph gets glued together and never gets translated.
    unit.open = needsCompletion(line.source);
    // The unit grew, so any translation it already had is stale.
    unit.translation = "";
    unit.translationPending = true;
    unit.translationFailed = false;
  }
  return merged;
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
