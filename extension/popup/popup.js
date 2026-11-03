import {
  DEFAULT_SETTINGS,
  hostnameFromUrl,
  normalizeSettings,
  normalizeWsUrl
} from "../lib/caption-utils.js";
import {
  GLOSSARY_PRESETS,
  MAX_CUSTOM_GLOSSARY_CHARS,
  collectGlossaryEntries,
  exportGlossaryText,
  parseGlossaryText,
  resolveEffectiveGlossary,
  serializeWlkGlossary
} from "../lib/glossary.js";
import {
  TRANSLATION_PROVIDERS,
  normalizeTranslationBaseUrl
} from "../lib/translation-api.js";
import { createCaptionReceiver } from "../lib/caption-delta.js";
import {
  DISPLAY_MODE_LABELS,
  DISPLAY_MODE_ORDER,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  capturePresentation,
  formatBytes
} from "../lib/ui-model.js";

const elements = {
  tabTitle: document.querySelector("#tabTitle"),
  tabUrl: document.querySelector("#tabUrl"),
  statusDot: document.querySelector("#statusDot"),
  statusLabel: document.querySelector("#statusLabel"),
  audioRatio: document.querySelector("#audioRatio"),
  livePreview: document.querySelector("#livePreview"),
  primaryButton: document.querySelector("#primaryButton"),
  primaryLabel: document.querySelector("#primaryLabel"),
  errorMessage: document.querySelector("#errorMessage"),
  displayMode: document.querySelector("#displayMode"),
  fontSize: document.querySelector("#fontSize"),
  fontSizeValue: document.querySelector("#fontSizeValue"),
  opacity: document.querySelector("#opacity"),
  opacityValue: document.querySelector("#opacityValue"),
  overlayEnabled: document.querySelector("#overlayEnabled"),
  overlayHint: document.querySelector("#overlayHint"),
  overlayHintText: document.querySelector("#overlayHintText"),
  overlayRetry: document.querySelector("#overlayRetry"),
  openPanelOnStart: document.querySelector("#openPanelOnStart"),
  wsUrl: document.querySelector("#wsUrl"),
  probeButton: document.querySelector("#probeButton"),
  serviceResults: document.querySelector("#serviceResults"),
  translationMode: document.querySelector("#translationMode"),
  translationProvider: document.querySelector("#translationProvider"),
  apiTranslationFields: document.querySelector("#apiTranslationFields"),
  translationBaseUrl: document.querySelector("#translationBaseUrl"),
  translationModel: document.querySelector("#translationModel"),
  translationApiKey: document.querySelector("#translationApiKey"),
  translationKeyHint: document.querySelector("#translationKeyHint"),
  translationTranslatePartial: document.querySelector(
    "#translationTranslatePartial"
  ),
  testTranslationButton: document.querySelector("#testTranslationButton"),
  clearTranslationKey: document.querySelector("#clearTranslationKey"),
  translationTestResult: document.querySelector("#translationTestResult"),
  translationUsage: document.querySelector("#translationUsage"),
  glossaryEnabled: document.querySelector("#glossaryEnabled"),
  glossaryPresetPoe: document.querySelector("#glossaryPresetPoe"),
  glossarySummaryHint: document.querySelector("#glossarySummaryHint"),
  glossaryDomainHint: document.querySelector("#glossaryDomainHint"),
  customGlossary: document.querySelector("#customGlossary"),
  importGlossaryButton: document.querySelector("#importGlossaryButton"),
  importGlossaryInput: document.querySelector("#importGlossaryInput"),
  exportGlossaryTextButton: document.querySelector("#exportGlossaryTextButton"),
  exportGlossaryCsvButton: document.querySelector("#exportGlossaryCsvButton"),
  glossaryActionHint: document.querySelector("#glossaryActionHint"),
  openMonitor: document.querySelector("#openMonitor"),
  openMonitorFooter: document.querySelector("#openMonitorFooter"),
  localServiceBadge: document.querySelector("#localServiceBadge"),
  localAsrState: document.querySelector("#localAsrState"),
  localTranslationState: document.querySelector("#localTranslationState"),
  localTranslationModel: document.querySelector("#localTranslationModel"),
  localAsrModel: document.querySelector("#localAsrModel"),
  localModelHint: document.querySelector("#localModelHint"),
  localMissingBox: document.querySelector("#localMissingBox"),
  localMissingText: document.querySelector("#localMissingText"),
  localDownloadPage: document.querySelector("#localDownloadPage"),
  localDownloadButton: document.querySelector("#localDownloadButton"),
  localProgress: document.querySelector("#localProgress"),
  localProgressBar: document.querySelector("#localProgressBar"),
  localProgressText: document.querySelector("#localProgressText"),
  localStartButton: document.querySelector("#localStartButton"),
  localStopButton: document.querySelector("#localStopButton"),
  localJobMessage: document.querySelector("#localJobMessage"),
  localServiceOffline: document.querySelector("#localServiceOffline"),
  localServiceCommand: document.querySelector("#localServiceCommand"),
  copyLocalServiceCommand: document.querySelector("#copyLocalServiceCommand"),
  retryLocalService: document.querySelector("#retryLocalService"),
  startControlService: document.querySelector("#startControlService"),
  asrBackend: document.querySelector("#asrBackend"),
  builtinSupportHint: document.querySelector("#builtinSupportHint"),
  bailianFields: document.querySelector("#bailianFields"),
  bailianRegion: document.querySelector("#bailianRegion"),
  bailianApiKey: document.querySelector("#bailianApiKey"),
  bailianKeyHint: document.querySelector("#bailianKeyHint"),
  localModelSection: document.querySelector("#localModelSection"),
  connectionSettings: document.querySelector("#connectionSettings"),
  translationModeRow: document.querySelector("#translationModeRow"),
  translationNudge: document.querySelector("#translationNudge"),
  switchToDeepseek: document.querySelector("#switchToDeepseek"),
  remoteTranslationFields: document.querySelector("#remoteTranslationFields"),
  translationBaseUrlField: document.querySelector("#translationBaseUrlField"),
  translationKeyField: document.querySelector("#translationKeyField")
};

const BUILTIN_SPEECH = { langs: ["en-US"], processLocally: true };
const BUILTIN_LANGUAGES = { sourceLanguage: "en", targetLanguage: "zh" };
// What this Chrome reports for its on-device models: "available",
// "downloadable", "downloading", "unavailable", or "missing" (no API at all).
const builtinSupport = { speech: "", translator: "" };

