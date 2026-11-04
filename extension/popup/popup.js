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
  normalizeTranslationBaseUrl,
  translatesInExtension,
  usesManagedTranslator
} from "../lib/translation-api.js";
import { createCaptionReceiver } from "../lib/caption-delta.js";
import { errorText, localizePage, renderMessage, t } from "../ui/i18n.js";
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
  builtinSupportText: document.querySelector("#builtinSupportText"),
  switchToBailian: document.querySelector("#switchToBailian"),
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
        .catch((error) => setError(errorText(error)))
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
    ...DISPLAY_MODE_ORDER.map((mode) => new Option(t(DISPLAY_MODE_LABELS[mode]), mode))
  );
}

populateDisplayModes();

function render() {
  const displayTab = runtimeState?.active
    ? { title: runtimeState.tabTitle, url: runtimeState.tabUrl }
    : activeTab;
  elements.tabTitle.textContent = displayTab?.title || t("popup_no_tab");
  elements.tabUrl.textContent = displayTab?.url
    ? hostnameFromUrl(displayTab.url) || displayTab.url
    : t("popup_open_stream_first");

  const presentation = capturePresentation(runtimeState, t);
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
  elements.primaryLabel.textContent = active ? t("popup_stop") : t("popup_start");
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
    ? t("popup_overlay_failed", failure)
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
    ? t("popup_bailian_key_saved")
    : t("popup_bailian_key_hint");
  // Name the half that is missing: Edge, for one, has the built-in
  // Translator but no on-device speech model. Bailian is then the only
  // speech engine that needs no install, so the hint offers it directly.
  const speechUnsupported = ["missing", "unavailable"].includes(builtinSupport.speech);
  const chromeOption = elements.asrBackend.querySelector('option[value="chrome"]');
  chromeOption.textContent = t(speechUnsupported ? "asr_backend_chrome_unavailable" : "asr_backend_chrome");
  chromeOption.disabled = speechUnsupported && backend !== "chrome";
  const hints = [];
  if (backend === "chrome" && speechUnsupported) {
    hints.push(t("popup_speech_unsupported"));
  }
  elements.switchToBailian.hidden = !(backend === "chrome" && speechUnsupported);
  if (
    settings.translationProvider === "chrome" &&
    settings.translationMode === "api" &&
    ["missing", "unavailable"].includes(builtinSupport.translator)
  ) {
    hints.push(t("popup_translator_unsupported"));
  }
  elements.builtinSupportHint.hidden = hints.length === 0;
  elements.builtinSupportText.textContent = hints.join(" ");
}

/**
 * Chrome downloads its speech model only from a user gesture, like the
 * translation model; the offscreen page waits for it. About 20 s, once.
 */
async function ensureBuiltinSpeech() {
  if (settings.asrBackend !== "chrome") return;
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Recognition?.install) return;
  const availability = await Recognition.available(BUILTIN_SPEECH);
  if (availability !== "downloadable" && availability !== "downloading") return;
  elements.statusLabel.textContent = t("popup_downloading_speech");
  if (!(await Recognition.install(BUILTIN_SPEECH))) {
    throw new Error(t("speech_download_failed"));
  }
  builtinSupport.speech = "available";
}

/**
 * Starts both model downloads at once, so both begin while the click still
 * counts as a user gesture (transient activation lasts a few seconds).
 */
async function ensureBuiltinModels() {
  await Promise.all([ensureBuiltinSpeech(), ensureBuiltinTranslator()]);
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
  elements.statusLabel.textContent = t("popup_downloading_translator");
  const translator = await globalThis.Translator.create({
    ...BUILTIN_LANGUAGES,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        elements.statusLabel.textContent = t("popup_downloading_translator_progress", Math.round(event.loaded * 100));
      });
    }
  });
  translator.destroy();
  builtinSupport.translator = "available";
}

/**
 * The model to persist for a provider: none for a protocol that has no model
 * (DeepL), the preset's own id when it is fixed (DeepSeek), otherwise the form.
 * @param {any} preset
 * @param {string} typed
 */
function modelForPreset(preset, typed) {
  if (preset?.requiresModel === false) return "";
  if (preset?.fixedModel) return preset.model;
  return String(typed || "").trim();
}

