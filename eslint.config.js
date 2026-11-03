import js from "@eslint/js";
import globals from "globals";

// Layering is enforced through globals: a file only sees the APIs of the
// runtime it is loaded into, so `no-undef` flags e.g. `chrome.*` or `document`
// inside extension/lib/, which must stay pure and Node-testable.

// The subset of web APIs that both browsers and Node provide.
const universal = Object.fromEntries(
  [
    "AbortController",
    "AbortSignal",
    "TextDecoder",
    "TextEncoder",
    "URL",
    "URLSearchParams",
    "clearInterval",
    "clearTimeout",
    "console",
    "fetch",
    "queueMicrotask",
    "setInterval",
    "setTimeout",
    "structuredClone"
  ].map((name) => [name, "readonly"])
);

const chrome = { chrome: "readonly" };

export default [
  {
    ignores: ["node_modules/", ".research/", "logs/", "chrome-profile/", "paseo/evidence/"]
  },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: { ecmaVersion: 2024, sourceType: "module" },
    rules: {
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-implicit-globals": "error",
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      eqeqeq: ["error", "smart"],
      "no-shadow-restricted-names": "error",
      "no-throw-literal": "error",
      "no-promise-executor-return": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unreachable-loop": "error",
      "no-constant-binary-expression": "error"
    }
  },
  {
    files: ["extension/lib/**/*.js"],
    languageOptions: { globals: universal }
  },
  {
    files: ["extension/storage/**/*.js"],
    languageOptions: { globals: { ...universal, indexedDB: "readonly", IDBKeyRange: "readonly" } }
  },
  {
    files: ["extension/background/**/*.js"],
    languageOptions: { globals: { ...globals.serviceworker, ...chrome } }
  },
  {
    files: ["extension/popup/**/*.js", "extension/subtitle/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...chrome } }
  },
  {
    // offscreen.html loads it as a classic script, not a module.
    files: ["extension/offscreen/offscreen.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...chrome } },
    // The offscreen document runs nothing else, so its top-level functions
    // cannot collide with another script's globals.
    rules: { "no-implicit-globals": "off" }
  },
  {
    // Imported by offscreen.js only when its backend runs.
    files: ["extension/offscreen/web-speech.js"],
    languageOptions: { globals: { ...globals.browser, ...chrome } }
  },
  {
    // Injected with chrome.scripting.executeScript as classic scripts.
    files: ["extension/content/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser, ...chrome } }
  },
  {
    files: ["extension/offscreen/pcm-worklet.js"],
    languageOptions: { sourceType: "script", globals: globals.audioWorklet }
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.{js,mjs}", "paseo/**/*.mjs", "*.js"],
    languageOptions: { globals: globals.node }
  }
];
