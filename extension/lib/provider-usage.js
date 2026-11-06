/**
 * Account-level usage endpoints for the providers that expose one.
 *
 * DeepL bills characters and publishes `character_count` / `character_limit` for
 * the billing period; DeepSeek publishes the remaining balance. Bailian answers
 * neither question over its API key (the quota lives in the console and the
 * `bl` CLI), and OpenAI needs an organization admin key, so those fall back to
 * the local ledger.
 *
 * Pure: no chrome.*, no DOM.
 */
import { deeplBaseUrl, TRANSLATION_PROVIDERS } from "./translation-api.js";

/**
 * What to call for a provider, or null when there is no endpoint to call.
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string }} config
 * @returns {{ url: string, headers: Record<string, string> } | null}
 */
export function providerUsageRequest(config = {}) {
  const provider = String(config.provider || "");
  const apiKey = String(config.apiKey || "").trim();
  if (!apiKey) return null;
  if (provider === "deepl") {
    const base = deeplBaseUrl(config.baseUrl, apiKey, TRANSLATION_PROVIDERS.deepl);
    return {
      url: `${String(base).replace(/\/+$/, "")}/usage`,
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` }
    };
  }
  if (provider === "deepseek") {
    const origin = deepseekOrigin(config.baseUrl);
    if (!origin) return null;
    return {
      url: `${origin}/user/balance`,
      headers: { Authorization: `Bearer ${apiKey}` }
    };
  }
  return null;
}

/**
 * `https://api.deepseek.com/v1` -> `https://api.deepseek.com`, because the
 * balance endpoint sits outside the OpenAI-compatible prefix. A custom endpoint
 * that only looks like DeepSeek is left alone (no balance call).
 * @param {string} baseUrl
 */
export function deepseekOrigin(baseUrl) {
  try {
    const url = new URL(String(baseUrl || "").trim());
    const host = url.hostname.toLowerCase();
    if (host !== "api.deepseek.com" && !host.endsWith(".deepseek.com")) return "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

/**
 * Normalizes an endpoint answer into something the panel can print.
 * @param {string} provider
 * @param {any} data Parsed JSON body.
 * @returns {{ kind: "characters", used: number, limit: number }
 *   | { kind: "balance", available: boolean, currency: string, total: number, granted: number, toppedUp: number }}
 */
export function parseProviderUsage(provider, data) {
  if (provider === "deepl") {
    return {
      kind: "characters",
      used: Number(data?.character_count) || 0,
      limit: Number(data?.character_limit) || 0
    };
  }
  if (provider === "deepseek") {
    const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
    return {
      kind: "balance",
      available: data?.is_available !== false,
      currency: String(info?.currency || ""),
      total: Number(info?.total_balance) || 0,
      granted: Number(info?.granted_balance) || 0,
      toppedUp: Number(info?.topped_up_balance) || 0
    };
  }
  throw new Error(`no usage endpoint for provider ${provider}`);
}