function renderTranslationSettings() {
  const providerId = settings.translationProvider;
  const provider = TRANSLATION_PROVIDERS[providerId];
  if (!provider) {
    // A provider id that no longer exists must fail loudly instead of quietly
    // rewriting the settings to DeepSeek behind the user's back.
    elements.translationProvider.value = "";
    elements.translationProvider.disabled = true;
    elements.translationModel.disabled = true;
    elements.translationUsage.textContent = t("popup_provider_unknown", providerId);
    return;
  }
  elements.translationProvider.disabled = false;
  const configured = Boolean(
    settings.translationApiKeyConfigured?.[provider.id]
  );
  const builtin = Boolean(provider.builtin);
  const providerLabel = t(`provider_${provider.id}`);
  elements.remoteTranslationFields.hidden = builtin;
  elements.translationBaseUrlField.hidden = provider.id === "bailian";
  // One Bailian key serves both halves; the speech section already asks for it.
  elements.translationKeyField.hidden =
    provider.id === "bailian" && settings.asrBackend === "bailian";
  elements.translationNudge.hidden = !builtin;
  elements.testTranslationButton.textContent = builtin ? t("popup_test_builtin") : t("popup_test_api");
  elements.translationMode.value = settings.translationMode;
  elements.translationProvider.value = provider.id;
  setFieldValue(elements.translationBaseUrl, settings.translationBaseUrl);
  setFieldValue(elements.translationModel, settings.translationModel);
  // DeepL picks its own engine and DeepSeek ships a single flash id: typing a
  // model there could only put a value back that the resolver ignores.
  elements.translationModel.disabled =
    provider.requiresModel === false || Boolean(provider.fixedModel);
  elements.apiTranslationFields.hidden = settings.translationMode !== "api";
  elements.translationKeyHint.textContent = configured
    ? t("popup_key_saved", providerLabel)
    : provider.id === "deepl"
      ? `${t("popup_key_required", providerLabel)} ${t("popup_deepl_key_hint")}`
      : provider.requiresApiKey
        ? t("popup_key_required", providerLabel)
        : t("popup_key_optional");
  elements.clearTranslationKey.hidden = !configured;

  const translationState = runtimeState?.translation;
  const usage = translationState?.usage;
  let usageText;
  if (settings.translationMode === "server") {
    usageText = t("popup_usage_server");
  } else if (builtin) {
    usageText = providerLabel;
  } else if (usage?.requests > 0) {
    const billed = Number(usage.billedCharacters) || 0;
    if (billed > 0) {
      // DeepL bills characters and has no model name, so the token line and
      // the model label would both read as zero here.
      usageText = `${providerLabel} · ${t("popup_usage_characters", usage.requests, billed)}`;
    } else {
      const tokens =
        (Number(usage.promptTokens) || 0) +
        (Number(usage.completionTokens) || 0);
      usageText =
        `${providerLabel} · ${settings.translationModel} · ` +
        t("popup_usage_requests", usage.requests, tokens);
    }
  } else {
    usageText = `${providerLabel} · ${settings.translationModel || t("popup_no_model")}`;
  }
  if (translationState?.error) {
    usageText += ` · ${renderMessage(translationState.error).slice(0, 90)}`;
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
    summary = t("popup_glossary_active", effective.entries.length, effective.presetCount, effective.customCount);
    if (effective.domainHint) {
      summary += ` · ${t("popup_glossary_domain", effective.domainHint)}`;
    }
  } else {
    summary = t("popup_glossary_off", effective.presetCount, effective.customCount);
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
    : t("popup_domain_placeholder");
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

/** The control service's error: by code when it sent one, else its text. */
function localErrorText(payload) {
  if (payload?.errorCode) return t(payload.errorCode, ...(payload.errorParams || []));
  return payload?.error || "";
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
      localErrorText(payload) || t("popup_local_http_error", response.status)
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
    const fallback = local.serviceOnline ? t("popup_no_models") : t("popup_control_offline");
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

function extensionTranslates() {
  return translatesInExtension(
    settings,
    builtinSupport.translator,
    local.status?.services?.translation?.port
  );
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
  // translates with its own provider. Otherwise the local model is the fallback
  // that still produces Chinese, so it stays part of the start.
  const usesApiTranslation = extensionTranslates();

  let badgeLabel = t("popup_control_offline");
  let badgeClass = "warning";
  if (local.serviceOnline) {
    if (job?.state === "starting") {
      badgeLabel = t("popup_badge_starting");
      badgeClass = "warning";
    } else if (job?.state === "error") {
      badgeLabel = t("popup_badge_failed");
      badgeClass = "warning";
    } else if (
      services?.asr?.online &&
      (usesApiTranslation || services?.translation?.online)
    ) {
      badgeLabel = usesApiTranslation ? t("popup_badge_asr_online") : t("popup_badge_all_online");
      badgeClass = "online";
    } else {
      badgeLabel = t("popup_badge_connected");
      badgeClass = "";
    }
  }
  elements.localServiceBadge.textContent = badgeLabel;
  elements.localServiceBadge.className = `local-badge ${badgeClass}`.trim();

  const asrOnline = Boolean(services?.asr?.online);
  elements.localAsrState.textContent = asrOnline
    ? t("popup_online_at", services.asr.port)
    : jobRunning
      ? t("popup_starting_ellipsis")
      : t("local_not_connected");
  elements.localAsrState.className = `local-state ${
    asrOnline ? "online" : jobRunning ? "" : "warning"
  }`.trim();

  const translationOnline = Boolean(services?.translation?.online);
  if (usesApiTranslation) {
    elements.localTranslationState.textContent = t("popup_translation_by_api");
    elements.localTranslationState.className = "local-state";
  } else {
    elements.localTranslationState.textContent = translationOnline
      ? t("popup_online_at", services.translation.model || t("popup_ready"))
      : jobRunning
        ? t("popup_starting_ellipsis")
        : t("local_not_connected");
    elements.localTranslationState.className = `local-state ${
      translationOnline ? "online" : jobRunning ? "" : "warning"
    }`.trim();
  }

  syncModelSelects();

  const hints = [];
  const asrHint = () =>
    asrModel.cached
      ? t("popup_hint_asr_cached", asrModel.label)
      : t("popup_hint_asr_download", asrModel.label, renderMessage(asrModel.sizeNote || asrModel.sizeLabel));
  if (!local.serviceOnline) {
    hints.push(t("popup_hint_service_offline"));
  } else if (usesApiTranslation) {
    hints.push(t("popup_hint_api_mode"));
    if (asrModel) hints.push(asrHint());
  } else if (translationModel) {
    hints.push(
      translationModel.exists
        ? t("popup_hint_model_ready", formatBytes(translationModel.bytes))
        : t("popup_hint_model_missing", translationModel.file)
    );
    if (asrModel) hints.push(asrHint());
    const runningModel = services?.translation?.online
      ? services.translation.model
      : "";
    if (runningModel && runningModel !== translationModel.alias) {
      hints.push(t("popup_hint_model_switch", runningModel));
    }
    if (
      settings.translationMode === "api" &&
      !usesManagedTranslator(settings, services?.translation?.port)
    ) {
      hints.push(t("popup_hint_local_fallback"));
    }
  }
  elements.localModelHint.textContent = hints.join(t("hint_separator"));

  const needsDownload = Boolean(
    local.serviceOnline &&
      !usesApiTranslation &&
      translationModel &&
      !translationModel.exists
  );
  elements.localMissingBox.hidden = !needsDownload;
  if (needsDownload) {
    elements.localMissingText.textContent = t(
      "popup_model_missing",
      translationModel.file,
      renderMessage(translationModel.note),
      translationModel.path
    );
    elements.localDownloadPage.href = translationModel.pageUrl;
    elements.localDownloadButton.textContent = t("popup_download_size", formatBytes(translationModel.bytes));
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
    elements.localProgressText.textContent = t(
      "popup_download_progress",
      formatBytes(activeDownload.receivedBytes),
      total > 0 ? formatBytes(total) : t("popup_unknown_size"),
      Math.round(ratio * 100)
    );
  } else {
    elements.localProgress.hidden = true;
    elements.localProgressBar.style.width = "0";
    elements.localProgressText.hidden = !downloadError;
    if (downloadError) {
      elements.localProgressText.textContent = t("popup_download_failed", localErrorText(activeDownload));
    }
  }

  let message = local.notice;
  if (message && Date.now() - local.noticeAt > LOCAL_NOTICE_TTL_MS) {
    local.notice = "";
    message = "";
  }
  if (!message && job?.message) {
    const jobText = renderMessage(job.messageKey ? { key: job.messageKey, params: job.messageParams } : job.message);
    message = jobText;
    if (job.state === "starting" && job.startedAt) {
      message += t("popup_seconds_suffix", Math.round((Date.now() - job.startedAt) / 1000));
    }
    // Keyed job messages already say what failed (server_job_*_failed).
    if (job.state === "error" && !job.messageKey) message = t("popup_start_failed", jobText);
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
  setLocalNotice(t("popup_starting_control_service"));
  renderLocal();
  try {
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
    if (!granted) throw new Error(t("popup_native_permission_denied"));
    const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      type: "start-control-service"
    });
    if (!response?.ok) throw new Error(response?.error || t("popup_control_service_not_started"));
    setLocalNotice(t("popup_control_service_started"));
  } catch (error) {
    const message = errorText(error);
    setLocalNotice(
      /not found|forbidden/i.test(message)
        ? t("popup_native_host_missing")
        : t("popup_start_failed", message)
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
        apiTranslationConfigured: extensionTranslates(),
        glossary: wlkGlossary
      }),
      timeoutMs: 15000
    });
    local.status = { ...(local.status || {}), job: payload.job };
    setLocalNotice(
      payload.job?.messageKey
        ? t(payload.job.messageKey, ...(payload.job.messageParams || []))
        : payload.job?.message || t("popup_local_starting")
    );
  } catch (error) {
    setLocalNotice(t("popup_start_failed", errorText(error)));
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
    setLocalNotice(t("popup_local_stopped"));
  } catch (error) {
    setLocalNotice(t("popup_stop_failed", errorText(error)));
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
    setLocalNotice(t("popup_download_started"));
  } catch (error) {
    setLocalNotice(t("popup_download_failed", errorText(error)));
  } finally {
    local.busy = false;
    await pollLocal();
  }
}

