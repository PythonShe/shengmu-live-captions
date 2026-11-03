// Presentation vocabulary shared by the popup and the transcript page, so the
// two surfaces cannot word the same capture state differently. Pure: no
// chrome.*, no DOM. The injected overlay is a classic script and cannot import
// this module; tests/ui-model.test.js pins its copies to the values here.

import { DISPLAY_MODES } from "./caption-utils.js";

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

/** @type {Readonly<Record<string, string>>} */
export const DISPLAY_MODE_LABELS = Object.freeze({
  bilingual: "中英双语",
  dual: "双行译文（上句+当前句）",
  chinese: "仅中文",
  english: "仅英文"
});

/**
 * Compact labels for the overlay toolbar button.
 * @type {Readonly<Record<string, string>>}
 */
export const DISPLAY_MODE_SHORT_LABELS = Object.freeze({
  bilingual: "双语",
  dual: "双行",
  chinese: "中文",
  english: "英文"
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
 * @returns {CapturePresentation}
 */
export function capturePresentation(state) {
  const cause = state?.detail || "";
  if (!state?.active) {
    if (state?.status === "error") {
      return {
        label: "采集异常",
        summary: cause || "采集异常",
        detail: cause || "等待标签页音频",
        dotClass: "warning",
        ratio: ""
      };
    }
    if (state?.status === "incomplete") {
      return {
        label: "已停止，存在缺译",
        summary: cause || "已停止，存在缺译",
        detail: cause || "等待标签页音频",
        dotClass: "warning",
        ratio: ""
      };
    }
    return {
      label: "准备就绪",
      summary: "准备就绪",
      detail: cause || "等待标签页音频",
      dotClass: "",
      ratio: ""
    };
  }

  const status = state.status || "capturing";
  const connected = Boolean(state.wsConnected);
  /** @type {Record<string, string>} */
  const labels = {
    starting: "正在建立音频采集",
    capturing: connected ? "实时翻译中" : "等待字幕服务",
    reconnecting: "字幕服务重连中",
    finished: "正在收尾",
    error: "采集异常",
    stopped: "已停止"
  };
  /** @type {Record<string, string>} */
  const details = {
    starting: "正在连接标签页音频",
    capturing: "仅采集当前标签页",
    reconnecting: "正在自动重连",
    error: "请重新开始"
  };
  const label = labels[status] || cause || status;
  /** @type {"" | "live" | "warning"} */
  let dotClass = "";
  if (status === "capturing") dotClass = connected ? "live" : "warning";
  else if (["starting", "reconnecting", "error"].includes(status)) {
    dotClass = "warning";
  }
  return {
    label,
    summary: status === "error" ? cause || label : label,
    detail: cause || details[status] || "",
    dotClass,
    ratio: state.audio?.deliveredRatio
      ? `音频 ${Math.round(state.audio.deliveredRatio * 100)}%`
      : ""
  };
}

/**
 * Compact status for the overlay's tight toolbar chip.
 * @param {any} state
 * @returns {string}
 */
export function overlayStatusLabel(state) {
  if (!state?.active) {
    return state?.status === "incomplete" ? "有缺译" : "已停止";
  }
  if (state.status === "reconnecting") return "重连中";
  if (state.status === "starting") return "准备中";
  if (state.status === "error") return "异常";
  if (state.wsConnected) return "实时";
  return "等待服务";
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
 * @returns {string}
 */
export function formatDate(timestamp) {
  if (!timestamp) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

/**
 * @param {number} milliseconds
 * @returns {string}
 */
export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${remaining} 秒`;
  return `${remaining} 秒`;
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
