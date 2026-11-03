/**
 * OpenAI-compatible translation client used by 声幕 when the translation
 * engine is an external API instead of the WhisperLiveKit server.
 *
 * This module deliberately has no Chrome extension imports so it can be
 * unit-tested with Node's built-in test runner and fetch.
 */

import {
  buildGlossaryMap,
  matchGlossaryTerms,
  protectGlossaryTerms,
  restoreGlossaryTerms
} from "./glossary.js";
import { LocalizedError, isLocalMessage, msg } from "./i18n-message.js";

export const DEFAULT_TRANSLATION_MODE = "api";
// Fresh installs translate on-device with Chrome's built-in Translator, so
// captions work before any key is entered (see migrateLegacySettings for
// installs that predate it).
export const DEFAULT_TRANSLATION_PROVIDER = "chrome";
export const DEFAULT_TRANSLATION_TIMEOUT_MS = 12000;
export const MIN_TRANSLATION_TIMEOUT_MS = 3000;
export const MAX_TRANSLATION_TIMEOUT_MS = 30000;

export const TRANSLATION_PROVIDERS = Object.freeze({
  // Chrome's on-device Translator API. It exists only in documents, so the
  // worker forwards these requests to the offscreen page; no key, no network,
  // but literal quality and no context, so the popup suggests a key.
  chrome: Object.freeze({
    id: "chrome",
    baseUrl: "",
    model: "builtin",
    requiresApiKey: false,
    builtin: true,
    disableThinking: false,
    keyUrl: ""
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    requiresApiKey: true,
    disableThinking: true,
    keyUrl: "https://platform.deepseek.com/api_keys"
  }),
  openai: Object.freeze({
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    // The cheapest current model; reasoning is switched off for it (see
    // thinkingOffFields), since its default "medium" effort adds seconds.
    model: "gpt-6-luna",
    requiresApiKey: true,
    disableThinking: true,
    tokenField: "max_completion_tokens",
    keyUrl: "https://platform.openai.com/api-keys"
  }),
  // Alibaba Cloud Bailian (Model Studio): the same key also drives the
  // fun-asr-realtime speech backend, so one key covers both halves.
  bailian: Object.freeze({
    id: "bailian",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    requiresApiKey: true,
    disableThinking: true,
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key"
  }),
  custom: Object.freeze({
    id: "custom",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    requiresApiKey: false,
    disableThinking: false,
    keyUrl: ""
  })
});

const PROVIDER_IDS = Object.keys(TRANSLATION_PROVIDERS);

/**
 * A provider's display name as a message (popup keys provider_<id>).
 * @param {{ provider?: string }} [config]
 */
export function providerName(config) {
  const id = config?.provider;
  return id && id in TRANSLATION_PROVIDERS ? msg(`provider_${id}`) : msg("provider_generic");
}

// A Bailian key belongs to one region, and the speech backend's region
// setting already says which, so the Qwen endpoint follows it rather than
// being stored (storing it would clear the shared key on every region switch).
const BAILIAN_COMPATIBLE_URLS = Object.freeze({
  cn: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  intl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
});
const DEFAULT_CONTEXT_LINES = 4;
const MAX_CONTEXT_CHARS = 480;