async function copyLocalServiceCommand() {
  try {
    await navigator.clipboard.writeText(LOCAL_SERVICE_COMMAND);
    setLocalNotice(t("popup_command_copied"));
  } catch (error) {
    setLocalNotice(t("popup_copy_failed", errorText(error)));
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
  if (!response?.ok) throw new Error(response?.error || t("popup_save_failed"));
  settings = normalizeSettings(response.settings);
  render();
}

async function startCapture() {
  setError();
  if (!activeTab?.id) throw new Error(t("popup_tab_missing"));
  if (!/^https?:/i.test(activeTab.url || "")) {
    throw new Error(t("popup_tab_unsupported"));
  }
  // Persist visible translation and glossary fields before starting: a click
  // blurs the active input, and an asynchronous change/debounce handler may
  // otherwise lose the race with start-capture.
  const patch = {
    wsUrl: normalizeWsUrl(elements.wsUrl.value),
    translationMode: elements.translationMode.value,
    ...collectGlossaryPatchFromInputs()
  };
  if (settings.asrBackend !== "wlk") delete patch.translationMode;
  const provider = elements.translationProvider.value;
  const preset = TRANSLATION_PROVIDERS[provider];
  if (!preset) throw new Error(t("popup_provider_unknown", provider));
  const remote = !preset.builtin;
  if ((patch.translationMode ?? settings.translationMode) === "api" && remote) {
    patch.translationProvider = provider;
    if (provider !== "bailian") {
      const baseUrl = normalizeTranslationBaseUrl(elements.translationBaseUrl.value);
      if (!baseUrl) throw new Error(t("popup_base_url_required"));
      patch.translationBaseUrl = baseUrl;
    }
    patch.translationModel = modelForPreset(preset, elements.translationModel.value);
    if (preset.requiresModel !== false && !patch.translationModel) {
      throw new Error(t("popup_model_required"));
    }
    const apiKey = elements.translationApiKey.value.trim();
    if (apiKey) patch.translationApiKeys = { [provider]: apiKey };
  }
  const bailianKey = elements.bailianApiKey.value.trim();
  if (bailianKey) {
    patch.translationApiKeys = { ...patch.translationApiKeys, bailian: bailianKey };
  }
  await ensureBuiltinModels();
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
    tabTitle: activeTab.title || t("popup_untitled_stream"),
    tabUrl: activeTab.url || "",
    wsUrl: settings.wsUrl
  });
  if (!response?.ok) throw new Error(response?.error || t("popup_capture_failed"));
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
  if (!response?.ok) throw new Error(response?.error || t("popup_stop_capture_failed"));
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
    setError(errorText(error));
  } finally {
    busy = false;
    render();
  }
});

