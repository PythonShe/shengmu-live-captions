// Presentation vocabulary shared by the popup and the transcript page, so the
// two surfaces cannot word the same capture state differently. Pure: no
// chrome.*, no DOM, so wording goes through an injected `t` (chrome.i18n on
// the pages, the zh_CN catalog in tests). The injected overlay is a classic
// script and cannot import this module; tests/ui-model.test.js pins its
// copies to the values here.

import { DISPLAY_MODES } from "./caption-utils.js";

/**
 * messages.json key and $1..$9 params to text.
 * @typedef {(key: string, ...params: unknown[]) => string} Translate
 */

/** @type {Translate} */
const keyOnly = (key) => key;

/**
 * @typedef {object} CapturePresentation
 * @property {string} label Short status name shared by every surface.
 * @property {string} summary `label`, or the worker's own detail text for
 *   error / incomplete states (the popup has one line and shows the cause).
 * @property {string} detail Secondary line with a per-status default.
 * @property {"" | "live" | "warning"} dotClass
 * @property {string} ratio Audio delivery text, empty when unknown.
 */

/** Display modes in toolbar cycle order, derived from the settings source. */
export const DISPLAY_MODE_ORDER = Object.freeze([...DISPLAY_MODES]);

/** @type {Readonly<Record<string, string>>} message keys */
export const DISPLAY_MODE_LABELS = Object.freeze({
  bilingual: "display_mode_bilingual",
  dual: "display_mode_dual",
  chinese: "display_mode_chinese",
  english: "display_mode_english"
});

/**
 * Message keys of the compact labels for the overlay toolbar button.
 * @type {Readonly<Record<string, string>>}
 */
export const DISPLAY_MODE_SHORT_LABELS = Object.freeze({
  bilingual: "display_mode_short_bilingual",
  dual: "display_mode_short_dual",
  chinese: "display_mode_short_chinese",
  english: "display_mode_short_english"
});

export const FONT_SIZE_MIN = 20;
export const FONT_SIZE_MAX = 64;

/**
 * @param {string} mode
 * @returns {string} the mode that follows `mode` in the toolbar cycle
 */
export function nextDisplayMode(mode) {
  const index = DISPLAY_MODE_ORDER.indexOf(mode);
  return DISPLAY_MODE_ORDER[(index + 1) % DISPLAY_MODE_ORDER.length];
}

/**
 * @param {number} value
 * @returns {number}
 */
export function clampFontSize(value) {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, value));
}

/**
 * @param {any} state runtime state broadcast by the worker
 * @param {Translate} [t]
 * @returns {CapturePresentation}
 */
export function capturePresentation(state, t = keyOnly) {
  const cause = state?.detail || "";
  if (!state?.active) {
    if (state?.status === "error") {
      const label = t("status_error");
      return {
        label,
        summary: cause || label,
        detail: cause || t("status_waiting_audio"),
        dotClass: "warning",
        ratio: ""
      };
    }
    if (state?.status === "incomplete") {
      const label = t("status_incomplete");
      return {
        label,
        summary: cause || label,
        detail: cause || t("status_waiting_audio"),
        dotClass: "warning",
        ratio: ""
      };
    }
    return {
      label: t("status_ready"),
      summary: t("status_ready"),
      detail: cause || t("status_waiting_audio"),
      dotClass: "",
      ratio: ""
    };
  }

  const status = state.status || "capturing";
  const connected = Boolean(state.wsConnected);
  /** @type {Record<string, string>} */
  const labels = {
    starting: "status_starting",
    capturing: connected ? "status_live" : "status_waiting_service",
    reconnecting: "status_reconnecting",
    finished: "status_finishing",
    error: "status_error",
    stopped: "status_stopped"
  };
  /** @type {Record<string, string>} */
  const details = {
    starting: "status_detail_starting",
    capturing: "status_detail_capturing",
    reconnecting: "status_detail_reconnecting",
    error: "status_detail_error"
  };
  const label = labels[status] ? t(labels[status]) : cause || status;
  /** @type {"" | "live" | "warning"} */
  let dotClass = "";
  if (status === "capturing") dotClass = connected ? "live" : "warning";
  else if (["starting", "reconnecting", "error"].includes(status)) {
    dotClass = "warning";
  }
  return {
    label,
    summary: status === "error" ? cause || label : label,
    detail: cause || (details[status] ? t(details[status]) : ""),
    dotClass,
    ratio: state.audio?.deliveredRatio
      ? t("status_audio_ratio", Math.round(state.audio.deliveredRatio * 100))
      : ""
  };
}

/**
 * Message key of the compact status for the overlay's tight toolbar chip.
 * @param {any} state
 * @returns {string}
 */
export function overlayStatusLabel(state) {
  if (!state?.active) {
    return state?.status === "incomplete" ? "overlay_status_incomplete" : "overlay_status_stopped";
  }
  if (state.status === "reconnecting") return "overlay_status_reconnecting";
  if (state.status === "starting") return "overlay_status_starting";
  if (state.status === "error") return "overlay_status_error";
  if (state.wsConnected) return "overlay_status_live";
  return "overlay_status_waiting";
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

/**
 * @param {number} timestamp epoch milliseconds
 * @param {Translate} [t]
 * @param {string} [locale] BCP 47; the runtime's default when omitted
 * @returns {string}
 */
export function formatDate(timestamp, t = keyOnly, locale = undefined) {
  if (!timestamp) return t("date_unknown");
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

/**
 * @param {number} milliseconds
 * @param {Translate} [t]
 * @returns {string}
 */
export function formatDuration(milliseconds, t = keyOnly) {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return t("duration_hours_minutes", hours, minutes);
  if (minutes > 0) return t("duration_minutes_seconds", minutes, remaining);
  return t("duration_seconds", remaining);
}

/**
 * @param {number} startedAt epoch milliseconds
 * @param {number} [now] injectable clock for tests
 * @returns {string}
 */
export function formatElapsed(startedAt, now = Date.now()) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pair = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pair(minutes)}:${pair(remainder)}`
    : `${pair(minutes)}:${pair(remainder)}`;
}