// The system prompt must stay byte-identical for every request: DeepSeek and
// similar providers cache the longest common message prefix automatically, so
// anything that varies per request (partial flag, domain hint, glossary) lives
// in the user JSON payload instead. Rules 7-9 only say how to read those
// optional payload fields.
const SYSTEM_PROMPT = [
  "你是专业的中英实时字幕翻译器。把英文直播语音转写翻译成简体中文。",
  "必须遵守：",
  "1. 只输出 JSON 字符串数组，长度与输入 segments 完全相同；不要输出 Markdown、代码围栏、编号、注释或解释。",
  "2. 译文要像自然的中文口语：删除语气词、口头禅、结巴重头重复与自我打断（嗯、啊、那个、就是说都不要出现），不要逐词硬译，不要补写原文没有的信息。",
  "3. 人名、地名、品牌、产品名、数字、单位保持准确；没有通用中文译名的专有名词保留英文原文。",
  "4. 输入可能是未说完的半句，也可能把一句话切成了多个片段。只翻译已有内容，不要续写或补全；每条译文只对应同下标的 segments 项，不合并、不拆分、不重复。",
  "5. segments 中相邻的片段来自同一段连续语音：译文必须前后衔接，不要把每个片段都翻成独立完整句，也不要把上一片段的意思再译一遍。",
  "6. context 是紧邻的前文（英文原文与已有中文译文）。译文必须承接前文语境，省略的主语和代词按前文补足；不要重复前文已译的内容。",
  "7. 输入中若有 partial 字段，说明最后一个 segment 是尚未定稿的半句，按该字段的说明翻译：自然、简短，只翻已有内容。",
  "8. 输入中若有 domain 字段，它给出直播领域：请结合该领域语境翻译，并自动修正明显的语音识别同音错词。",
  "9. 输入中若有 glossary 字段，必须严格使用其中的术语译名（若译名与源词相同则保留英文原文）；仅在对应词出现时使用，不要输出或解释术语表。"
].join("\n");

const PARTIAL_INSTRUCTION =
  "最后一个 segment 是实时字幕里尚未定稿的半句，翻译要自然、简短，只翻已有内容。";

export const MAX_RETRY_AFTER_MS = 60000;

/**
 * Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds,
 * clamped to [0, MAX_RETRY_AFTER_MS] so a hostile or buggy server cannot park
 * the scheduler for minutes. Returns null when absent or unparseable.
 * @param {string | null | undefined} value
 * @param {number} [now]
 * @returns {number | null}
 */
export function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    // Date.parse accepts bare numbers like "-5"; an HTTP date has letters.
    if (!/[a-z]/i.test(text)) return null;
    const date = Date.parse(text);
    if (!Number.isFinite(date)) return null;
    ms = date - now;
  }
  if (!Number.isFinite(ms)) return null;
  return Math.round(Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)));
}

/**
 * Error codes (stable; the scheduler branches on them):
 *  config, empty            caller or settings problem, never retry
 *  auth, balance, bad_request  permanent for this config, surface to the user
 *  rate_limit (429), server (>=500), http_error  transient; may carry retryAfterMs
 *  network, timeout         transient transport failures
 *  aborted                  caller cancelled, not an error to report
 *  count_mismatch, parse_error, truncated  batch shape problem; retry in
 *                           halves (see isSplittableTranslationError)
 *  empty_response, empty_translation, thinking_only  the model answered
 *                           badly; plain retry, splitting does not help
 */
export class TranslationApiError extends Error {
  /**
   * @param {import("./i18n-message.js").LocalMessage | string} message
   * @param {{code?: string, status?: number | null, cause?: unknown,
   *   retryAfterMs?: number | null}} [details]
   */
  constructor(
    message,
    { code = "api_error", status = null, cause = null, retryAfterMs = null } = {}
  ) {
    super(isLocalMessage(message) ? message.key : message);
    this.name = "TranslationApiError";
    // The user-facing text; see i18n-message.js errorMessage.
    if (isLocalMessage(message)) this.localMessage = message;
    this.code = code;
    this.status = status;
    // Server-requested wait before retrying (429/503 Retry-After), or null.
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

// Failures where the model answered but the answer does not fit the batch:
// a smaller batch has a real chance of succeeding, unlike auth or network.
const SPLITTABLE_ERROR_CODES = new Set([
  "count_mismatch",
  "parse_error",
  "truncated"
]);

/**
 * True when retrying the batch in two halves is worthwhile.
 * @param {unknown} error
 * @param {number} [batchSize] When given, a single segment is not splittable.
 */
export function isSplittableTranslationError(error, batchSize = Infinity) {
  return (
    error instanceof TranslationApiError &&
    SPLITTABLE_ERROR_CODES.has(error.code) &&
    batchSize > 1
  );
}

export function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    error?.code === "aborted" ||
    error?.code === 20
  );
}