elements.displayMode.addEventListener("change", () => {
  void savePatch({ displayMode: elements.displayMode.value }).catch((error) =>
    setError(errorText(error))
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
    (error) => setError(errorText(error))
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
      throw new Error(response?.error || t("popup_reinject_failed"));
    }
  } catch (error) {
    setError(errorText(error));
  } finally {
    elements.overlayRetry.disabled = false;
    await refresh();
  }
});

elements.openPanelOnStart.addEventListener("change", () => {
  void savePatch({ openPanelOnStart: elements.openPanelOnStart.checked }).catch(
    (error) => setError(errorText(error))
  );
});

elements.wsUrl.addEventListener("change", () => {
  try {
    elements.wsUrl.value = normalizeWsUrl(elements.wsUrl.value);
    void savePatch({ wsUrl: elements.wsUrl.value }).catch((error) =>
      setError(errorText(error))
    );
  } catch (error) {
    setError(errorText(error));
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
            ? t("popup_switched_to_api")
            : t("popup_switched_to_server")
        );
      }
    })
    .catch((error) => setError(errorText(error)));
});

elements.asrBackend.addEventListener("change", () => {
  void savePatch({ asrBackend: elements.asrBackend.value })
    .then(() => {
      if (runtimeState?.active) setError(t("popup_backend_next_start"));
      return pollLocal();
    })
    .catch((error) => setError(errorText(error)));
});

