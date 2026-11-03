// chrome.i18n.getMessage over a real messages.json, so tests read the same
// zh_CN text users see and catch a key missing from the catalog.
import { readFileSync } from "node:fs";

import { errorMessage, renderWith } from "../../extension/lib/i18n-message.js";

const catalogs = new Map();

export function loadCatalog(locale = "zh_CN") {
  if (!catalogs.has(locale)) {
    const url = new URL(`../../extension/_locales/${locale}/messages.json`, import.meta.url);
    catalogs.set(locale, JSON.parse(readFileSync(url, "utf8")));
  }
  return catalogs.get(locale);
}

/**
 * Chrome's substitution rules: named $placeholders$ first, then $1..$9 from
 * the substitutions, and $$ for a literal dollar sign. An unknown key is ""
 * in Chrome; here it throws so a typo fails the test.
 */
export function getMessage(key, substitutions = [], locale = "zh_CN") {
  const entry = loadCatalog(locale)[key];
  if (!entry) throw new Error(`messages.json (${locale}) has no key ${key}`);
  const params = (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
  let text = entry.message.replace(/\$([a-z0-9_@]+)\$/gi, (match, name) => {
    const placeholder = entry.placeholders?.[name.toLowerCase()];
    return placeholder ? placeholder.content : match;
  });
  text = text.replace(/\$(\$|[1-9])/g, (match, token) =>
    token === "$" ? "$" : params[Number(token) - 1] ?? ""
  );
  return text;
}

export function zh(key, ...params) {
  return getMessage(key, params);
}

/** Renders a lib/ message (or an error carrying one) as zh_CN text. */
export function renderZh(value) {
  return renderWith(zh, value instanceof Error ? errorMessage(value) : value);
}

export const i18nMock = Object.freeze({
  getMessage: (key, substitutions) => getMessage(key, substitutions),
  getUILanguage: () => "zh-CN"
});
