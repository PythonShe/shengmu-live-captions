/**
 * Keeps one DeepL glossary in step with the caption term base.
 *
 * DeepL has no prompt, so a glossary is the only way to pin terminology. Two
 * account facts drive the design:
 *
 * - The Free plan may hold exactly one glossary (a second POST answers 456
 *   "Too many glossaries"), so the stored glossary is replaced wholesale
 *   instead of being added to.
 * - Creation is the only way to change the entries (v2 has no edit endpoint),
 *   so a term-base change means DELETE then POST. Captions never wait on this:
 *   the sync is a button in the panel, and a missing glossary id simply sends
 *   translations without one.
 *
 * This module touches chrome.* (background layer); pair building, TSV and the
 * fingerprint live in lib/deepl-glossary.js and are unit-tested without Chrome.
 */
import {
  DEEPL_GLOSSARY_NAME,
  DEEPL_GLOSSARY_SOURCE_LANG,
  DEEPL_GLOSSARY_TARGET_LANG,
  buildDeepLGlossaryPairs,
  deepLGlossaryFingerprint,
  serializeDeepLGlossaryTsv
} from "../lib/deepl-glossary.js";
import { TranslationApiError, deeplGlossaryUrl } from "../lib/translation-api.js";
import { msg } from "../lib/i18n-message.js";

/** Frozen top-level key: the id plus what it was built from. */
export const DEEPL_GLOSSARY_STORAGE_KEY = "deeplGlossary";

/**
 * @param {{
 *   getConfig: () => any,
 *   storage?: chrome.storage.StorageArea,
 *   fetchImpl?: typeof fetch
 * }} deps
 */
export function createDeepLGlossaryService({
  getConfig,
  storage = chrome.storage.local,
  fetchImpl = globalThis.fetch
}) {
  /** @type {{ glossaryId: string, fingerprint: string, count: number, updatedAt: string }} */
  let cached = { glossaryId: "", fingerprint: "", count: 0, updatedAt: "" };

  async function load() {
    try {
      const stored = await storage.get(DEEPL_GLOSSARY_STORAGE_KEY);
      const value = stored?.[DEEPL_GLOSSARY_STORAGE_KEY];
      if (value && typeof value === "object") {
        cached = {
          glossaryId: String(value.glossaryId || ""),
          fingerprint: String(value.fingerprint || ""),
          count: Number(value.count) || 0,
          updatedAt: String(value.updatedAt || "")
        };
      }
    } catch {
      // A missing or unreadable entry only means "not synced yet"; the button
      // creates a fresh glossary on demand.
      cached = { glossaryId: "", fingerprint: "", count: 0, updatedAt: "" };
    }
    return cached;
  }

  /** The id translation requests should carry, or "" when nothing is synced. */
  function currentId() {
    return cached.glossaryId;
  }

  /**
   * What the panel shows: whether the glossary on DeepL still matches the term
   * base the user has now. Pure computation, no network.
   */
  function status() {
    const config = getConfig();
    const pairs = buildDeepLGlossaryPairs(config.glossaryEntries || []);
    const fingerprint = deepLGlossaryFingerprint(pairs);
    return {
      synced: Boolean(cached.glossaryId),
      count: cached.count,
      entryCount: pairs.length,
      updatedAt: cached.updatedAt,
      stale: !cached.glossaryId || cached.fingerprint !== fingerprint
    };
  }

  async function readError(response) {
    let text;
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let message = text;
    try {
      message = String(JSON.parse(text)?.message || text);
    } catch {
      // Non-JSON bodies (proxy pages) fall through as plain text.
    }
    return { message: message.slice(0, 200), body: text };
  }

  async function deleteGlossary(baseUrl, apiKey, glossaryId) {
    if (!glossaryId) return;
    try {
      await fetchImpl(deeplGlossaryUrl(baseUrl, glossaryId), {
        method: "DELETE",
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}` }
      });
    } catch {
      // Losing the delete is not fatal: the create below reports the real
      // problem (Free accounts answer 456) and the old id is dropped anyway.
    }
  }

  /**
   * Replaces the DeepL glossary with the current term base.
   * @returns {Promise<{ created: boolean, count: number, stale: boolean }>}
   */
  async function sync() {
    const config = getConfig();
    if (config.provider !== "deepl" || config.protocol !== "deepl") {
      throw new TranslationApiError(msg("deepl_glossary_needs_deepl"), { code: "config" });
    }
    if (!config.apiKey) {
      throw new TranslationApiError(msg("translation_key_missing", "DeepL"), { code: "config" });
    }
    const pairs = buildDeepLGlossaryPairs(config.glossaryEntries || []);
    if (pairs.length === 0) {
      throw new TranslationApiError(msg("deepl_glossary_empty"), { code: "config" });
    }
    const fingerprint = deepLGlossaryFingerprint(pairs);
    if (cached.glossaryId && cached.fingerprint === fingerprint) {
      return { created: false, count: cached.count, stale: false };
    }
    await deleteGlossary(config.baseUrl, config.apiKey, cached.glossaryId);
    // Free accounts allow one glossary, so a leftover one from another tool
    // makes this fail with 456; the message says exactly that.
    const response = await fetchImpl(deeplGlossaryUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: DEEPL_GLOSSARY_NAME,
        entries: serializeDeepLGlossaryTsv(pairs),
        entries_format: "tsv",
        source_lang: DEEPL_GLOSSARY_SOURCE_LANG,
        target_lang: DEEPL_GLOSSARY_TARGET_LANG
      })
    });
    if (!response.ok) {
      const { message } = await readError(response);
      const code = response.status === 456 ? "glossary_quota" : "glossary_create_failed";
      throw new TranslationApiError(
        msg("deepl_glossary_create_failed", response.status, message),
        { code, status: response.status, detail: message }
      );
    }
    const data = await response.json().catch(() => null);
    const glossaryId = String(data?.glossary_id || "");
    if (!glossaryId) {
      throw new TranslationApiError(msg("translation_empty_response"), { code: "empty_response" });
    }
    cached = {
      glossaryId,
      fingerprint,
      count: Number(data?.entry_count) || pairs.length,
      updatedAt: new Date().toISOString()
    };
    await storage.set({ [DEEPL_GLOSSARY_STORAGE_KEY]: cached });
    return { created: true, count: cached.count, stale: false };
  }

  return { load, currentId, status, sync };
}