elements.switchToBailian.addEventListener("click", () => {
  elements.asrBackend.value = "bailian";
  elements.asrBackend.dispatchEvent(new Event("change"));
  if (!settings.translationApiKeyConfigured?.bailian) elements.bailianApiKey.focus();
});

elements.bailianRegion.addEventListener("change", () => {
  void savePatch({ bailianRegion: elements.bailianRegion.value }).catch((error) =>
    setError(errorText(error))
  );
});

elements.bailianApiKey.addEventListener("change", () => {
  const apiKey = elements.bailianApiKey.value.trim();
  if (!apiKey) return;
  void savePatch({ translationApiKeys: { bailian: apiKey } })
    .then(() => {
      elements.bailianApiKey.value = "";
    })
    .catch((error) => setError(errorText(error)));
});

elements.switchToDeepseek.addEventListener("click", () => {
  elements.translationProvider.value = "deepseek";
  elements.translationProvider.dispatchEvent(new Event("change"));
});

elements.translationProvider.addEventListener("change", () => {
  const preset = TRANSLATION_PROVIDERS[elements.translationProvider.value];
  if (!preset) {
    setError(t("popup_provider_unknown", elements.translationProvider.value));
    return;
  }
  elements.translationApiKey.value = "";
  elements.translationTestResult.hidden = true;
  void savePatch({
    translationProvider: preset.id,
    translationBaseUrl: preset.baseUrl,
    translationModel: preset.model
  }).catch((error) => setError(errorText(error)));
});

elements.translationBaseUrl.addEventListener("change", () => {
  try {
    const url = normalizeTranslationBaseUrl(elements.translationBaseUrl.value);
    if (!url) throw new Error(t("popup_base_url_required"));
    elements.translationBaseUrl.value = url;
    void savePatch({ translationBaseUrl: url }).catch((error) =>
      setError(errorText(error))
    );
  } catch (error) {
    setError(errorText(error));
  }
});