export function normalizeTranslationMode(value) {
  return String(value || "").trim() === "server" ? "server" : "api";
}

export function normalizeTranslationProvider(value) {
  const provider = String(value || "").trim();
  return PROVIDER_IDS.includes(provider) ? provider : DEFAULT_TRANSLATION_PROVIDER;
}

export function normalizeTranslationBaseUrl(value, fallback = "") {
  const raw = String(value || "").trim() || fallback;
  if (!raw) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new LocalizedError(msg("translation_url_invalid"));
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new LocalizedError(msg("translation_url_protocol"));
  }
  if (url.username || url.password) {
    throw new LocalizedError(msg("translation_url_credentials"));
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function normalizeTranslationApiKeys(value) {
  const source = value && typeof value === "object" ? value : {};
  const keys = {};
  for (const provider of PROVIDER_IDS) {
    const raw = source[provider];
    keys[provider] = typeof raw === "string" ? raw.trim() : "";
  }
  return keys;
}

export function normalizeTranslationSettings(value = {}) {
  const provider = normalizeTranslationProvider(value.translationProvider);
  const preset = TRANSLATION_PROVIDERS[provider];
  let baseUrl;
  try {
    baseUrl = normalizeTranslationBaseUrl(
      value.translationBaseUrl,
      preset.baseUrl
    );
  } catch {
    baseUrl = preset.baseUrl;
  }
  const model = String(value.translationModel ?? preset.model).trim();
  const timeout = Number(value.translationTimeoutMs);
  return {
    mode: normalizeTranslationMode(value.translationMode),
    provider,
    baseUrl,
    model,
    apiKeys: normalizeTranslationApiKeys(value.translationApiKeys),
    translatePartial: value.translationTranslatePartial !== false,
    timeoutMs: Number.isFinite(timeout)
      ? Math.min(
          MAX_TRANSLATION_TIMEOUT_MS,
          Math.max(MIN_TRANSLATION_TIMEOUT_MS, Math.round(timeout))
        )
      : DEFAULT_TRANSLATION_TIMEOUT_MS
  };
}

/**
 * The request fields that switch reasoning off, in each provider's dialect.
 * Subtitles need an answer in a few hundred milliseconds, not a plan.
 * @param {string} provider
 * @param {string} model
 * @returns {Record<string, unknown> | null}
 */
export function thinkingOffFields(provider, model) {
  if (provider === "openai") {
    // Older and larger models reject "none" (gpt-4o-mini has no effort at all).
    return /^gpt-(5\.[1-9]|6(\.\d+)?-(luna|terra))/.test(model) ? { reasoning_effort: "none" } : null;
  }
  if (provider === "bailian") return { enable_thinking: false };
  return { thinking: { type: "disabled" } };
}

export function resolveTranslationConfig(settings = {}) {
  const normalized = normalizeTranslationSettings(settings);
  if (normalized.provider === "bailian") {
    normalized.baseUrl =
      BAILIAN_COMPATIBLE_URLS[/** @type {"cn" | "intl"} */ (settings.bailianRegion)] ||
      BAILIAN_COMPATIBLE_URLS.cn;
  }
  const preset = TRANSLATION_PROVIDERS[normalized.provider];
  const apiKey = normalized.apiKeys[normalized.provider] || "";
  let isDeepSeekEndpoint;
  try {
    const host = new URL(normalized.baseUrl).hostname.toLowerCase();
    isDeepSeekEndpoint =
      host === "api.deepseek.com" || host.endsWith(".deepseek.com");
  } catch {
    isDeepSeekEndpoint = false;
  }
  const config = {
    ...normalized,
    requiresApiKey: preset.requiresApiKey,
    builtin: Boolean(preset.builtin),
    disableThinking: false,
    thinkingOff: /** @type {Record<string, unknown> | null} */ (null),
    tokenField: preset.tokenField || "max_tokens",
    keyUrl: preset.keyUrl,
    apiKey
  };
  if (preset.disableThinking || isDeepSeekEndpoint) {
    config.thinkingOff = thinkingOffFields(isDeepSeekEndpoint ? "deepseek" : normalized.provider, normalized.model);
    config.disableThinking = Boolean(config.thinkingOff);
  }
  const issue = translationConfigIssue(config);
  return {
    ...config,
    issue,
    enabled: normalized.mode === "api" && !issue
  };
}

export function translationConfigIssue(config = {}) {
  if (config.mode !== "api") return "";
  if (!String(config.model || "").trim()) {
    return msg("translation_model_missing");
  }
  if (config.requiresApiKey && !config.apiKey) {
    return msg("translation_key_missing", providerName(config));
  }
  if (config.apiKey && config.baseUrl) {
    try {
      const url = new URL(config.baseUrl);
      const host = url.hostname.toLowerCase();
      const loopback =
        host === "localhost" ||
        host === "[::1]" ||
        host === "::1" ||
        /^127\./.test(host);
      if (url.protocol === "http:" && !loopback) {
        return msg("translation_http_with_key");
      }
    } catch {
      // normalizeTranslationBaseUrl already validates the URL.
    }
  }
  return "";
}

export function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new LocalizedError(msg("translation_url_empty"));
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export function recentTranslationContext(
  lines,
  limit = DEFAULT_CONTEXT_LINES,
  excludeIds = null
) {
  const context = [];
  if (Number(limit) <= 0) return context;
  const skip = excludeIds instanceof Set ? excludeIds : null;
  for (const line of [...(lines || [])].reverse()) {
    if (skip && line?.id && skip.has(line.id)) continue;
    const source = String(line?.source || "").replace(/\s+/g, " ").trim();
    // A line that is still being translated is exactly the context the model
    // needs most: dropping it (the old rule) made every batch look like the
    // start of a conversation.
    if (!source) continue;
    const translation = String(
      line?.translation && typeof line.translation === "object"
        ? line.translation.text
        : line?.translation || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    context.unshift({
      source: source.slice(0, MAX_CONTEXT_CHARS),
      translation: translation.slice(0, MAX_CONTEXT_CHARS)
    });
    if (context.length >= Math.max(0, limit)) break;
  }
  return context;
}

function cleanDomainHint(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Output of resolveTranslationConfig: normalized settings plus provider facts.
 * @typedef {Record<string, any>} TranslationConfig
 */

/**
 * @typedef {object} TranslationRequestOptions
 * @property {string[]} [texts] Segments to translate, one result per segment (validated at runtime).
 * @property {object[]} [context] Earlier lines the model should continue from.
 * @property {TranslationConfig} [config]
 * @property {boolean} [partial] The last segment is an unfinished buffer.
 * @property {object[]} [glossaryEntries] Overrides config.glossaryEntries.
 * @property {string} [domainHint] Overrides config.domainHint.
 */

/**
 * @param {TranslationRequestOptions & {
 *   includeThinking?: boolean,
 *   includeTemperature?: boolean,
 *   tokenField?: string
 * }} options
 */
export function buildTranslationRequestBody({
  texts,
  context = [],
  config,
  partial = false,
  glossaryEntries = [],
  domainHint = "",
  includeThinking = true,
  includeTemperature = true,
  tokenField = ""
} = {}) {
  tokenField ||= config?.tokenField || "max_tokens";
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new TranslationApiError(msg("translation_nothing_to_translate"), { code: "empty" });
  }
  const segments = texts.map((text) => String(text || "").trim());
  if (segments.some((text) => !text)) {
    throw new TranslationApiError(msg("translation_empty_segment"), { code: "empty" });
  }
  const model = String(config?.model || "").trim();
  if (!model) {
    throw new TranslationApiError(msg("translation_model_missing"), { code: "config" });
  }
  const effectiveEntries =
    Array.isArray(glossaryEntries) && glossaryEntries.length > 0
      ? glossaryEntries
      : config?.glossaryEntries || [];
  const effectiveDomainHint =
    domainHint || config?.domainHint || "";
  const glossaryMap = buildGlossaryMap(
    matchGlossaryTerms(segments, effectiveEntries)
  );
  const hasGlossary = Object.keys(glossaryMap).length > 0;
  const cleanDomain = cleanDomainHint(effectiveDomainHint);
  const maxTokens = Math.min(
    2048,
    Math.max(128, segments.length * 128 + 64)
  );
  const userPayload = {
    ...(partial ? { partial: PARTIAL_INSTRUCTION } : {}),
    ...(cleanDomain ? { domain: cleanDomain } : {}),
    ...(hasGlossary ? { glossary: glossaryMap } : {}),
    context: Array.isArray(context) ? context.slice(-DEFAULT_CONTEXT_LINES) : [],
    segments
  };
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    [tokenField]: maxTokens,
    stream: false,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify(userPayload)
      }
    ]
  };
  if (tokenField === "max_tokens" && includeTemperature) {
    body.temperature = 0.2;
  }
  if (config?.disableThinking && includeThinking) {
    // DeepSeek, newer OpenAI models and Qwen may think by default; reasoning
    // adds latency and a reasoning-only completion is useless for subtitles.
    Object.assign(body, config.thinkingOff || thinkingOffFields("deepseek", model));
  }
  return body;
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function normalizeTranslationItem(item) {
  if (typeof item === "string") return item.trim();
  if (item && typeof item === "object") {
    const value =
      typeof item.translation === "string"
        ? item.translation
        : typeof item.text === "string"
          ? item.text
          : "";
    return value.trim();
  }
  return "";
}