const LOCAL_SERVICE_URL = "http://127.0.0.1:8014";
// Same on every OS since the Node service manager replaced the .ps1 scripts.
const LOCAL_SERVICE_COMMAND = "pnpm services:serve";
const LOCAL_POLL_MS = 2500;
// Registered by install-windows.cmd; same name as scripts/native-host/protocol.mjs.
const NATIVE_HOST_NAME = "com.shengmu.live_captions";
const IS_WINDOWS = /^Win/i.test(navigator.userAgentData?.platform || navigator.platform || "");

let activeTab = null;
let runtimeState = null;
const captions = createCaptionReceiver({
  requestResync: () => {
    void chrome.runtime.sendMessage({ target: "background", type: "caption-resync" });
  }
});
let settings = normalizeSettings(DEFAULT_SETTINGS);
let busy = false;
let localPollTimer = null;

// Local model control plane. Mirrors what `.research/local-service/server.mjs`
// reports; nothing here creates processes itself.
const local = {
  serviceOnline: false,
  models: null,
  status: null,
  busy: false,
  notice: "",
  noticeAt: 0
};

const LOCAL_NOTICE_TTL_MS = 15000;

// Slider values must survive the runtime-state broadcasts that arrive while the
// user is still dragging or while the debounced save is in flight; otherwise the
// thumb snaps back to the stored value mid-drag.
function createSliderSaver(delayMs, save) {
  const state = { timer: null, token: 0 };
  state.push = (value) => {
    clearTimeout(state.timer);
    const token = ++state.token;
    state.timer = setTimeout(() => {
      state.timer = null;
      save(value)
        .catch((error) => setError(error.message))
        .finally(() => {
          if (token === state.token) state.token = 0;
        });
    }, delayMs);
  };
  state.busy = () => Boolean(state.timer) || state.token > 0;
  return state;
}

const fontSlider = createSliderSaver(180, (value) => savePatch({ fontSize: value }));
const opacitySlider = createSliderSaver(180, (value) => savePatch({ opacity: value }));
const domainHintSaver = createSliderSaver(300, (value) =>
  savePatch({ glossaryDomainHint: value })
);
const customGlossarySaver = createSliderSaver(360, (value) =>
  savePatch({ customGlossary: value })
);

function setGlossaryActionHint(text = "") {
  elements.glossaryActionHint.textContent = text;
  elements.glossaryActionHint.hidden = !text;
}

function collectGlossaryPatchFromInputs() {
  return {
    glossaryEnabled: elements.glossaryEnabled.checked,
    glossaryPresetIds: elements.glossaryPresetPoe.checked ? ["poe"] : [],
    glossaryDomainHint: elements.glossaryDomainHint.value.trim(),
    customGlossary: elements.customGlossary.value.slice(
      0,
      MAX_CUSTOM_GLOSSARY_CHARS
    )
  };
}

function setLocalNotice(text) {
  local.notice = text || "";
  local.noticeAt = Date.now();
}

function setError(message = "") {
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = !message;
}

function populateDisplayModes() {
  elements.fontSize.min = String(FONT_SIZE_MIN);
  elements.fontSize.max = String(FONT_SIZE_MAX);
  elements.displayMode.replaceChildren(
    ...DISPLAY_MODE_ORDER.map((mode) => new Option(DISPLAY_MODE_LABELS[mode], mode))
  );
}

populateDisplayModes();

function render() {
  const displayTab = runtimeState?.active
    ? { title: runtimeState.tabTitle, url: runtimeState.tabUrl }
    : activeTab;
  elements.tabTitle.textContent = displayTab?.title || "没有可用的标签页";
  elements.tabUrl.textContent = displayTab?.url
    ? hostnameFromUrl(displayTab.url) || displayTab.url
    : "请先打开直播或视频页面";

  const presentation = capturePresentation(runtimeState);
  // Same-text writes still replace the node and make screen readers repeat the
  // status, and render() runs on every broadcast.
  if (elements.statusLabel.textContent !== presentation.summary) {
    elements.statusLabel.textContent = presentation.summary;
  }
  elements.statusDot.className = `status-dot ${presentation.dotClass}`.trim();
  elements.audioRatio.textContent = presentation.ratio;

  const current = runtimeState?.current;
  const lastLine = current?.lines?.at(-1);
  const preview =
    current?.bufferTranslation ||
    lastLine?.translation ||
    current?.bufferSource ||
    lastLine?.source ||
    "";
  elements.livePreview.textContent = preview;
  elements.livePreview.hidden = !preview;

  const active = Boolean(runtimeState?.active);
  elements.primaryLabel.textContent = active ? "停止当前字幕" : "开始实时翻译";
  elements.primaryButton.classList.toggle("stop", active);
  // aria-busy instead of disabled: a disabled button drops keyboard focus
  // mid-action. The click handler ignores presses while busy.
  elements.primaryButton.setAttribute("aria-busy", String(busy));

  elements.displayMode.value = settings.displayMode;
  // A slider being dragged, or one whose save is still debounced, must not be
  // yanked back to the stored value by a background state broadcast.
  if (!fontSlider.busy()) {
    elements.fontSize.value = String(settings.fontSize);
    elements.fontSizeValue.value = String(settings.fontSize);
  }
  if (!opacitySlider.busy()) {
    const opacityPercent = Math.round(settings.opacity * 100);
    elements.opacity.value = String(opacityPercent);
    elements.opacityValue.value = `${opacityPercent}%`;
  }
  elements.overlayEnabled.checked = settings.overlayEnabled;
  renderOverlayHint();
  elements.openPanelOnStart.checked = settings.openPanelOnStart;
  setFieldValue(elements.wsUrl, settings.wsUrl);
  renderSpeechSettings();
  renderTranslationSettings();
  renderGlossarySettings();
}

function setFieldValue(element, value) {
  if (document.activeElement !== element) element.value = value;
}

function renderOverlayHint() {
  // A stale failure from a finished session must not keep warning the user, so
  // only an active capture with the overlay switched on shows the hint.
  const failure =
    settings.overlayEnabled && runtimeState?.active
      ? runtimeState?.overlayError || ""
      : "";
  elements.overlayHint.hidden = !failure;
  elements.overlayHintText.textContent = failure
    ? `页面浮层没有生效：${failure}（若刚更新过扩展，请在 chrome://extensions 重新加载并刷新标签页）`
    : "";
}

