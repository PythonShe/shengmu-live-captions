import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  migrateLegacySettings,
  normalizeSettings
} from "../lib/caption-utils.js";
import {
  BAILIAN_CONTEXT_MAX_CHARS,
  bailianInferenceUrl,
  speechPhrases
} from "../lib/asr-sessions.js";
import { buildAsrContextPrompt, resolveEffectiveGlossary } from "../lib/glossary.js";
import {
  TRANSLATION_PROVIDERS,
  normalizeTranslationBaseUrl,
  normalizeTranslationProvider,
  resolveTranslationConfig
} from "../lib/translation-api.js";

// A change to any of these invalidates queued translations and failures.
const TRANSLATION_SETTING_KEYS = Object.freeze([
  "translationMode",
  "translationProvider",
  "translationBaseUrl",
  "translationModel",
  "translationApiKeys",
  "translationTimeoutMs",
  "glossaryEnabled",
  "glossaryPresetIds",
  "glossaryDomainHint",
  "customGlossary",
  "bailianRegion"
]);

export function translationSettingsChanged(patch = {}) {
  return TRANSLATION_SETTING_KEYS.some((key) => key in patch);
}

/**
 * Owns the settings cache backed by chrome.storage.local: loading and
 * migrating, merging patches (with the API key safety rules), and the derived
 * translation config and ASR session URL.
 */
export function createSettingsStore({ storage = chrome.storage.local } = {}) {
  let cache = { ...DEFAULT_SETTINGS };

  async function write() {
    await storage.set({ [SETTINGS_KEY]: cache });
  }

  async function load() {
    const values = await storage.get([SETTINGS_KEY]);
    const stored = values[SETTINGS_KEY];
    try {
      cache = migrateLegacySettings(stored);
      // Persist the migration so a later load never re-derives the defaults.
      if (
        stored &&
        (stored.translationMode === undefined ||
          stored.asrBackend === undefined ||
          stored.translationProvider === undefined)
      ) {
        await write();
      }
    } catch {
      // Keep API keys and other valid fields if only one setting (usually the
      // legacy wsUrl) is malformed.
      cache = normalizeSettings({ ...(stored || {}), wsUrl: DEFAULT_SETTINGS.wsUrl });
      await write();
    }
    if (!stored) await write();
    return cache;
  }

  /** Normalizes and stores `values` on top of the current settings. */
  async function update(values) {
    cache = normalizeSettings({ ...cache, ...values });
    await write();
    return cache;
  }

  /** Merges a settings patch from a UI page, applying the key safety rules. */
  async function applyPatch(patch) {
    const merged = { ...cache, ...patch };
    if (patch.translationProvider) {
      // A provider switch must not inherit another provider's endpoint/model,
      // otherwise a DeepSeek key could be sent to a stale custom URL.
      const preset = TRANSLATION_PROVIDERS[normalizeTranslationProvider(patch.translationProvider)];
      if (!("translationBaseUrl" in patch)) {
        merged.translationBaseUrl = preset.baseUrl;
      }
      if (!("translationModel" in patch)) {
        merged.translationModel = preset.model;
      }
    }
    if (patch.translationApiKeys && typeof patch.translationApiKeys === "object") {
      merged.translationApiKeys = {
        ...cache.translationApiKeys,
        ...patch.translationApiKeys
      };
    }
    if ("translationBaseUrl" in patch) {
      // An explicit endpoint edit must not silently reuse the old key on a new
      // host. Force the user to re-enter it unless this patch also supplies
      // one or the URL is the provider's official preset.
      const provider = normalizeTranslationProvider(merged.translationProvider);
      const preset = TRANSLATION_PROVIDERS[provider];
      let nextUrl;
      try {
        nextUrl = normalizeTranslationBaseUrl(patch.translationBaseUrl, merged.translationBaseUrl);
      } catch {
        nextUrl = merged.translationBaseUrl;
      }
      const providedKey =
        patch.translationApiKeys &&
        typeof patch.translationApiKeys === "object" &&
        provider in patch.translationApiKeys;
      if (!providedKey && nextUrl !== preset.baseUrl && cache.translationBaseUrl !== nextUrl) {
        merged.translationApiKeys = {
          ...merged.translationApiKeys,
          [provider]: ""
        };
      }
    }
    cache = normalizeSettings(merged);
    await write();
    return cache;
  }

  function translationConfig() {
    const base = resolveTranslationConfig(cache);
    const glossary = resolveEffectiveGlossary(cache);
    return {
      ...base,
      glossaryEntries: glossary.entries,
      domainHint: glossary.domainHint
    };
  }

  /** The ASR WebSocket URL for one session, with the glossary hotwords. */
  function sessionWsUrl(baseWsUrl) {
    const url = new URL(baseWsUrl);
    const glossary = resolveEffectiveGlossary(cache);
    const asrContext = glossary.enabled ? buildAsrContextPrompt(glossary.asrEntries) : "";
    if (asrContext) {
      url.searchParams.set("context", asrContext);
    } else {
      url.searchParams.delete("context");
    }
    return url.toString();
  }

  /**
   * What the offscreen document needs to run the chosen speech backend. The
   * Bailian key is not in it: the worker attaches it to the handshake (see
   * asr-auth.js), so it never crosses a message.
   * @param {string} baseWsUrl
   */
  function sessionAsr(baseWsUrl) {
    const glossary = resolveEffectiveGlossary(cache);
    const entries = glossary.enabled ? glossary.asrEntries : [];
    if (cache.asrBackend === "chrome") {
      return { backend: "chrome", lang: "en-US", phrases: speechPhrases(entries) };
    }
    if (cache.asrBackend === "bailian") {
      return {
        backend: "bailian",
        url: bailianInferenceUrl(cache.bailianRegion),
        context: buildAsrContextPrompt(entries, { maxChars: BAILIAN_CONTEXT_MAX_CHARS })
      };
    }
    return { backend: "wlk", wsUrl: sessionWsUrl(baseWsUrl) };
  }

  /** The Bailian key, shared by fun-asr-realtime and Qwen translation. */
  function bailianApiKey() {
    return String(cache.translationApiKeys?.bailian || "");
  }

  return {
    get current() {
      return cache;
    },
    load,
    update,
    applyPatch,
    translationConfig,
    apiTranslationActive: () => translationConfig().enabled,
    sessionWsUrl,
    sessionAsr,
    bailianApiKey
  };
}
