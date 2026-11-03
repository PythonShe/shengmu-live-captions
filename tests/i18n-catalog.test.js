import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

import { TRANSLATION_PROVIDERS } from "../extension/lib/translation-api.js";
import { loadCatalog } from "./helpers/i18n.js";

const ROOT = new URL("../", import.meta.url);
const LOCALES = ["zh_CN", "en", "zh_TW"];

function walk(dir, extensions, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "_locales") continue;
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir), extensions, files);
    else if (extensions.some((extension) => name.endsWith(extension))) files.push(url);
  }
  return files;
}

const sources = [
  ...walk(new URL("extension/", ROOT), [".js", ".html", ".json"]),
  ...walk(new URL("scripts/local-service/", ROOT), [".mjs"])
].map((url) => ({ path: url.pathname, text: readFileSync(url, "utf8") }));

// Keys built at runtime, e.g. t(`provider_${id}`).
const DYNAMIC_KEYS = Object.keys(TRANSLATION_PROVIDERS).map((id) => `provider_${id}`);

function paramsOf(message) {
  return [...new Set(message.match(/\$[1-9]/g) || [])].sort();
}

test("every locale has the same keys and the same $n params", () => {
  const base = loadCatalog("zh_CN");
  for (const locale of LOCALES.slice(1)) {
    const catalog = loadCatalog(locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(base).sort(), locale);
    for (const [key, entry] of Object.entries(base)) {
      assert.deepEqual(paramsOf(catalog[key].message), paramsOf(entry.message), `${locale} ${key}`);
    }
  }
});

test("keys are lowercase, since Chrome matches them case-insensitively", () => {
  for (const key of Object.keys(loadCatalog("zh_CN"))) {
    assert.match(key, /^[a-z0-9_]+$/, key);
  }
});

test("every key the code names exists in the catalog", () => {
  const catalog = loadCatalog("zh_CN");
  const patterns = [
    /\b(?:t|msg|getMessage)\(\s*"([a-z0-9_]+)"/g,
    /data-i18n(?:-[a-z-]+)?="([a-z0-9_]+)"/g,
    /__MSG_([a-z0-9_]+)__/g,
    /\b(?:errorCode|messageKey|key):\s*"([a-z0-9_]+)"/g
  ];
  const missing = new Set();
  for (const { path, text } of sources) {
    for (const pattern of patterns) {
      for (const [, key] of text.matchAll(pattern)) {
        if (!(key in catalog) && !/^(asr|translation)$/.test(key)) missing.add(`${key} (${path})`);
      }
    }
  }
  for (const key of DYNAMIC_KEYS) {
    if (!(key in catalog)) missing.add(key);
  }
  assert.deepEqual([...missing], []);
});

test("every catalog key is used somewhere", () => {
  const corpus = sources.map(({ text }) => text).join("\n");
  const unused = Object.keys(loadCatalog("zh_CN")).filter(
    (key) =>
      !DYNAMIC_KEYS.includes(key) &&
      !corpus.includes(`"${key}"`) &&
      !corpus.includes(`__MSG_${key}__`)
  );
  assert.deepEqual(unused, []);
});