async function checkBuiltinSupport() {
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  try {
    builtinSupport.speech = Recognition?.available
      ? await Recognition.available(BUILTIN_SPEECH)
      : "missing";
  } catch {
    builtinSupport.speech = "missing";
  }
  try {
    builtinSupport.translator = globalThis.Translator
      ? await globalThis.Translator.availability(BUILTIN_LANGUAGES)
      : "missing";
  } catch {
    builtinSupport.translator = "missing";
  }
  render();
}

function renderSpeechSettings() {
  const backend = settings.asrBackend;
  elements.asrBackend.value = backend;
  const wlk = backend === "wlk";
  elements.localModelSection.hidden = !wlk;
  elements.connectionSettings.hidden = !wlk;
  elements.translationModeRow.hidden = !wlk;
  elements.bailianFields.hidden = backend !== "bailian";
  elements.bailianRegion.value = settings.bailianRegion;
  elements.bailianKeyHint.textContent = settings.translationApiKeyConfigured?.bailian
    ? "Key 已保存，语音识别与通义千问翻译共用。"
    : "按秒计费，Key 同时可用于通义千问翻译。";
  const unsupported =
    (backend === "chrome" && ["missing", "unavailable"].includes(builtinSupport.speech)) ||
    (settings.translationProvider === "chrome" &&
      settings.translationMode === "api" &&
      ["missing", "unavailable"].includes(builtinSupport.translator));
  elements.builtinSupportHint.hidden = !unsupported;
  elements.builtinSupportHint.textContent = unsupported
    ? "这个 Chrome 不支持本机识别或内置翻译（需要 Chrome 138 以上的桌面版），请改用阿里云百炼或填写 DeepSeek Key。"
    : "";
}

/**
 * Chrome downloads its translation model only from a user gesture, so the
 * start click does it while the gesture is still live; the offscreen page
 * can use the model from then on. About 20 s, once.
 */
async function ensureBuiltinTranslator() {
  if (settings.translationMode !== "api" || settings.translationProvider !== "chrome") return;
  if (!globalThis.Translator) return;
  const availability = await globalThis.Translator.availability(BUILTIN_LANGUAGES);
  if (availability === "available" || availability === "unavailable") return;
  elements.statusLabel.textContent = "正在下载 Chrome 翻译模型";
  const translator = await globalThis.Translator.create({
    ...BUILTIN_LANGUAGES,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        elements.statusLabel.textContent = `正在下载 Chrome 翻译模型 ${Math.round(event.loaded * 100)}%`;
      });
    }
  });
  translator.destroy();
  builtinSupport.translator = "available";
}

function renderTranslationSettings() {
  const provider =
    TRANSLATION_PROVIDERS[settings.translationProvider] ||
    TRANSLATION_PROVIDERS.deepseek;
  const configured = Boolean(
    settings.translationApiKeyConfigured?.[provider.id]
  );
  const builtin = Boolean(provider.builtin);
  elements.remoteTranslationFields.hidden = builtin;
  elements.translationBaseUrlField.hidden = provider.id === "bailian";
  // One Bailian key serves both halves; the speech section already asks for it.
  elements.translationKeyField.hidden =
    provider.id === "bailian" && settings.asrBackend === "bailian";
  elements.translationNudge.hidden = !builtin;
  elements.testTranslationButton.textContent = builtin ? "测试内置翻译" : "测试翻译 API";
  elements.translationMode.value = settings.translationMode;
  elements.translationProvider.value = provider.id;
  setFieldValue(elements.translationBaseUrl, settings.translationBaseUrl);
  setFieldValue(elements.translationModel, settings.translationModel);
  elements.translationTranslatePartial.checked =
    settings.translationTranslatePartial;
  elements.apiTranslationFields.hidden = settings.translationMode !== "api";
  elements.translationKeyHint.textContent = configured
    ? `${provider.label} Key 已保存在本机扩展存储中`
    : provider.requiresApiKey
      ? `${provider.label} 需要 API Key；以明文保存在本机扩展存储，不会同步到云端`
      : "自定义服务可以不填 Key";
  elements.clearTranslationKey.hidden = !configured;

  const translationState = runtimeState?.translation;
  const usage = translationState?.usage;
  let usageText;
  if (settings.translationMode === "server") {
    usageText = "本地服务端模式：译文由 WhisperLiveKit 生成。";
  } else if (builtin) {
    usageText = provider.label;
  } else if (usage?.requests > 0) {
    const tokens =
      (Number(usage.promptTokens) || 0) +
      (Number(usage.completionTokens) || 0);
    usageText =
      `${provider.label} · ${settings.translationModel} · ` +
      `本次 ${usage.requests} 次请求 / ${tokens} tokens`;
  } else {
    usageText = `${provider.label} · ${settings.translationModel || "未填模型"}`;
  }
  if (translationState?.error) {
    usageText += ` · ${String(translationState.error).slice(0, 90)}`;
  }
  elements.translationUsage.textContent = usageText;
}

// render() runs on every status broadcast, but the summary only depends on
// these four inputs; resolving and parsing up to 32 KB of glossary text on
// each broadcast is wasted work. The key uses the text itself, not a hash,
// so a stale hit is impossible.
let glossarySummaryCache = { key: "", summary: "", exportable: false };

function glossarySummaryKey(draftSettings) {
  return JSON.stringify([
    draftSettings.glossaryEnabled !== false,
    Array.isArray(draftSettings.glossaryPresetIds)
      ? draftSettings.glossaryPresetIds
      : [],
    draftSettings.glossaryDomainHint || "",
    draftSettings.customGlossary || ""
  ]);
}

function computeGlossarySummary(draftSettings) {
  const effective = resolveEffectiveGlossary(draftSettings);
  let summary;
  if (effective.enabled) {
    summary =
      `已生效 ${effective.entries.length} 条术语` +
      `（内置 ${effective.presetCount} · 自定义 ${effective.customCount}）`;
    if (effective.domainHint) {
      summary += ` · 领域：${effective.domainHint}`;
    }
  } else {
    summary =
      `术语库已关闭（已保存内置 ${effective.presetCount} · 自定义 ${effective.customCount}）`;
  }
  const exportable =
    effective.entries.length > 0 ||
    parseGlossaryText(draftSettings.customGlossary).length > 0;
  return { summary, exportable };
}

function updateGlossarySummaryText(draftSettings = settings) {
  const key = glossarySummaryKey(draftSettings);
  if (key !== glossarySummaryCache.key) {
    glossarySummaryCache = { key, ...computeGlossarySummary(draftSettings) };
  }
  elements.glossarySummaryHint.textContent = glossarySummaryCache.summary;
  elements.exportGlossaryTextButton.disabled = !glossarySummaryCache.exportable;
  elements.exportGlossaryCsvButton.disabled = !glossarySummaryCache.exportable;
}

