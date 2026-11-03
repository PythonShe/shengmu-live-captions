import {
  resolveTranslationConfig,
  testTranslationConnection,
  translationConfigIssue
} from "../lib/translation-api.js";

export const LOCAL_TRANSLATION_HEALTH_URL = "http://127.0.0.1:8013/health";
const HEALTH_TIMEOUT_MS = 1600;

/** Round trip through the configured translation API, for the popup button. */
export async function testTranslationApi(config, options = {}) {
  if (config.mode !== "api") {
    throw new Error("当前翻译引擎是本地服务端，不需要测试 API");
  }
  const issue = translationConfigIssue(config);
  if (issue) throw new Error(issue);
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
      detail: response.ok ? "ASR 服务在线" : `HTTP ${response.status}`
    });
  } catch {
    services.push({ key: "asr", ok: false, detail: "未连接" });
  }

  if (translation.mode === "server") {
    try {
      const response = await fetch(LOCAL_TRANSLATION_HEALTH_URL, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      services.push({
        key: "translation",
        ok: response.ok,
        detail: response.ok ? "本地翻译服务在线" : `HTTP ${response.status}`
      });
    } catch {
      services.push({ key: "translation", ok: false, detail: "未连接" });
    }
  } else {
    services.push({
      key: "translation",
      ok: Boolean(translation.enabled),
      detail: translation.enabled
        ? `${translation.providerLabel} 已配置（点“测试翻译 API”验证）`
        : translation.issue || "尚未配置翻译 API"
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
      "本地服务端翻译不可用（127.0.0.1:8013）。如果只想跑 ASR，请把翻译引擎切换为 API。"
    );
  }
}
