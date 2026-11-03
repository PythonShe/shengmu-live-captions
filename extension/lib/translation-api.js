/**
 * OpenAI-compatible translation client used by 声幕 when the translation
 * engine is an external API instead of the WhisperLiveKit server.
 *
 * This module deliberately has no Chrome extension imports so it can be
 * unit-tested with Node's built-in test runner and fetch.
 */

import { buildGlossaryMap, matchGlossaryTerms } from "./glossary.js";

export const DEFAULT_TRANSLATION_MODE = "api";
export const DEFAULT_TRANSLATION_PROVIDER = "deepseek";
export const DEFAULT_TRANSLATION_TIMEOUT_MS = 12000;
export const MIN_TRANSLATION_TIMEOUT_MS = 3000;
export const MAX_TRANSLATION_TIMEOUT_MS = 30000;

export const TRANSLATION_PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    requiresApiKey: true,
    disableThinking: true,
    keyUrl: "https://platform.deepseek.com/api_keys"
  }),
  openai: Object.freeze({
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    requiresApiKey: true,
    disableThinking: false,
    keyUrl: "https://platform.openai.com/api-keys"
  }),
  custom: Object.freeze({
    id: "custom",
    label: "自定义 OpenAI 兼容",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    requiresApiKey: false,
    disableThinking: false,
    keyUrl: ""
  })
});

const PROVIDER_IDS = Object.keys(TRANSLATION_PROVIDERS);
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

export class TranslationApiError extends Error {
  constructor(message, { code = "api_error", status = null, cause = null } = {}) {
    super(message);
    this.name = "TranslationApiError";
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
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
    throw new Error("翻译 API 地址格式不正确");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("翻译 API 地址必须以 http:// 或 https:// 开头");
  }
  if (url.username || url.password) {
    throw new Error("翻译 API 地址不要包含用户名或密码，请使用 API Key");
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

export function resolveTranslationConfig(settings = {}) {
  const normalized = normalizeTranslationSettings(settings);
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
    providerLabel: preset.label,
    requiresApiKey: preset.requiresApiKey,
    disableThinking: preset.disableThinking || isDeepSeekEndpoint,
    keyUrl: preset.keyUrl,
    apiKey
  };
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
    return "尚未填写翻译模型";
  }
  if (config.requiresApiKey && !config.apiKey) {
    return `尚未填写 ${config.providerLabel || "翻译 API"} 的 API Key`;
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
        return "配置了 API Key 时不能使用非本机 http:// 地址，请改用 https://";
      }
    } catch {
      // normalizeTranslationBaseUrl already validates the URL.
    }
  }
  return "";
}