function renderGlossarySettings() {
  const presetIds = Array.isArray(settings.glossaryPresetIds)
    ? settings.glossaryPresetIds
    : [];
  const poeChecked = presetIds.includes("poe");
  elements.glossaryEnabled.checked = settings.glossaryEnabled !== false;
  elements.glossaryPresetPoe.checked = poeChecked;
  elements.glossaryDomainHint.placeholder = poeChecked
    ? GLOSSARY_PRESETS.poe.domainHint
    : "例如：Path of Exile (流放之路) 游戏直播";
  if (!domainHintSaver.busy()) {
    setFieldValue(
      elements.glossaryDomainHint,
      settings.glossaryDomainHint || ""
    );
  }
  if (!customGlossarySaver.busy()) {
    setFieldValue(elements.customGlossary, settings.customGlossary || "");
  }
  updateGlossarySummaryText({
    ...settings,
    glossaryEnabled: elements.glossaryEnabled.checked,
    glossaryPresetIds: poeChecked ? ["poe"] : [],
    glossaryDomainHint: elements.glossaryDomainHint.value,
    customGlossary: elements.customGlossary.value
  });
}

async function localRequest(path, { timeoutMs = 6000, ...init } = {}) {
  const response = await fetch(`${LOCAL_SERVICE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(
      payload?.error || `本地控制服务返回 HTTP ${response.status}`
    );
    error.payload = payload;
    throw error;
  }
  return payload;
}

function selectedLocalTranslation() {
  return (local.models?.translation || []).find(
    (model) => model.id === settings.localTranslationModel
  );
}

function selectedLocalAsr() {
  return (local.models?.asr || []).find(
    (model) => model.id === settings.localAsrModel
  );
}

let localSelectsSignature = "";

function syncModelSelects() {
  const signature = local.serviceOnline
    ? JSON.stringify([
        (local.models?.translation || []).map((model) => [
          model.id,
          model.label,
          model.exists,
          model.note
        ]),
        (local.models?.asr || []).map((model) => [
          model.id,
          model.label,
          model.cached
        ])
      ])
    : "offline";
  if (signature !== localSelectsSignature) {
    localSelectsSignature = signature;
    const fallback = local.serviceOnline ? "没有可用模型" : "控制服务未连接";
    fillModelSelect(
      elements.localTranslationModel,
      local.models?.translation || [],
      settings.localTranslationModel,
      fallback
    );
    fillModelSelect(
      elements.localAsrModel,
      local.models?.asr || [],
      settings.localAsrModel,
      fallback
    );
  }
  elements.localTranslationModel.disabled = !local.serviceOnline;
  elements.localAsrModel.disabled = !local.serviceOnline;
}

function fillModelSelect(select, entries, selectedId, fallbackLabel) {
  const options = entries.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = entry.label;
    return option;
  });
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = fallbackLabel;
    options.push(option);
  }
  select.replaceChildren(...options);
  const values = options.map((option) => option.value);
  select.value = values.includes(selectedId) ? selectedId : values[0] || "";
}

function renderLocal() {
  const status = local.status;
  const job = status?.job || null;
  const services = status?.services || null;
  const translationModel = selectedLocalTranslation();
  const asrModel = selectedLocalAsr();
  const download = status?.download || null;
  const activeDownload =
    download && download.modelId === settings.localTranslationModel
      ? download
      : null;
  const jobRunning = job?.state === "starting" || job?.state === "stopping";
  // The local llama.cpp server is only unnecessary when the extension really
  // translates with its own provider. Without an API key the local model is the
  // fallback that still produces Chinese, so it stays part of the start.
  const apiKeyConfigured = Boolean(
    settings.translationApiKeyConfigured?.[settings.translationProvider]
  );
  const usesApiTranslation =
    settings.translationMode === "api" && apiKeyConfigured;

  let badgeLabel = "控制服务未连接";
  let badgeClass = "warning";
  if (local.serviceOnline) {
    if (job?.state === "starting") {
      badgeLabel = "启动中";
      badgeClass = "warning";
    } else if (job?.state === "error") {
      badgeLabel = "启动失败";
      badgeClass = "warning";
    } else if (
      services?.asr?.online &&
      (usesApiTranslation || services?.translation?.online)
    ) {
      badgeLabel = usesApiTranslation ? "ASR 在线" : "全部在线";
      badgeClass = "online";
    } else {
      badgeLabel = "控制服务已连接";
      badgeClass = "";
    }
  }
  elements.localServiceBadge.textContent = badgeLabel;
  elements.localServiceBadge.className = `local-badge ${badgeClass}`.trim();

  const asrOnline = Boolean(services?.asr?.online);
  elements.localAsrState.textContent = asrOnline
    ? `在线 · ${services.asr.port}`
    : jobRunning
      ? "启动中…"
      : "未连接";
  elements.localAsrState.className = `local-state ${
    asrOnline ? "online" : jobRunning ? "" : "warning"
  }`.trim();

  const translationOnline = Boolean(services?.translation?.online);
  if (usesApiTranslation) {
    elements.localTranslationState.textContent = "由 API 翻译，不启动本地模型";
    elements.localTranslationState.className = "local-state";
  } else {
    elements.localTranslationState.textContent = translationOnline
      ? `在线 · ${services.translation.model || "已就绪"}`
      : jobRunning
        ? "启动中…"
        : "未连接";
    elements.localTranslationState.className = `local-state ${
      translationOnline ? "online" : jobRunning ? "" : "warning"
    }`.trim();
  }

  syncModelSelects();

  let hint = "";
  if (!local.serviceOnline) {
    hint = "启动本地控制服务后，可以在这里一键拉起 ASR 与本地翻译模型。";
  } else if (usesApiTranslation) {
    hint = "API 翻译模式只需本地 ASR：启动后不占用显存跑翻译模型，显存与算力全部留给识别。";
    if (asrModel) {
      hint += asrModel.cached
        ? `；ASR ${asrModel.label} 已缓存`
        : `；ASR ${asrModel.label} 首次启动会自动下载（${asrModel.sizeLabel}）`;
    }
  } else if (translationModel) {
    hint = translationModel.exists
      ? `翻译模型已就绪：${formatBytes(translationModel.bytes)}`
      : `翻译模型未下载：${translationModel.file}`;
    if (asrModel) {
      hint += asrModel.cached
        ? `；ASR ${asrModel.label} 已缓存`
        : `；ASR ${asrModel.label} 首次启动会自动下载（${asrModel.sizeLabel}）`;
    }
    const runningModel = services?.translation?.online
      ? services.translation.model
      : "";
    if (runningModel && runningModel !== translationModel.alias) {
      hint += `；当前运行 ${runningModel}，点“一键启动”会切换到所选模型`;
    }
    if (settings.translationMode === "api") {
      hint += "；API Key 未配置，本地模型将作为兜底翻译";
    }
  }
  elements.localModelHint.textContent = hint;

  const needsDownload = Boolean(
    local.serviceOnline &&
      !usesApiTranslation &&
      translationModel &&
      !translationModel.exists
  );
  elements.localMissingBox.hidden = !needsDownload;
  if (needsDownload) {
    elements.localMissingText.textContent =
      `本地未找到 ${translationModel.file}（${translationModel.note}）。` +
      "可以点“下载模型”由本地服务代下，或从下载页手动获取后放到 " +
      `${translationModel.path}`;
    elements.localDownloadPage.href = translationModel.pageUrl;
    elements.localDownloadButton.textContent = `下载 ${formatBytes(
      translationModel.bytes
    )}`;
    elements.localDownloadButton.disabled =
      local.busy || activeDownload?.state === "downloading";
  }

  // Progress is only meaningful while a download is running or after it
  // failed. A stale "done" snapshot must not hide a deleted model file.
  const downloading = activeDownload?.state === "downloading";
  const downloadError =
    activeDownload?.state === "error" && !translationModel?.exists;
  if (downloading) {
    const total = activeDownload.totalBytes || 0;
    const ratio =
      total > 0
        ? Math.min(1, activeDownload.receivedBytes / total)
        : 0;
    elements.localProgress.hidden = false;
    elements.localProgressBar.style.width = `${(ratio * 100).toFixed(1)}%`;
    elements.localProgressText.hidden = false;
    elements.localProgressText.textContent = `${formatBytes(
      activeDownload.receivedBytes
    )} / ${total > 0 ? formatBytes(total) : "未知大小"}（${Math.round(
      ratio * 100
    )}%）`;
  } else {
    elements.localProgress.hidden = true;
    elements.localProgressBar.style.width = "0";
    elements.localProgressText.hidden = !downloadError;
    if (downloadError) {
      elements.localProgressText.textContent = `下载失败：${activeDownload.error}`;
    }
  }

  let message = local.notice;
  if (message && Date.now() - local.noticeAt > LOCAL_NOTICE_TTL_MS) {
    local.notice = "";
    message = "";
  }
  if (!message && job?.message) {
    message = job.message;
    if (job.state === "starting" && job.startedAt) {
      message += `（${Math.round((Date.now() - job.startedAt) / 1000)} 秒）`;
    }
    if (job.state === "error") message = `启动失败：${job.message}`;
  }
  elements.localJobMessage.textContent = message;
  elements.localJobMessage.hidden = !message;

  elements.localStartButton.disabled =
    !local.serviceOnline ||
    local.busy ||
    jobRunning ||
    downloading ||
    (!usesApiTranslation && !translationModel?.exists) ||
    !asrModel;
  const anyServiceOnline = Boolean(
    services?.asr?.online || services?.translation?.online
  );
  elements.localStopButton.disabled =
    !local.serviceOnline ||
    local.busy ||
    job?.state === "stopping" ||
    downloading ||
    (!anyServiceOnline && job?.state !== "starting");

  elements.localServiceOffline.hidden = local.serviceOnline;
  elements.localServiceCommand.textContent = LOCAL_SERVICE_COMMAND;
  elements.startControlService.hidden = !IS_WINDOWS;
  elements.startControlService.disabled = local.busy;
}

/**
 * Starts the control service through the native host, so Windows users never
 * open a terminal. The permission is optional and asked for here, on the
 * click, so nobody else sees a native-messaging warning at install.
 */
async function startControlServiceNatively() {
  local.busy = true;
  setLocalNotice("正在启动本地控制服务…");
  renderLocal();
  try {
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    if (!granted) throw new Error("需要允许扩展与本机程序通信，才能从这里启动本地服务");
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: "start-control-service"
    });
    if (!response?.ok) throw new Error(response?.error || "本地控制服务没有启动");
    setLocalNotice("本地控制服务已启动");
  } catch (error) {
    const message = error?.message || String(error);
    setLocalNotice(
      /not found|forbidden/i.test(message)
        ? "还没装本地助手：在项目目录双击 install-windows.cmd（只需一次），然后再点这里"
        : `启动失败：${message}`
    );
  } finally {
    local.busy = false;
  }
  await pollLocal();
  renderLocal();
}

let localPolling = false;

async function pollLocal() {
  // The local control service only matters to the WhisperLiveKit backend.
  if (localPolling || settings.asrBackend !== "wlk") return;
  localPolling = true;
  try {
    const modelsPayload = await localRequest("/models", { timeoutMs: 2500 });
    local.models = modelsPayload.models;
    local.serviceOnline = true;
    local.status = await localRequest("/status", { timeoutMs: 5000 });
  } catch {
    local.serviceOnline = false;
    local.models = null;
    local.status = null;
  } finally {
    localPolling = false;
  }
  renderLocal();
}

async function startLocalServices() {
  if (local.busy) return;
  local.busy = true;
  setLocalNotice("");
  renderLocal();
  try {
    await savePatch(collectGlossaryPatchFromInputs());
    const apiKeyConfigured = Boolean(
      settings.translationApiKeyConfigured?.[settings.translationProvider]
    );
    const effectiveGlossary = resolveEffectiveGlossary(settings);
    const wlkGlossary = effectiveGlossary.enabled
      ? serializeWlkGlossary(effectiveGlossary.entries)
      : "";
    const payload = await localRequest("/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        translationModel: settings.localTranslationModel,
        asrModel: settings.localAsrModel,
        translationMode: settings.translationMode,
        apiTranslationConfigured: apiKeyConfigured,
        glossary: wlkGlossary
      }),
      timeoutMs: 15000
    });
    local.status = { ...(local.status || {}), job: payload.job };
    setLocalNotice(payload.job?.message || "已开始启动本地服务");
  } catch (error) {
    setLocalNotice(`启动失败：${error.message}`);
  } finally {
    local.busy = false;
    await pollLocal();
  }
}

async function stopLocalServices() {
  if (local.busy) return;
  local.busy = true;
  setLocalNotice("");
  renderLocal();
  try {
    await localRequest("/stop", { method: "POST", timeoutMs: 20000 });
    setLocalNotice("已停止本地服务");
  } catch (error) {
    setLocalNotice(`停止失败：${error.message}`);
  } finally {
    local.busy = false;
    await pollLocal();
  }
}

async function downloadLocalModel() {
  if (local.busy) return;
  local.busy = true;
  setLocalNotice("");
  renderLocal();
  try {
    await localRequest("/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ translationModel: settings.localTranslationModel }),
      timeoutMs: 20000
    });
    setLocalNotice("已开始下载模型");
  } catch (error) {
    setLocalNotice(`下载失败：${error.message}`);
  } finally {
    local.busy = false;
    await pollLocal();
  }
}

async function copyLocalServiceCommand() {
  try {
    await navigator.clipboard.writeText(LOCAL_SERVICE_COMMAND);
    setLocalNotice("启动命令已复制");
  } catch (error) {
    setLocalNotice(`复制失败：${error.message}`);
  }
  renderLocal();
}

async function refresh() {
  const [tabs, response] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.runtime.sendMessage({ target: "background", type: "get-state" })
  ]);
  activeTab = tabs[0] || null;
  runtimeState = response?.state || null;
  captions.seed(runtimeState?.current);
  settings = normalizeSettings(response?.settings || DEFAULT_SETTINGS);
  render();
}

async function savePatch(patch) {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "save-settings",
    settings: patch
  });
  if (!response?.ok) throw new Error(response?.error || "保存设置失败");
  settings = normalizeSettings(response.settings);
  render();
}

async function startCapture() {
  setError();
  if (!activeTab?.id) throw new Error("没有找到当前标签页");
  if (!/^https?:/i.test(activeTab.url || "")) {
    throw new Error("此页面不支持标签页音频采集，请打开直播或视频网页");
  }
  // Persist visible translation and glossary fields before starting: a click
  // blurs the active input, and an asynchronous change/debounce handler may
  // otherwise lose the race with start-capture.
  const patch = {
    wsUrl: normalizeWsUrl(elements.wsUrl.value),
    translationMode: elements.translationMode.value,
    translationTranslatePartial: elements.translationTranslatePartial.checked,
    ...collectGlossaryPatchFromInputs()
  };
  if (settings.asrBackend !== "wlk") delete patch.translationMode;
  const provider = elements.translationProvider.value;
  const remote = !TRANSLATION_PROVIDERS[provider]?.builtin;
  if ((patch.translationMode ?? settings.translationMode) === "api" && remote) {
    patch.translationProvider = provider;
    if (provider !== "bailian") {
      const baseUrl = normalizeTranslationBaseUrl(elements.translationBaseUrl.value);
      if (!baseUrl) throw new Error("请填写翻译 API 地址");
      patch.translationBaseUrl = baseUrl;
    }
    patch.translationModel = elements.translationModel.value.trim();
    if (!patch.translationModel) throw new Error("请填写翻译模型");
    const apiKey = elements.translationApiKey.value.trim();
    if (apiKey) patch.translationApiKeys = { [provider]: apiKey };
  }
  const bailianKey = elements.bailianApiKey.value.trim();
  if (bailianKey) {
    patch.translationApiKeys = { ...patch.translationApiKeys, bailian: bailianKey };
  }
  await ensureBuiltinTranslator();
  await savePatch(patch);
  elements.translationApiKey.value = "";
  elements.bailianApiKey.value = "";
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: activeTab.id
  });
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "start-capture",
    streamId,
    targetTabId: activeTab.id,
    tabTitle: activeTab.title || "未命名直播",
    tabUrl: activeTab.url || "",
    wsUrl: settings.wsUrl
  });
  if (!response?.ok) throw new Error(response?.error || "采集启动失败");
  if (response.warning) {
    setError(response.warning);
    return;
  }
  setTimeout(() => window.close(), 280);
}

async function stopCapture() {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "stop-capture"
  });
  if (!response?.ok) throw new Error(response?.error || "停止失败");
  await refresh();
}

elements.primaryButton.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  render();
  try {
    if (runtimeState?.active) {
      await stopCapture();
    } else {
      await startCapture();
    }
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    busy = false;
    render();
  }
});

elements.displayMode.addEventListener("change", () => {
  void savePatch({ displayMode: elements.displayMode.value }).catch((error) =>
    setError(error.message)
  );
});

elements.fontSize.addEventListener("input", () => {
  const value = Number(elements.fontSize.value);
  elements.fontSizeValue.value = String(value);
  fontSlider.push(value);
});

elements.opacity.addEventListener("input", () => {
  const percent = Number(elements.opacity.value);
  elements.opacityValue.value = `${percent}%`;
  opacitySlider.push(percent / 100);
});

elements.overlayEnabled.addEventListener("change", () => {
  void savePatch({ overlayEnabled: elements.overlayEnabled.checked }).catch(
    (error) => setError(error.message)
  );
});

elements.overlayRetry.addEventListener("click", async () => {
  elements.overlayRetry.disabled = true;
  setError();
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "refresh-overlay"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "重新注入失败，请查看扩展 Service Worker 的控制台");
    }
  } catch (error) {
    setError(error?.message || String(error));
  } finally {
    elements.overlayRetry.disabled = false;
    await refresh();
  }
});

elements.openPanelOnStart.addEventListener("change", () => {
  void savePatch({ openPanelOnStart: elements.openPanelOnStart.checked }).catch(
    (error) => setError(error.message)
  );
});

elements.wsUrl.addEventListener("change", () => {
  try {
    elements.wsUrl.value = normalizeWsUrl(elements.wsUrl.value);
    void savePatch({ wsUrl: elements.wsUrl.value }).catch((error) =>
      setError(error.message)
    );
  } catch (error) {
    setError(error.message);
  }
});

elements.translationMode.addEventListener("change", () => {
  const next = elements.translationMode.value;
  void savePatch({ translationMode: next })
    .then(() => {
      // WhisperLiveKit only reads its translation arguments at startup, so a
      // running session keeps the old engine until the capture restarts.
      if (runtimeState?.active) {
        setError(
          next === "api"
            ? "已切到 API 翻译：请停止并重新开始字幕，ASR 才会按新模式（不加载本地翻译模型）运行"
            : "已切到本地服务端翻译：请停止并重新开始字幕，ASR 才会恢复本地翻译"
        );
      }
    })
    .catch((error) => setError(error.message));
});

elements.asrBackend.addEventListener("change", () => {
  void savePatch({ asrBackend: elements.asrBackend.value })
    .then(() => {
      if (runtimeState?.active) setError("识别引擎将在下次开始字幕时生效");
      return pollLocal();
    })
    .catch((error) => setError(error.message));
});

elements.bailianRegion.addEventListener("change", () => {
  void savePatch({ bailianRegion: elements.bailianRegion.value }).catch((error) =>
    setError(error.message)
  );
});

elements.bailianApiKey.addEventListener("change", () => {
  const apiKey = elements.bailianApiKey.value.trim();
  if (!apiKey) return;
  void savePatch({ translationApiKeys: { bailian: apiKey } })
    .then(() => {
      elements.bailianApiKey.value = "";
    })
    .catch((error) => setError(error.message));
});

elements.switchToDeepseek.addEventListener("click", () => {
  elements.translationProvider.value = "deepseek";
  elements.translationProvider.dispatchEvent(new Event("change"));
});

elements.translationProvider.addEventListener("change", () => {
  const preset =
    TRANSLATION_PROVIDERS[elements.translationProvider.value] ||
    TRANSLATION_PROVIDERS.deepseek;
  elements.translationApiKey.value = "";
  elements.translationTestResult.hidden = true;
  void savePatch({
    translationProvider: preset.id,
    translationBaseUrl: preset.baseUrl,
    translationModel: preset.model
  }).catch((error) => setError(error.message));
});

elements.translationBaseUrl.addEventListener("change", () => {
  try {
    const url = normalizeTranslationBaseUrl(elements.translationBaseUrl.value);
    if (!url) throw new Error("请填写翻译 API 地址");
    elements.translationBaseUrl.value = url;
    void savePatch({ translationBaseUrl: url }).catch((error) =>
      setError(error.message)
    );
  } catch (error) {
    setError(error.message);
  }
});

elements.translationModel.addEventListener("change", () => {
  const model = elements.translationModel.value.trim();
  void savePatch({ translationModel: model }).catch((error) =>
    setError(error.message)
  );
});

elements.translationApiKey.addEventListener("change", () => {
  const apiKey = elements.translationApiKey.value.trim();
  if (!apiKey) return;
  void savePatch({
    translationApiKeys: { [elements.translationProvider.value]: apiKey }
  })
    .then(() => {
      elements.translationApiKey.value = "";
      elements.translationTestResult.hidden = true;
    })
    .catch((error) => setError(error.message));
});

elements.clearTranslationKey.addEventListener("click", () => {
  void savePatch({
    translationApiKeys: { [elements.translationProvider.value]: "" }
  })
    .then(() => {
      elements.translationTestResult.hidden = true;
    })
    .catch((error) => setError(error.message));
});

elements.translationTranslatePartial.addEventListener("change", () => {
  void savePatch({
    translationTranslatePartial: elements.translationTranslatePartial.checked
  }).catch((error) => setError(error.message));
});

elements.testTranslationButton.addEventListener("click", async () => {
  elements.testTranslationButton.disabled = true;
  elements.translationTestResult.hidden = false;
  elements.translationTestResult.textContent = "正在请求翻译...";
  setError();
  try {
    const provider = elements.translationProvider.value;
    const preset = TRANSLATION_PROVIDERS[provider];
    const patch = {
      translationMode: elements.translationMode.value,
      translationProvider: provider,
      ...collectGlossaryPatchFromInputs()
    };
    if (preset?.builtin) {
      await ensureBuiltinTranslator();
    } else {
      if (provider !== "bailian") {
        const baseUrl = normalizeTranslationBaseUrl(elements.translationBaseUrl.value);
        if (!baseUrl) throw new Error("请填写翻译 API 地址");
        patch.translationBaseUrl = baseUrl;
      }
      patch.translationModel = elements.translationModel.value.trim();
      if (!patch.translationModel) throw new Error("请填写翻译模型");
    }
    const pendingKey = elements.translationApiKey.value.trim();
    if (pendingKey) {
      patch.translationApiKeys = { [provider]: pendingKey };
    }
    await savePatch(patch);
    elements.translationApiKey.value = "";
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "test-translation-api"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "翻译 API 测试失败");
    }
    const result = response.result;
    elements.translationTestResult.textContent =
      `连接成功：${result.model} · ${result.latencyMs} ms · ${result.translation}`;
  } catch (error) {
    elements.translationTestResult.textContent = `失败：${
      error?.message || String(error)
    }`;
  } finally {
    elements.testTranslationButton.disabled = false;
  }
});

elements.probeButton.addEventListener("click", async () => {
  elements.probeButton.disabled = true;
  elements.serviceResults.hidden = false;
  elements.serviceResults.textContent = "正在检查...";
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "probe-services"
    });
    if (!response?.ok) throw new Error(response?.error || "检查失败");
    const labels = { asr: "ASR", translation: "翻译" };
    elements.serviceResults.replaceChildren(
      ...response.services.map((service) => {
        const row = document.createElement("span");
        const name = document.createElement("b");
        name.textContent = labels[service.key] || service.key;
        const state = document.createElement("span");
        state.className = service.ok ? "ok" : "failed";
        state.textContent = service.detail;
        row.append(name, state);
        return row;
      })
    );
  } catch (error) {
    elements.serviceResults.textContent = error.message;
  } finally {
    elements.probeButton.disabled = false;
  }
});

function openMonitor() {
  void chrome.runtime.sendMessage({ target: "background", type: "open-monitor" });
}

elements.openMonitor.addEventListener("click", openMonitor);
elements.openMonitorFooter.addEventListener("click", openMonitor);

elements.localTranslationModel.addEventListener("change", () => {
  if (!elements.localTranslationModel.value) return;
  void savePatch({
    localTranslationModel: elements.localTranslationModel.value
  })
    .then(() => renderLocal())
    .catch((error) => setError(error.message));
});

elements.localAsrModel.addEventListener("change", () => {
  if (!elements.localAsrModel.value) return;
  void savePatch({ localAsrModel: elements.localAsrModel.value })
    .then(() => renderLocal())
    .catch((error) => setError(error.message));
});

elements.localStartButton.addEventListener("click", () => {
  void startLocalServices();
});

elements.localStopButton.addEventListener("click", () => {
  void stopLocalServices();
});

elements.localDownloadButton.addEventListener("click", () => {
  void downloadLocalModel();
});

elements.copyLocalServiceCommand.addEventListener("click", () => {
  void copyLocalServiceCommand();
});

elements.startControlService.addEventListener("click", () => {
  void startControlServiceNatively();
});

elements.retryLocalService.addEventListener("click", () => {
  setLocalNotice("正在重新检测本地控制服务…");
  void pollLocal();
});

function notifyGlossaryRuntimeEffect() {
  if (
    settings.translationMode === "server" &&
    local.serviceOnline &&
    local.status?.services?.asr?.online
  ) {
    setGlossaryActionHint(
      "本地服务端翻译需点上方“一键启动”重载术语表；ASR 热词在下次开始字幕时生效"
    );
    return;
  }
  if (runtimeState?.active) {
    setGlossaryActionHint(
      "API 翻译已实时应用新术语；ASR 识别热词将在下次开始字幕时生效"
    );
    return;
  }
  setGlossaryActionHint("");
}

elements.glossaryEnabled.addEventListener("change", () => {
  void savePatch({ glossaryEnabled: elements.glossaryEnabled.checked })
    .then(() => notifyGlossaryRuntimeEffect())
    .catch((error) => setError(error.message));
});

elements.glossaryPresetPoe.addEventListener("change", () => {
  const presetIds = elements.glossaryPresetPoe.checked ? ["poe"] : [];
  void savePatch({ glossaryPresetIds: presetIds })
    .then(() => notifyGlossaryRuntimeEffect())
    .catch((error) => setError(error.message));
});

elements.glossaryDomainHint.addEventListener("input", () => {
  const value = elements.glossaryDomainHint.value.trim();
  updateGlossarySummaryText({
    ...settings,
    ...collectGlossaryPatchFromInputs()
  });
  domainHintSaver.push(value);
});

elements.glossaryDomainHint.addEventListener("change", () => {
  void savePatch({
    glossaryDomainHint: elements.glossaryDomainHint.value.trim()
  })
    .then(() => notifyGlossaryRuntimeEffect())
    .catch((error) => setError(error.message));
});

elements.customGlossary.addEventListener("input", () => {
  const value = elements.customGlossary.value.slice(
    0,
    MAX_CUSTOM_GLOSSARY_CHARS
  );
  updateGlossarySummaryText({
    ...settings,
    ...collectGlossaryPatchFromInputs()
  });
  customGlossarySaver.push(value);
});

elements.customGlossary.addEventListener("change", () => {
  const value = elements.customGlossary.value.slice(
    0,
    MAX_CUSTOM_GLOSSARY_CHARS
  );
  void savePatch({ customGlossary: value })
    .then(() => notifyGlossaryRuntimeEffect())
    .catch((error) => setError(error.message));
});

elements.importGlossaryButton.addEventListener("click", () => {
  elements.importGlossaryInput.value = "";
  elements.importGlossaryInput.click();
});

elements.importGlossaryInput.addEventListener("change", async () => {
  const file = elements.importGlossaryInput.files?.[0];
  if (!file) return;
  setError();
  try {
    if (file.size > 512 * 1024) {
      throw new Error("术语文件过大（超过 512 KB），请精简后再导入");
    }
    const rawText = await file.text();
    const imported = parseGlossaryText(rawText);
    if (imported.length === 0) {
      throw new Error(
        "未在文件中识别到有效术语（格式：英文 -> 中文 或 CSV source,target）"
      );
    }
    const merged = collectGlossaryEntries({
      presetIds: [],
      customText: `${elements.customGlossary.value || ""}\n${rawText}`
    });
    // 32 KB is a hard storage cap, so truncation must happen on whole entries and
    // be reported: slicing the serialised text would cut a term in half and still
    // claim every imported row was kept.
    const fullText = exportGlossaryText(merged, "text");
    let nextText = fullText;
    let dropped = 0;
    if (fullText.length > MAX_CUSTOM_GLOSSARY_CHARS) {
      const keptLines = [];
      let used = 0;
      for (const line of fullText.split("\n")) {
        const addition = line.length + (keptLines.length > 0 ? 1 : 0);
        if (used + addition > MAX_CUSTOM_GLOSSARY_CHARS) break;
        keptLines.push(line);
        used += addition;
      }
      if (keptLines.length === 0) {
        throw new Error(
          "自定义术语已达 32 KB 上限，无法再导入，请先精简现有词条后重试"
        );
      }
      nextText = keptLines.join("\n");
      dropped = merged.length - keptLines.length;
    }
    elements.customGlossary.value = nextText;
    await savePatch({ customGlossary: nextText });
    setGlossaryActionHint(
      dropped > 0
        ? `已从 ${file.name} 识别 ${imported.length} 条；受 32 KB 上限限制仅保留前 ${nextText.split("\n").length} 条（丢弃 ${dropped} 条，原有词条优先）`
        : `已从 ${file.name} 导入 ${imported.length} 条，自定义术语共 ${merged.length} 条`
    );
  } catch (error) {
    setError(error?.message || String(error));
  }
});

function downloadGlossaryFile(format) {
  const draft = {
    ...settings,
    ...collectGlossaryPatchFromInputs()
  };
  const effective = resolveEffectiveGlossary(draft);
  const entries =
    effective.entries.length > 0
      ? effective.entries
      : parseGlossaryText(draft.customGlossary);
  if (entries.length === 0) {
    setError("当前没有可导出的术语词条");
    return;
  }
  const isCsv = format === "csv";
  const body = isCsv
    ? `source,target\n${exportGlossaryText(entries, "csv")}\n`
    : `${exportGlossaryText(entries, "text")}\n`;
  const blob = new Blob([body], {
    type: isCsv ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = isCsv ? "shengmu-glossary.csv" : "shengmu-glossary.txt";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setGlossaryActionHint(
    `已导出 ${entries.length} 条术语（${isCsv ? "CSV" : "TXT"}）`
  );
}

elements.exportGlossaryTextButton.addEventListener("click", () => {
  downloadGlossaryFile("text");
});

elements.exportGlossaryCsvButton.addEventListener("click", () => {
  downloadGlossaryFile("csv");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "extension-view") return;
  captions.apply(message.caption);
  // Broadcast state carries no caption rows; they arrive as caption deltas.
  if (message.state) {
    runtimeState = { ...message.state, current: captions.current ?? runtimeState?.current };
  }
  if (message.settings) settings = normalizeSettings(message.settings);
  if (["session-state", "status", "caption-state", "session-ended"].includes(message.type)) {
    render();
  }
});

window.addEventListener("unhandledrejection", (event) => {
  setError(event.reason?.message || String(event.reason));
});

void refresh()
  .then(() => Promise.all([pollLocal(), checkBuiltinSupport()]))
  .catch((error) => setError(error.message));
localPollTimer = setInterval(() => {
  void pollLocal();
}, LOCAL_POLL_MS);
window.addEventListener("unload", () => {
  if (localPollTimer) clearInterval(localPollTimer);
});
