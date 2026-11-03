// chrome.i18n for the extension pages. The markup keeps the zh_CN text, so
// the default locale needs nothing from here before first paint; elements
// tagged data-i18n (text) or data-i18n-<attribute> get the UI locale's text.

import { errorMessage, renderWith } from "../lib/i18n-message.js";

const LOCALIZED_ATTRIBUTES = ["placeholder", "aria-label", "title"];

/**
 * @param {string} key messages.json key
 * @param {...unknown} params $1..$9
 */
export function t(key, ...params) {
  return chrome.i18n.getMessage(key, params.map((param) => String(param ?? ""))) || key;
}

/**
 * Text produced by lib/ (which cannot reach chrome.i18n): a plain string or
 * a { key, params } message, whose params may nest.
 * @param {unknown} message
 */
export function renderMessage(message) {
  return renderWith(t, message);
}

/** The localized text for anything thrown, including lib/ errors. */
export function errorText(error) {
  return renderMessage(errorMessage(error));
}

export function localizePage(root = document) {
  // The catalog Chrome actually picked, which is zh_CN for an unsupported UI
  // locale, not the UI locale itself.
  document.documentElement.lang = t("html_lang");
  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.getAttribute("data-i18n"));
  }
  for (const attribute of LOCALIZED_ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