elements.translationModel.addEventListener("change", () => {
  const model = elements.translationModel.value.trim();
  void savePatch({ translationModel: model }).catch((error) =>
    setError(errorText(error))
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
    .catch((error) => setError(errorText(error)));
});

elements.clearTranslationKey.addEventListener("click", () => {
  void savePatch({
    translationApiKeys: { [elements.translationProvider.value]: "" }
  })
    .then(() => {
      elements.translationTestResult.hidden = true;
    })
    .catch((error) => setError(errorText(error)));
});

elements.testTranslationButton.addEventListener("click", async () => {
  elements.testTranslationButton.disabled = true;
  elements.translationTestResult.hidden = false;
  elements.translationTestResult.textContent = t("popup_requesting_translation");
  setError();
  try {
    const provider = elements.translationProvider.value;
    const preset = TRANSLATION_PROVIDERS[provider];
    if (!preset) throw new Error(t("popup_provider_unknown", provider));
    const patch = {
      translationMode: elements.translationMode.value,
      translationProvider: provider,
      ...collectGlossaryPatchFromInputs()
    };
    if (preset.builtin) {
      await ensureBuiltinTranslator();
    } else {
      if (provider !== "bailian") {
        const baseUrl = normalizeTranslationBaseUrl(elements.translationBaseUrl.value);
        if (!baseUrl) throw new Error(t("popup_base_url_required"));
        patch.translationBaseUrl = baseUrl;
      }
      patch.translationModel = modelForPreset(preset, elements.translationModel.value);
      if (preset.requiresModel !== false && !patch.translationModel) {
        throw new Error(t("popup_model_required"));
      }
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
      throw new Error(response?.error || t("popup_test_failed"));
    }
    const result = response.result;
    elements.translationTestResult.textContent =
      t("popup_test_ok", result.model, result.latencyMs, result.translation);
  } catch (error) {
    elements.translationTestResult.textContent = t("popup_failed", errorText(error));
  } finally {
    elements.testTranslationButton.disabled = false;
  }
});

elements.probeButton.addEventListener("click", async () => {
  elements.probeButton.disabled = true;
  elements.serviceResults.hidden = false;
  elements.serviceResults.textContent = t("popup_checking_services");
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "probe-services"
    });
    if (!response?.ok) throw new Error(response?.error || t("popup_check_failed"));
    const labels = { asr: "ASR", translation: t("popup_translation") };
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
    elements.serviceResults.textContent = errorText(error);
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
    .catch((error) => setError(errorText(error)));
});

elements.localAsrModel.addEventListener("change", () => {
  if (!elements.localAsrModel.value) return;
  void savePatch({ localAsrModel: elements.localAsrModel.value })
    .then(() => renderLocal())
    .catch((error) => setError(errorText(error)));
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
  setLocalNotice(t("popup_rechecking"));
  void pollLocal();
});

function notifyGlossaryRuntimeEffect() {
  if (
    settings.translationMode === "server" &&
    local.serviceOnline &&
    local.status?.services?.asr?.online
  ) {
    setGlossaryActionHint(t("popup_glossary_reload_server"));
    return;
  }
  if (runtimeState?.active) {
    setGlossaryActionHint(t("popup_glossary_applied_api"));
    return;
  }
  setGlossaryActionHint("");
}

elements.glossaryEnabled.addEventListener("change", () => {
  void savePatch({ glossaryEnabled: elements.glossaryEnabled.checked })
    .then(() => notifyGlossaryRuntimeEffect())
    .catch((error) => setError(errorText(error)));
});

elements.glossaryPresetPoe.addEventListener("change", () => {
  const presetIds = elements.glossaryPresetPoe.checked ? ["poe"] : [];
  void savePatch({ glossaryPresetIds: presetIds })
    .then(() => notifyGlossaryRuntimeEffect())
    .catch((error) => setError(errorText(error)));
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
    .catch((error) => setError(errorText(error)));
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
    .catch((error) => setError(errorText(error)));
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
      throw new Error(t("popup_glossary_file_too_large"));
    }
    const rawText = await file.text();
    const imported = parseGlossaryText(rawText);
    if (imported.length === 0) {
      throw new Error(t("popup_glossary_file_empty"));
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
        throw new Error(t("popup_glossary_full"));
      }
      nextText = keptLines.join("\n");
      dropped = merged.length - keptLines.length;
    }
    elements.customGlossary.value = nextText;
    await savePatch({ customGlossary: nextText });
    setGlossaryActionHint(
      dropped > 0
        ? t("popup_glossary_imported_truncated", file.name, imported.length, nextText.split("\n").length, dropped)
        : t("popup_glossary_imported", file.name, imported.length, merged.length)
    );
  } catch (error) {
    setError(errorText(error));
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
    setError(t("popup_glossary_nothing_to_export"));
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
  setGlossaryActionHint(t("popup_glossary_exported", entries.length, isCsv ? "CSV" : "TXT"));
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

localizePage();
void refresh()
  .then(() => Promise.all([pollLocal(), checkBuiltinSupport()]))
  .catch((error) => setError(errorText(error)));
localPollTimer = setInterval(() => {
  void pollLocal();
}, LOCAL_POLL_MS);
window.addEventListener("unload", () => {
  if (localPollTimer) clearInterval(localPollTimer);
});
