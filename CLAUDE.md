# Shengmu Live Captions

Chrome MV3 extension: `tabCapture` audio -> `offscreen` -> WhisperLiveKit ASR (`127.0.0.1:8010`) -> translation by an OpenAI-compatible API (DeepSeek default) or local `llama-server` (`8013`) -> Shadow DOM overlay + IndexedDB history. Design notes are upstream's Chinese `paseo/` (index `paseo/README.md`); a higher-numbered note overrides a lower one.

## Repo and branches

- `origin` = `PythonShe/shengmu-live-captions` (fork), `upstream` = `exilemoulei/shengmu-live-captions` (we are collaborators, invited by the maintainer). Upstream changes go through PRs only.
- `dev` on `origin` carries fork-only files (this file, the `AGENTS.md` symlink) that never go upstream, not even inside a PR. Never push `dev` to `upstream`.
- Upstream PRs: branch from `upstream/master`, cherry-pick, PR against `exilemoulei:master`. Code commits never touch `CLAUDE.md` / `AGENTS.md` so they cherry-pick cleanly; edits here get their own `docs(claude):` commit.
- Sync with `git merge upstream/master`. Upstream tracks its own Chinese `AGENTS.md`: on conflict keep our symlink and port new rules here in English.
- Commit style follows upstream: Conventional Commits, `pit:` type for `.pit/` records.

## Gates and tooling

- `pnpm run verify` (syntax check, lint, typecheck, tests) must pass before every commit. Run `pnpm run smoke` (headless Chrome over CDP) after touching paths, the manifest, page HTML or worker startup. CI runs verify on ubuntu and windows, smoke on ubuntu.
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

## Invariants (each one came from a real bug)

- Entry-point folders never import each other; they talk only via `chrome.runtime` / `chrome.storage.local`. Nothing outside `background/` imports `background/`.
- Frozen: the IndexedDB schema (`shengmu-caption-history` v1) and the top-level `chrome.storage.local` keys. New settings go through `normalizeSettings` / `migrateLegacySettings`.
- Overlay injection is `files: ["content/overlay-history.js", "content/content-overlay.js"]`. `content-overlay.js` keeps the null-fallback `HISTORY_API` shim and delegates dynamically, so an old worker injecting one file does not throw. Bump `OVERLAY_VERSION` on any DOM/CSS/listener change so open tabs rebuild, and always call `existing?.teardown?.()` first.
- The overlay's non-passive `wheel` listener is bound only while the pointer is over the captions; binding it for the overlay's lifetime blocks compositor scrolling on the host page.
- Overlay width is measured with canvas `measureText`, never on the DOM: `text-wrap: balance` makes measured and current width feed each other and oscillate. Shrinking is delayed so the border does not twitch while text streams.
- `selectDisplayCaption` shows the newest English immediately; the translation slot keeps the previous sentence at full size (`.stale`) until the new one arrives, and only the corner dot signals waiting. Styling stale text smaller makes every sentence jump in height.
- Fragment merging (`mergeCaptionFragments`) is API mode only (in server mode WLK aligns translations to its own segments). `startsContinuation` accepts only subordinating connectors plus the participle allowlist, never so/from/in/for, and a merge closes on whether that line itself `needsCompletion`, otherwise whole passages glue into one line.
- `settings.opacity` `0` must not fall back to the default. The popup slider is the only opacity control.
- No empty `catch {}` or `console.error`-only handlers across boundaries; translation failures are `TranslationApiError` with a stable `code`, surfaced in `runtimeState`.
- Every translation passes `polishTranslation` before display or storage, on every path. Only `promptText` passes `stripSpeechFillers`; if that returns empty, fall back to the original text, or the line counts as failed and retries forever.
- The translation system prompt is a static constant (provider prefix caching measured at 35% -> 62% hit). Never interpolate request data into it; variable parts live in the user JSON payload. Tests pin the rule numbers. `recentTranslationContext` must receive the current batch ids, or a sentence appears in both `segments` and `context`.
- `finalize` runs once per session and seals history after its last flush; a late stop must not finalize again.
- Local model tiers stay in lockstep between `caption-utils.js` and `scripts/local-service/config.mjs` (tested).
- WLK flags are tuned on 120 s sample comparisons; rerun one before changing them: `--asr-coalesce-min-s 0.5` (`0.3` turns 54% of captions into "The."-sized shards), `--buffer_trimming_sec 10` (`4` cuts audio every 4 s and triggers `Resetting buffer`). Several flags exist only in the `.research/WhisperLiveKit` fork.
- Translation mode coupling: `api` with a key starts WLK ASR-only (all VRAM to ASR); otherwise the local translation model starts as fallback. WLK does not report its mode, so `server.mjs` remembers the launch mode and glossary and restarts on mismatch. A failed stop returns 500 and does not continue starting.
- The service manager kills only processes it launched (PID files in `.runtime/`, image or command-line check first); anything else on 8010/8013 is reported, not killed. Starting WLK sets `HF_HUB_DISABLE_XET=1` (HF Xet deadlocks behind a local proxy).

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