function parseJsonArray(candidate) {
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.map(normalizeTranslationItem);
  } catch {
    return null;
  }
}

function parseJsonObjectArray(candidate) {
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    const list = parsed.translations || parsed.segments || parsed.output;
    if (!Array.isArray(list)) return null;
    return list.map(normalizeTranslationItem);
  } catch {
    return null;
  }
}

function parseNumberedLines(candidate) {
  const lines = candidate
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d{1,3}[.)、:：]|\[\d{1,3}\])\s+/, "")
        .replace(/^["'“”]|["'“”]$/g, "")
        .trim()
    )
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

export function parseTranslationOutput(content, expectedCount) {
  const count = Math.max(0, Number(expectedCount) || 0);
  const raw = String(content ?? "").trim();
  if (!raw) {
    throw new TranslationApiError(msg("translation_empty_response"), {
      code: "empty_response"
    });
  }
  const stripped = stripCodeFence(raw);
  const candidates = [stripped, raw];
  let parsed = null;
  let fromJson = false;
  for (const candidate of candidates) {
    parsed = parseJsonArray(candidate) || parseJsonObjectArray(candidate);
    if (parsed) {
      fromJson = true;
      break;
    }
  }
  if (!parsed) {
    // A response that starts like JSON but cannot be parsed is usually
    // truncated. Do not fall back to line parsing for it, but keep allowing
    // the "[1] 你好" numbered format.
    const looksJson =
      /^\{/.test(stripped) ||
      (/^\[/.test(stripped) && !/^\[\s*\d{1,3}\]/.test(stripped));
    if (looksJson) {
      throw new TranslationApiError(msg("translation_json_incomplete"), {
        code: "parse_error"
      });
    }
    parsed = parseNumberedLines(stripped);
  }
  if (!parsed || parsed.length === 0) {
    throw new TranslationApiError(msg("translation_unparsable"), {
      code: "parse_error"
    });
  }
  // Extra non-empty JSON items mean the model split or merged segments, so
  // slicing would shift every later translation onto the wrong line.
  const extraContent = parsed.slice(count).some((item) => item);
  if (parsed.length < count || extraContent || (!fromJson && parsed.length !== count)) {
    throw new TranslationApiError(
      msg("translation_count_mismatch", count, parsed.length),
      { code: "count_mismatch" }
    );
  }
  const result = parsed.slice(0, count);
  if (result.every((item) => !item)) {
    throw new TranslationApiError(msg("translation_no_usable"), {
      code: "empty_translation"
    });
  }
  return result;
}

function safeErrorMessage(status, bodyText) {
  const text = String(bodyText || "").trim();
  if (!text) return "";
  try {
    const data = JSON.parse(text);
    const message = data?.error?.message || data?.message || "";
    return String(message).slice(0, 180);
  } catch {
    return text.slice(0, 180);
  }
}

/**
 * @param {number} status
 * @param {string} bodyText
 * @param {import("./i18n-message.js").LocalMessage | string} [provider] Display name.
 * @param {string | null} [retryAfterHeader] Raw Retry-After header value.
 */
export function mapHttpError(
  status,
  bodyText,
  provider = msg("provider_generic"),
  retryAfterHeader = null
) {
  const retryAfterMs =
    status === 429 || status === 503 ? parseRetryAfter(retryAfterHeader) : null;
  const detail = safeErrorMessage(status, bodyText);
  const suffix = detail ? msg("detail_suffix", detail) : "";
  if (status === 401 || status === 403) {
    return new TranslationApiError(
      msg("translation_error_auth", provider, suffix),
      { code: "auth", status }
    );
  }
  if (status === 402) {
    return new TranslationApiError(msg("translation_error_balance", provider, suffix), {
      code: "balance",
      status
    });
  }
  if (status === 429) {
    return new TranslationApiError(msg("translation_error_rate_limit", provider, suffix), {
      code: "rate_limit",
      status,
      retryAfterMs
    });
  }
  if (status === 400 || status === 422) {
    return new TranslationApiError(
      msg("translation_error_bad_request", provider, suffix),
      { code: "bad_request", status }
    );
  }
  if (status >= 500) {
    return new TranslationApiError(
      msg("translation_error_server", provider, status, suffix),
      { code: "server", status, retryAfterMs }
    );
  }
  return new TranslationApiError(
    msg("translation_error_http", provider, status, suffix),
    { code: "http_error", status }
  );
}

function normalizeUsage(usage) {
  return {
    promptTokens: Number(usage?.prompt_tokens) || 0,
    completionTokens: Number(usage?.completion_tokens) || 0,
    totalTokens: Number(usage?.total_tokens) || 0
  };
}

function shouldRetryWithoutThinking(status, bodyText) {
  if (status !== 400) return false;
  return /thinking|reasoning|unknown|unsupported|unrecognized/i.test(String(bodyText || ""));
}

function shouldRetryWithCompletionTokens(status, bodyText) {
  return (
    status === 400 &&
    /max_tokens|max\s*completion\s*tokens/i.test(String(bodyText || ""))
  );
}

/**
 * @typedef {object} RequestShape
 * @property {boolean} includeThinking
 * @property {boolean} includeTemperature
 * @property {"max_tokens" | "max_completion_tokens"} tokenField
 */

// Endpoints that reject a field keep rejecting it, so remember the shape that
// worked instead of paying the failed round trips on every batch. Memory only
// (lost when the service worker sleeps) and keyed without credentials.
/** @type {Map<string, RequestShape>} */
const requestShapeCache = new Map();

function requestShapeKey(baseUrl, model) {
  const url = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .toLowerCase();
  return `${url}\n${String(model || "").trim()}`;
}

export function resetTranslationRequestShapeCache() {
  requestShapeCache.clear();
}

async function postChatCompletion({
  endpoint,
  body,
  config,
  fetchImpl,
  signal
}) {
  const controller = new AbortController();
  const timeoutMs =
    Number(config.timeoutMs) || DEFAULT_TRANSLATION_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // Keep the timeout active while reading the body: a server can send
    // headers and then stall the body forever.
    const bodyText = await response.text();
    return { response, bodyText };
  } catch (error) {
    if (timedOut) {
      throw new TranslationApiError(
        msg("translation_timeout", providerName(config), Math.round(timeoutMs / 1000)),
        { code: "timeout", cause: error }
      );
    }
    if (isAbortError(error)) {
      throw new TranslationApiError(msg("translation_aborted"), {
        code: "aborted",
        cause: error
      });
    }
    throw new TranslationApiError(
      msg("translation_network", providerName(config)),
      { code: "network", cause: error }
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Translates one string per call with Chrome's on-device Translator, which the
 * worker cannot reach itself (the offscreen document runs it).
 * @typedef {(texts: string[], options: { signal: AbortSignal | null }) => Promise<string[]>} BuiltinTranslate
 */

/**
 * The built-in path: no prompt, no context, so the glossary rides along as
 * placeholder words. A line whose placeholder the model dropped is translated
 * again without them rather than shown with a nonsense word.
 * @param {{ texts: string[], entries: object[], builtinTranslate?: BuiltinTranslate,
 *   signal: AbortSignal | null }} options
 */
async function translateWithBuiltin({ texts, entries, builtinTranslate, signal }) {
  if (typeof builtinTranslate !== "function") {
    throw new TranslationApiError(msg("translation_builtin_unavailable"), { code: "builtin_unavailable" });
  }
  const startedAt = Date.now();
  const segments = texts.map((text) => String(text || "").trim());
  if (segments.length === 0 || segments.some((text) => !text)) {
    throw new TranslationApiError(msg("translation_empty_segment"), { code: "empty" });
  }
  const protectedRows = segments.map((text) => protectGlossaryTerms(text, entries));
  const first = await builtinTranslate(protectedRows.map((row) => row.text), { signal });
  if (!Array.isArray(first) || first.length !== segments.length) {
    throw new TranslationApiError(msg("translation_builtin_count"), { code: "count_mismatch" });
  }
  const translations = first.map((text, index) =>
    restoreGlossaryTerms(text, protectedRows[index].slots)
  );
  const lost = translations.flatMap((text, index) => (text === null ? [index] : []));
  if (lost.length > 0) {
    const retried = await builtinTranslate(lost.map((index) => segments[index]), { signal });
    lost.forEach((index, position) => {
      translations[index] = String(retried?.[position] ?? "");
    });
  }
  return {
    translations: /** @type {string[]} */ (translations),
    usage: null,
    model: "chrome-builtin",
    latencyMs: Date.now() - startedAt
  };
}

/**
 * @param {TranslationRequestOptions & {
 *   fetchImpl?: typeof fetch,
 *   builtinTranslate?: BuiltinTranslate,
 *   signal?: AbortSignal | null
 * }} options
 */
export async function translateTexts({
  texts,
  context = [],
  config,
  partial = false,
  glossaryEntries = [],
  domainHint = "",
  fetchImpl = globalThis.fetch,
  builtinTranslate = undefined,
  signal = null
} = {}) {
  const resolved = config?.enabled === undefined
    ? { ...config, enabled: true }
    : config;
  if (!resolved?.model) {
    throw new TranslationApiError(msg("translation_not_configured"), { code: "config" });
  }
  if (!resolved.enabled) {
    throw new TranslationApiError(
      resolved.issue || msg("translation_disabled"),
      { code: "config" }
    );
  }
  if (resolved.builtin) {
    const entries =
      Array.isArray(glossaryEntries) && glossaryEntries.length > 0
        ? glossaryEntries
        : resolved.glossaryEntries || [];
    return translateWithBuiltin({ texts, entries, builtinTranslate, signal });
  }
  if (typeof fetchImpl !== "function") {
    throw new TranslationApiError(msg("translation_no_fetch"), { code: "config" });
  }
  const endpoint = chatCompletionsUrl(resolved.baseUrl);
  const startedAt = Date.now();
  const shapeKey = requestShapeKey(resolved.baseUrl, resolved.model);
  const learned = requestShapeCache.get(shapeKey);
  let includeThinking =
    Boolean(resolved.disableThinking) && learned?.includeThinking !== false;
  let includeTemperature = learned?.includeTemperature !== false;
  const defaultTokenField = resolved.tokenField || "max_tokens";
  let tokenField = learned?.tokenField || defaultTokenField;
  let attempt = null;
  // One initial try plus one retry per distinct fallback (thinking, token
  // field, temperature); each fallback can fire at most once.
  for (let cycle = 0; cycle < 4; cycle += 1) {
    attempt = await postChatCompletion({
      endpoint,
      body: buildTranslationRequestBody({
        texts,
        context,
        config: resolved,
        partial,
        glossaryEntries,
        domainHint,
        includeThinking,
        includeTemperature,
        tokenField
      }),
      config: resolved,
      fetchImpl,
      signal
    });
    if (attempt.response.ok) break;
    if (
      includeThinking &&
      shouldRetryWithoutThinking(attempt.response.status, attempt.bodyText)
    ) {
      includeThinking = false;
      continue;
    }
    if (
      tokenField === "max_tokens" &&
      shouldRetryWithCompletionTokens(attempt.response.status, attempt.bodyText)
    ) {
      tokenField = "max_completion_tokens";
      continue;
    }
    if (
      includeTemperature &&
      attempt.response.status === 400 &&
      /temperature/i.test(attempt.bodyText)
    ) {
      includeTemperature = false;
      continue;
    }
    break;
  }
  if (attempt?.response.ok) {
    if (
      includeThinking !== Boolean(resolved.disableThinking) ||
      !includeTemperature ||
      tokenField !== defaultTokenField ||
      learned
    ) {
      requestShapeCache.set(shapeKey, {
        includeThinking,
        includeTemperature,
        tokenField
      });
    }
  }
  if (!attempt?.response.ok) {
    throw mapHttpError(
      attempt.response.status,
      attempt.bodyText,
      providerName(resolved),
      attempt.response.headers?.get?.("retry-after") ?? null
    );
  }
  let data;
  try {
    data = JSON.parse(attempt.bodyText);
  } catch {
    throw new TranslationApiError(msg("translation_bad_json"), {
      code: "parse_error"
    });
  }
  const finishReason = data?.choices?.[0]?.finish_reason;
  if (finishReason === "length") {
    throw new TranslationApiError(
      msg("translation_truncated"),
      { code: "truncated" }
    );
  }
  const message = data?.choices?.[0]?.message;
  const content =
    typeof message?.content === "string" ? message.content.trim() : "";
  if (!content) {
    if (typeof message?.reasoning_content === "string" && message.reasoning_content) {
      throw new TranslationApiError(
        msg("translation_thinking_only"),
        { code: "thinking_only" }
      );
    }
    throw new TranslationApiError(msg("translation_empty_response"), {
      code: "empty_response"
    });
  }
  const translations = parseTranslationOutput(content, texts.length);
  return {
    translations,
    usage: normalizeUsage(data.usage),
    model: String(data.model || resolved.model),
    latencyMs: Date.now() - startedAt
  };
}

export async function testTranslationConnection(config, options = {}) {
  const result = await translateTexts({
    texts: [TRANSLATION_TEST_SENTENCE],
    context: [],
    config,
    ...options
  });
  return {
    ok: true,
    translation: result.translations[0],
    model: result.model,
    latencyMs: result.latencyMs,
    usage: result.usage
  };
}

export const TRANSLATION_TEST_SENTENCE =
  "Hello, and welcome to today's live stream.";
