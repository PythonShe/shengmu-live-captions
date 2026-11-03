# Shengmu Live Captions

Chrome MV3 extension: `tabCapture` audio -> `offscreen` -> WhisperLiveKit ASR (`127.0.0.1:8010`) -> translation by an OpenAI-compatible API (DeepSeek default) or local `llama-server` (`8013`) -> Shadow DOM overlay + IndexedDB history. Design notes are upstream's Chinese `paseo/` (index `paseo/README.md`); a higher-numbered note overrides a lower one.

## Repo and branches

- `origin` = `PythonShe/shengmu-live-captions` (fork), `upstream` = `exilemoulei/shengmu-live-captions` (we are collaborators, invited by the maintainer). Upstream changes go through PRs only.
- `dev` on `origin` carries fork-only files (this file, the `AGENTS.md` symlink) that never go upstream, not even inside a PR. Never push `dev` to `upstream`.
- Upstream PRs: branch from `upstream/master`, cherry-pick, PR against `exilemoulei:master`. Code commits never touch `CLAUDE.md` / `AGENTS.md` so they cherry-pick cleanly; edits here get their own `docs(claude):` commit.
- Sync with `git merge upstream/master`. Upstream tracks its own Chinese `AGENTS.md`: on conflict keep our symlink and port new rules here in English.
- Commit style follows upstream: Conventional Commits, `pit:` type for `.pit/` records.

## Gates and tooling

- `pnpm run verify` (syntax check, lint, typecheck, tests) must pass before every commit. Run `pnpm run smoke` (headless Chrome over CDP) after touching paths, the manifest, page HTML or worker startup. CI runs verify on ubuntu, windows and macos (x64 and arm64), smoke on ubuntu, windows and macos.
- pnpm only (pinned via `packageManager`). The extension has no bundler, no build and no runtime `node_modules`; dev tooling only.
- Layering is enforced by lint globals: `extension/lib/` may use only web APIs Node also has (no `chrome`, `window`, `document`), `storage/` adds IndexedDB. `content/*`, `offscreen/offscreen.js` and `pcm-worklet.js` are classic scripts.
- Typecheck covers `extension/lib/` only; destructured option params need a JSDoc type or tsc infers `{}` and rejects callers.
- `popup.js`, `subtitle.js` and `content-overlay.js` have no unit tests; lint, check and smoke are their only net.
- The `.research/` stack (WLK fork, venv, llama.cpp, models) is maintainer-provided and absent on this Mac, and the local models assume an NVIDIA GPU on Windows. Test API mode against DeepSeek (`.env.local`, git-excluded) or `node paseo/mock-openai-server.mjs`.
- `.research/ui-smoke-*.py` CDP mouse tests hang in `Input.dispatchMouseEvent` unless the page is `visibilityState === "visible"` and Chrome runs with `--disable-features=CalculateNativeWinOcclusion`. Known traps: `.pit/pits/`.

## Docs and files

- `README.md`, `PROGRESS.md`, `GLOSSARY-ISSUES.md` and `paseo/` are upstream's Chinese docs: edits stay Chinese, and fix them in the same change that makes them wrong. Fork-only docs are English.
- `.research/*/CLAUDE.md` are frozen upstream references and do not apply here.
- Never hand-edit or clear `server.pid`, `.runtime/`, `logs/`, `chrome-profile/`, `*.part` or `.research/`.
- A version bump updates `package.json` and `extension/manifest.json` together (a test enforces it).

## i18n

- UI text lives in `extension/_locales/{zh_CN,en,zh_TW}/messages.json`; zh_CN is `default_locale` and the HTML keeps its zh_CN text plus `data-i18n*` attributes. Add every new key to all three files: `tests/i18n-catalog.test.js` fails on unequal keys or `$n` params, a key the code names but the catalog lacks, and unused keys. Keys are lowercase snake_case (Chrome matches keys case-insensitively).
- zh_TW is OpenCC `s2twp` output, then Chrome's own Taiwan terms (擴充功能, 權限, 即時, 「」); the brand stays 声幕.
- `lib/` never builds UI text: it returns `msg(key, ...params)` (`lib/i18n-message.js`) or throws an error carrying one. The worker renders with `background/i18n.js`, pages with `ui/i18n.js`, and offscreen.js / content-overlay.js have inline copies. Runtime state (`detail`, `translationError`) holds rendered text.
- `server.mjs` adds `errorCode` / `messageKey` next to its Chinese `error` / `message`; keep both, the CLI and older builds read the text.
- The translation prompt, glossary data and the zh target language are not localized.

## Easy to break silently

No test catches these; each one came from a real bug.

- Frozen: the IndexedDB schema (`shengmu-caption-history` v1) and the top-level `chrome.storage.local` keys. New settings go through `normalizeSettings` / `migrateLegacySettings`.
- Bump `OVERLAY_VERSION` on any overlay DOM/CSS/listener change, or open tabs keep the old instance. Keep the `HISTORY_API` null-fallback shim in `content-overlay.js`: an old worker may inject only that one file.
- Overlay width is measured with canvas `measureText`, never on the DOM: `text-wrap: balance` makes measured and current width feed each other and oscillate.
- Every translation path (including new backends) runs `polishTranslation` before display or storage.
- WLK flags are tuned on 120 s sample comparisons (`--asr-coalesce-min-s 0.3` turned 54% of captions into "The."-sized shards; `--buffer_trimming_sec 4` cut audio every 4 s); rerun one before changing them.

## Security

- Broadcasts to extension pages go through `settingsForBroadcast` (strips plaintext API keys). Anything sent to tabs uses `settingsForCaptions` (also strips the 32 KB custom glossary).
- Every message type declares its allowed sender in `MESSAGE_ROUTES`; `message-router.test.js` pins the matrix. Tab senders may only patch display fields (`sanitizeSettingsPatch`) and are denied `refresh-overlay`. Glossary settings are deliberately not tab-writable, so a page cannot inject prompt text.
- Changing a provider's `baseUrl` clears its key. A public endpoint with a key must be `https://` (loopback exempt).
- The `8014` control service binds loopback only and enforces a loopback `Host` (DNS rebinding), an empty or `chrome-extension://` Origin, and 403 on cross-site fetches. Concurrent `/start` / `/download` get 409; `/stop` cancels a start in progress. Every route returns `{ ok, error? }`.

## Glossary data rules

- `glossary-poe.js` is data only. A translation's sole source is the `<title>` of its entry page on `poedb.tw/cn` or `poe2db.tw/cn` (PoE 2 wins on conflict). A term without a retrievable Chinese title is not added and never filled from memory. Plain everyday words (`Hit`, `Life`, `Arc`, ...) are banned.
- `sources[1..]` holds only homophone mishearings a regex cannot derive and never enters ASR hotwords. Entry order is a budget: the first 35 `sources[0]` must fit in 360 characters (tested).
- Matching is longest-match-first with span masking, and `matched` keeps the ASR's misheard spelling so the model can correct it. `serializeWlkGlossary` expands `|` aliases and skips sources containing `; : = ->` or newlines (WLK splits there). Export must quote sources that would re-parse as line syntax, or a round trip changes the entry.

## Acceptance

Quality runs use the fixed local audio `.research/quality-samples/*poe*.wav`, never a live video with random ads, and must reach `0` missing translations, `deliveredRatio >= 0.999` and `1-3 s` local latency (`paseo/03-verification.md`).
