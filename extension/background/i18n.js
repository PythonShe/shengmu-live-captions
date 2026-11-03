// chrome.i18n for the worker: renders the messages lib/ returns.
import { errorMessage, renderWith } from "../lib/i18n-message.js";

/**
 * @param {string} key messages.json key
 * @param {...unknown} params $1..$9
 */
export function t(key, ...params) {
  return globalThis.chrome?.i18n?.getMessage(key, params.map((param) => String(param ?? ""))) || key;
}

/** @param {unknown} message a string or a lib/ LocalMessage */
export function render(message) {
  return renderWith(t, message);
}

/** The localized text for anything thrown. */
export function errorText(error) {
  return render(errorMessage(error));
}