export function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("翻译 API 地址为空");
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
  tokenField = "max_tokens"
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new TranslationApiError("没有需要翻译的文本", { code: "empty" });
  }
  const segments = texts.map((text) => String(text || "").trim());
  if (segments.some((text) => !text)) {
    throw new TranslationApiError("存在空的翻译片段", { code: "empty" });
  }
  const model = String(config?.model || "").trim();
  if (!model) {
    throw new TranslationApiError("尚未填写翻译模型", { code: "config" });
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
    // DeepSeek defaults to thinking mode for some endpoints/models; a
    // reasoning-only completion is useless for subtitles and burns tokens.
    body.thinking = { type: "disabled" };
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
    throw new TranslationApiError("翻译 API 返回了空内容", {
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
      throw new TranslationApiError("翻译 API 返回的 JSON 不完整或格式错误", {
        code: "parse_error"
      });
    }
    parsed = parseNumberedLines(stripped);
  }
  if (!parsed || parsed.length === 0) {
    throw new TranslationApiError("无法解析翻译 API 返回的内容", {
      code: "parse_error"
    });
  }
  // Extra non-empty JSON items mean the model split or merged segments, so
  // slicing would shift every later translation onto the wrong line.
  const extraContent = parsed.slice(count).some((item) => item);
  if (parsed.length < count || extraContent || (!fromJson && parsed.length !== count)) {
    throw new TranslationApiError(
      `翻译 API 返回的条数不匹配（期望 ${count}，实际 ${parsed.length}）`,
      { code: "count_mismatch" }
    );
  }
  const result = parsed.slice(0, count);
  if (result.every((item) => !item)) {
    throw new TranslationApiError("翻译 API 没有返回可用译文", {
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

export function mapHttpError(status, bodyText, providerLabel = "翻译 API") {
  const detail = safeErrorMessage(status, bodyText);
  const suffix = detail ? `：${detail}` : "";
  if (status === 401 || status === 403) {
    return new TranslationApiError(
      `${providerLabel} API Key 无效或没有权限${suffix}`,
      { code: "auth", status }
    );
  }
  if (status === 402) {
    return new TranslationApiError(`${providerLabel} 账户余额不足${suffix}`, {
      code: "balance",
      status
    });
  }
  if (status === 429) {
    return new TranslationApiError(`${providerLabel} 请求过于频繁${suffix}`, {
      code: "rate_limit",
      status
    });
  }
  if (status === 400 || status === 422) {
    return new TranslationApiError(
      `${providerLabel} 拒绝了翻译请求${suffix}`,
      { code: "bad_request", status }
    );
  }
  if (status >= 500) {
    return new TranslationApiError(
      `${providerLabel} 服务暂时不可用（HTTP ${status}）${suffix}`,
      { code: "server", status }
    );
  }
  return new TranslationApiError(
    `${providerLabel} 请求失败（HTTP ${status}）${suffix}`,
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
  return /thinking|unknown|unsupported|unrecognized/i.test(String(bodyText || ""));
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
        `${config.providerLabel || "翻译 API"} 翻译请求超时（${Math.round(
          timeoutMs / 1000
        )} 秒）`,
        { code: "timeout", cause: error }
      );
    }
    if (isAbortError(error)) {
      throw new TranslationApiError("翻译请求已取消", {
        code: "aborted",
        cause: error
      });
    }
    throw new TranslationApiError(
      `无法连接 ${config.providerLabel} 翻译 API（网络或代理错误）`,
      { code: "network", cause: error }
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

/**
 * @param {TranslationRequestOptions & {
 *   fetchImpl?: typeof fetch,
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
  signal = null
} = {}) {
  const resolved = config?.enabled === undefined
    ? { ...config, enabled: true }
    : config;
  if (!resolved?.model) {
    throw new TranslationApiError("尚未配置翻译 API", { code: "config" });
  }
  if (!resolved.enabled) {
    throw new TranslationApiError(
      resolved.issue || "翻译 API 未启用",
      { code: "config" }
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new TranslationApiError("当前环境不支持 fetch", { code: "config" });
  }
  const endpoint = chatCompletionsUrl(resolved.baseUrl);
  const startedAt = Date.now();
  const shapeKey = requestShapeKey(resolved.baseUrl, resolved.model);
  const learned = requestShapeCache.get(shapeKey);
  let includeThinking =
    Boolean(resolved.disableThinking) && learned?.includeThinking !== false;
  let includeTemperature = learned?.includeTemperature !== false;
  let tokenField = learned?.tokenField || "max_tokens";
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
      tokenField !== "max_tokens" ||
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
      resolved.providerLabel || "翻译 API"
    );
  }
  let data;
  try {
    data = JSON.parse(attempt.bodyText);
  } catch {
    throw new TranslationApiError("翻译 API 返回了无法解析的 JSON", {
      code: "parse_error"
    });
  }
  const finishReason = data?.choices?.[0]?.finish_reason;
  if (finishReason === "length") {
    throw new TranslationApiError(
      "翻译 API 输出被截断，请减少批量或调大 max_tokens",
      { code: "truncated" }
    );
  }
  const message = data?.choices?.[0]?.message;
  const content =
    typeof message?.content === "string" ? message.content.trim() : "";
  if (!content) {
    if (typeof message?.reasoning_content === "string" && message.reasoning_content) {
      throw new TranslationApiError(
        "翻译模型只返回了思考内容，请关闭 thinking 模式或更换模型",
        { code: "thinking_only" }
      );
    }
    throw new TranslationApiError("翻译 API 返回了空内容", {
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
