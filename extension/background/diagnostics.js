import { msg } from "../lib/i18n-message.js";
import {
  providerName,
  resolveTranslationConfig,
  testTranslationConnection,
  translationConfigIssue
} from "../lib/translation-api.js";
import { render, t } from "./i18n.js";

export const LOCAL_TRANSLATION_HEALTH_URL = "http://127.0.0.1:8013/health";
const HEALTH_TIMEOUT_MS = 1600;

/** Round trip through the configured translation API, for the popup button. */
export async function testTranslationApi(config, options = {}) {
  if (config.mode !== "api") {
    throw new Error(t("diag_local_mode_no_api_test"));
  }
  const issue = translationConfigIssue(config);
  if (issue) throw new Error(render(issue));
  const result = await testTranslationConnection(config, options);
  return {
    ok: true,
    translation: result.translation,
    model: result.model,
    latencyMs: result.latencyMs
  };
}

/** Health of the ASR service and the translation engine, for the popup. */
export async function probeServices(settings) {
  const translation = resolveTranslationConfig(settings);
  let wsHost = "127.0.0.1";
  let wsPort = "8010";
  let healthProtocol = "http:";
  try {
    const wsUrl = new URL(settings.wsUrl);
    wsHost = wsUrl.hostname;
    wsPort = wsUrl.port || (wsUrl.protocol === "wss:" ? "443" : "80");
    healthProtocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
  } catch {
    // Keep local defaults; settings validation normally prevents this path.
  }
  const services = [];
  try {
    const response = await fetch(`${healthProtocol}//${wsHost}:${wsPort}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    services.push({
      key: "asr",
      ok: response.ok,
      detail: response.ok ? t("diag_asr_online") : `HTTP ${response.status}`
    });
  } catch {
    services.push({ key: "asr", ok: false, detail: t("diag_not_connected") });
  }

  if (translation.mode === "server") {
    try {
      const response = await fetch(LOCAL_TRANSLATION_HEALTH_URL, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      services.push({
        key: "translation",
        ok: response.ok,
        detail: response.ok ? t("diag_translation_online") : `HTTP ${response.status}`
      });
    } catch {
      services.push({ key: "translation", ok: false, detail: t("diag_not_connected") });
    }
  } else {
    services.push({
      key: "translation",
      ok: Boolean(translation.enabled),
      detail: translation.enabled
        ? t("diag_api_configured", render(providerName(translation)))
        : render(translation.issue || msg("translation_not_configured"))
    });
  }
  return services;
}

/** Throws the start-session error when the local translation server is down. */
export async function requireLocalTranslation() {
  try {
    const response = await fetch(LOCAL_TRANSLATION_HEALTH_URL, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    throw new Error(
      t("diag_local_translation_unavailable")
    );
  }
}
