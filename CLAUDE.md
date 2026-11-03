# Shengmu Live Captions

Chrome MV3 extension (v0.5.5) for live caption translation. `tabCapture` grabs the tab's English audio, `offscreen` streams it over WebSocket to a local WhisperLiveKit (`127.0.0.1:8010`), and an external API (DeepSeek by default) or a local `llama-server` (`127.0.0.1:8013`) translates it to Chinese. Output renders into a Shadow DOM overlay and an IndexedDB-backed history page.

Core design notes (Chinese, upstream-owned): `paseo/01-translation-api-design.md`, `paseo/08-local-model-0.5.0.md`, `paseo/09-overlay-injection-0.5.1.md`, `paseo/10-asr-width-opacity-0.5.2.md`, `paseo/11-glossary-0.5.3.md`, `paseo/12-poe-glossary-0.5.4.md`, `paseo/13-subtitle-flow-0.5.5.md`. Index: `paseo/README.md`.

## 0. Repo and branches

- `origin` = `PythonShe/shengmu-live-captions` (our fork). `upstream` = `exilemoulei/shengmu-live-captions`; we are a collaborator there (push + triage since 2026-11-03), invited by the maintainer to help finish the project. Changes still reach `upstream/master` only through pull requests.
- `dev` is our long-lived working branch on `origin`. It carries fork-only scaffolding (this file, the `AGENTS.md` symlink) that never goes upstream, not even inside a PR.
- Upstream PRs: branch from `upstream/master` (not `dev`), cherry-pick the relevant commits, open the PR against `exilemoulei:master`. Keep every code commit free of `CLAUDE.md` / `AGENTS.md` changes so it cherry-picks cleanly; docs in this file get their own commit. Never push `dev` to `upstream`.
- Sync: `git fetch upstream && git merge upstream/master` into `dev`. Upstream still tracks its own Chinese `AGENTS.md`; on a conflict keep our symlink and port any new rules from it into this file in English.
- Upstream commit style is Conventional Commits with a version scope (`feat(0.5.5): ...`, `docs(0.5.4): ...`) plus a `pit:` type for `.pit/` records. Use the same style.

## 1. Commands

```sh
pnpm install                 # dev tooling only (ESLint, TypeScript); the extension has no runtime node_modules
pnpm run verify              # gate: check + lint + typecheck + test, must pass before every commit
pnpm run check               # node --check over every .js/.mjs (scripts/check-syntax.mjs)
pnpm run lint                # ESLint, per-layer globals (eslint.config.js)
pnpm run typecheck           # tsc --checkJs over extension/lib only (tsconfig.json), no emit
pnpm test                    # node:test, pure Node
pnpm run smoke               # headless Chrome loads the unpacked extension over CDP (scripts/smoke-extension.mjs)
pnpm services:start          # WLK (8010) + llama-server (8013); see "Local services" below
node paseo/mock-openai-server.mjs   # OpenAI-compatible mock at http://127.0.0.1:8787/v1, no key needed
```

- pnpm only, pinned by `packageManager` in `package.json` (`corepack enable` picks it up); `pnpm-lock.yaml` is generated, never hand-edited. The switch from npm also goes upstream.
- CI (`.github/workflows/ci.yml`) runs `verify` on ubuntu and windows and `smoke` on ubuntu, on every push and PR. Run `smoke` locally after touching paths, the manifest, page HTML or worker startup; it needs Chrome (`CHROME_PATH` overrides discovery).
- Test coverage: `extension/lib/` is unit-tested; `background/service-worker.js` is imported by `tests/service-worker.integration.test.js` against a mocked `chrome` (settings, security, glossary paths only, not the caption pipeline). The local services are tested against the stub executable `tests/fixtures/stub-service.js`: `service-manager.test.js` (flags, per-OS table, start/stop/restart/asr-only, PID safety), `model-download.test.js` (resume, size check, proxy), `local-service.test.js` (spawns `server.mjs` on a random port: 403 rules, 409 races, mode/glossary restarts, stop during start, download) and `services-cli.test.js`. `popup.js`, `subtitle.js`, `content-overlay.js`, `offscreen.js` and `history-db.js` have no unit tests; lint, `check` and `smoke` are their net. `tests/extension-paths.test.js` resolves every manifest, HTML, import and `chrome.*` path.
- Lint layering: `extension/lib/` sees only the web APIs Node also has (no `chrome`, `window`, `document`), so `no-undef` enforces purity; `storage/` adds IndexedDB only; `content/`, `offscreen/offscreen.js` and `pcm-worklet.js` are classic scripts. Intentional control-character regexes carry an `eslint-disable-next-line ... -- reason`.
- Type checking covers `extension/lib/` only. Destructured option objects need a JSDoc `@param` / `@typedef`, or tsc infers `{}` and rejects callers.
- Load the extension unpacked from `extension/` in `chrome://extensions` (developer mode); click Reload after edits.

### Local services (Node, any OS)

`scripts/services.mjs` (no PowerShell) starts and stops the local models; `pnpm services help` lists every option:

```sh
pnpm services:start [--asr-only] [--restart] [--translation-model 9b-q4km|2b-iq4xs] [--asr-model large-v3-turbo|medium]
pnpm services:stop | pnpm services:status
pnpm services:serve [--port 8014]          # control service in the background; stop: pnpm services:serve-stop
pnpm dev-browser --port 9223 --url https://www.youtube.com/
pnpm services download --translation-model 2b-iq4xs | --asr-model medium
```

- Layout (`scripts/local-service/`): `config.mjs` (pure: paths, per-OS table, model tiers, the exact WLK / llama-server / whisper-server command lines), `processes.mjs` (detached spawn with `logs/<name>.*.log`, PID files, tree kill, port and `/health` probes), `download.mjs` (fetch with `.part` + Range resume, size check, proxy), `service-manager.mjs` (start/stop/status, the port of the old `Start-Services.ps1` / `Stop-Services.ps1`). `server.mjs` and the CLI both use the manager in-process.
- Stop kills only what start launched, by the JSON PID files in `.runtime/` (`wlk`, `llama-server`, `whisper-cpp`): `taskkill /PID n /T /F` on Windows after a `tasklist` image-name check, the process group (`kill -pid`) elsewhere. A PID whose image or group does not match is left alone, and anything still listening on 8010/8013 is reported, not killed.
- Per-OS table (`PLATFORMS`): Windows `.research/wlk-venv/Scripts/*.exe` + faster-whisper; macOS `bin/` + whisper.cpp; Linux `bin/` + faster-whisper. `llama-server` is looked up in `.research/llama.cpp*/` (top level, `bin/`, `build/bin[/Release]`) then PATH; it gets `-m --alias --host 127.0.0.1 --port -c 2048 -ngl 999`, plus `SHENGMU_LLAMA_EXTRA_ARGS` (JSON array) for anything the old untracked `.research/start_translation_server.ps1` added.
- macOS ASR: WhisperLiveKit has no whisper.cpp backend. `SHENGMU_ASR_BACKEND=whisper-cpp` (the macOS default) starts `whisper-server` on 8011 with `--inference-path /v1/audio/transcriptions` and runs WLK with `--backend openai-api`, `OPENAI_BASE_URL=http://127.0.0.1:8011/v1` and a placeholder `OPENAI_API_KEY`. Experimental: whisper-server nests word timings per segment, so WLK's LocalAgreement sees segment-level tokens. Homebrew's `whisper-cpp` is built without `whisper-server`; build whisper.cpp into `.research/whisper.cpp/build/bin/` or put it on PATH. The ggml model downloads itself into `.research/models/whisper.cpp/` on first start. `mlx-whisper` and `faster-whisper` are the other backends.
- Overrides (all optional, used by the tests): `SHENGMU_RESEARCH_DIR`, `SHENGMU_LOGS_DIR`, `SHENGMU_RUNTIME_DIR`, `SHENGMU_LOCAL_SERVICE_PID_FILE`, `SHENGMU_{ASR,TRANSLATION,WHISPER_CPP,LOCAL_SERVICE}_PORT`, `SHENGMU_ASR_BACKEND`, `SHENGMU_{WLK,LLAMA,WHISPER_CPP}_SERVER` (binary path), `SHENGMU_{WLK,LLAMA,WHISPER_CPP}_COMMAND` (JSON array, wins over the path), `SHENGMU_WLK_WORKDIR`, `SHENGMU_HEALTH_POLL_MS`, `HF_ENDPOINT` (mirror), `HF_HUB_CACHE` / `HF_HOME`.
- Proxy: fetch ignores `HTTP(S)_PROXY` unless configured, so `server.mjs` and `download` call `configureProxyFromEnv` (`http.setGlobalProxyFromEnv`, Node >= 24.14, stability 1.1) with loopback always in `NO_PROXY`; `SHENGMU_DOWNLOAD_NO_PROXY=1` turns it off.
- The `.research/` contents (the WhisperLiveKit fork, its venv, llama.cpp, models) are maintainer-provided and absent on this Mac; the local models assume an NVIDIA GPU on Windows. Without them, test API mode against DeepSeek or the mock server.
- Before running the `.research/ui-smoke-*.py` CDP mouse/wheel smoke tests, confirm the page reports `visibilityState === "visible"` and Chrome runs with `--disable-features=CalculateNativeWinOcclusion`, otherwise `Input.dispatchMouseEvent` hangs. Known environment traps are recorded in `.pit/pits/`.

## 2. Docs and files

- When a change makes `paseo/*.md`, `README.md` or `PROGRESS.md` wrong, fix them in the same change. Higher-numbered `paseo/` notes override lower ones (`09` beats `07`). `.research/*/CLAUDE.md` files are frozen upstream references and do not apply here.
- `README.md`, `PROGRESS.md`, `GLOSSARY-ISSUES.md` and `paseo/` are upstream's Chinese docs; edits there stay in Chinese to match. New fork-only docs are English; a Chinese one is written only on request, named `*.zh-CN.md`.
- Never hand-edit or clear `scripts/local-service/server.pid`, `.runtime/`, `logs/`, `chrome-profile/`, `*.part` or `.research/`.
- A version bump updates `package.json` and `extension/manifest.json` together.

## 3. Process model

- `popup` calls `127.0.0.1:8014` (`server.mjs`), which starts and stops the local models through the in-process `service-manager.mjs`. The models run detached and outlive the control service.
- `service-worker.js` connects through `offscreen.js` to `ws://127.0.0.1:8010/asr?target_language=zh`, then broadcasts state to `popup`, `subtitle` and `content-overlay` via `chrome.runtime` / `chrome.tabs.sendMessage`.

## 4. Code rules

- Native ES modules (`"type": "module"`); the classic scripts are `content/overlay-history.js`, `content/content-overlay.js` (IIFE), `offscreen/offscreen.js` (loaded without `type="module"`) and `offscreen/pcm-worklet.js` (worklet). No bundler, no TypeScript build, no runtime `node_modules`.
- Overlay injection is fixed at `files: ["content/overlay-history.js", "content/content-overlay.js"]` (paths are relative to the extension root). `content-overlay.js` must keep the null-fallback `HISTORY_API` shim for `globalThis.ShengmuOverlayHistory` and delegate dynamically in `syncHistoryLog`, so an old worker that injects a single file (extension not reloaded) does not throw `TypeError`.
- No empty `catch {}` or `console.error`-only handlers across boundaries. The only exemptions are `appendJobLog` in `server.mjs` and the `.part` / `server.pid` cleanup.
  - Translation failures throw `TranslationApiError` (`code`, `status`, `message`) and are written to `runtimeState.current.translationError`.
  - Every translation passes `polishTranslation` (`speech-cleanup.js`) before display or storage, on both paths: API mode via `applyLineTranslations` / the buffer branch, server mode via `handleTranscriptUpdate`. Source text passes `stripSpeechFillers` before translation (only `entry.promptText`; the English shown in history stays verbatim). If `stripSpeechFillers` returns empty, fall back to the original text, otherwise the line is treated as failed and retried.
  - Overlay injection/init failures go through the idempotent `applyOverlayFailure(runtimeState, error)` into `runtimeState.overlayError`, and call both `broadcastToExtension({ type: "status" })` and `broadcastCaptionState()`.
  - IndexedDB writes are serialized by `HistoryWriteQueue`; a failed batch goes back to the head of the queue and keeps the newer translation.
  - Every route on the `8014` control service returns `{ ok: boolean, error?: string }`.

## 5. Overlay, transcript UI and ASR noise

Detailed specs: `paseo/07-ui-fixes-0.4.3.md`, `paseo/09-overlay-injection-0.5.1.md`.

- The overlay lives in Shadow DOM, deduplicated by `globalThis.__shengmuCaptionOverlay` and `OVERLAY_VERSION` (currently `7`: 4 -> 5 in 0.5.2 for the DOM/CSS rework, 5 -> 6 in 0.5.5 for full-brightness stale slots plus the corner dot, 6 -> 7 for the hover-bound wheel listener). Always call `existing?.teardown?.()` before replacing an old instance to unbind `window` listeners.
- Wheel handling: the non-passive `wheel` listener is attached only while the pointer is over the captions (or the just-closed history panel); a passive `pointermove` tracker (`syncWheelBinding`) toggles it, because the stage is `pointer-events:none` and gets no enter/leave events. Never bind it for the overlay's whole life: it blocks compositor scrolling on the host page.
- Width: `.stage` is only a positioning anchor (`min(68vw, 860px)`); the painted box is `.caption-shell` inside `.caption-stack`. JS measures the widest visible slot with canvas `measureText`, clamped to 240-860 px. Growing applies immediately; shrinking waits `SHELL_SHRINK_DELAY_MS = 420 ms` so the border does not twitch while text streams. Never go back to measuring width on the DOM: `text-wrap: balance` makes measured and current width feed each other and oscillate.
- `selectDisplayCaption` must show the newest English in the source slot immediately (an unfinalized buffer wins). The translation slot keeps the previous sentence and is marked `pending` until the new translation arrives: `.translation.pending` is an empty placeholder, `.translation.stale` is the previous sentence at the same size and full opacity (since 0.5.5). "Still translating" is shown only by the corner dot `.caption-shell[data-awaiting="1"]::before` (`syncAwaitingDot`, appears after >700 ms). Do not style stale text with the small `pending` size, or every sentence jumps in height.
- Since 0.5.5, ASR fragments are merged before translation, overlay, history and SRT: `mergeCaptionFragments` (`caption-utils.js`, plus `startsContinuation` / `needsCompletion` in `utterance.js`) joins an incomplete line with its successor; the merged line keeps the first line's id. API mode only (in server mode WLK aligns translations to its own segments and merging would drop them). Hard limits: `startsContinuation` accepts only subordinating connectors (and/but/or/that/which/with/because/if/when/while ...) and the `PARTICIPLE_CONNECTORS` allowlist (never so/from/in/for). Closing a merge depends only on whether that line itself `needsCompletion`, otherwise whole passages glue into one line.
- `settings.opacity` ranges `0.05-1` (`normalizeOpacity`; `0` must not fall back to the default). `--overlay-opacity` drives `.caption-shell` background, border, shadow and `backdrop-filter` plus the `.history` background (floored at `max(0.62, ...)` for legibility). The only UI control is the popup `#opacity` slider; do not add one to the overlay toolbar.
- `.caption-shell` is capped at `max-height: min(70vh, 680px)`. Body text sits in `.caption-text` with line clamps (translation 3, source 2, previous sentence in dual mode 2); overflow is cut with a top fade by `markCaptionOverflow`. History panel: 2 lines per translation, 1 per source.
- Overlay history `HISTORY_LIMIT = 60`, scrollback `MAX_SCROLLBACK = 40`. While wheel-scrolling back, `scrollbackSnapshot` locks the list of line ids (new lines do not push the viewport; late translations for the same id update in place).
- `subtitle.js` pages at `PAGE_SIZE = 250`, caps search at `MAX_SEARCH_RESULTS = 1000`, and updates the DOM through `planTranscriptDiff` (`append | slide | rebuild`).
- `isNoiseTranscript(text, duration)`: pure punctuation is always dropped; decimals and timecodes (`7.8.`, `00:12`) are dropped only when `duration <= 1.5 s`; plain integers and lines without a valid duration are kept.

## 6. Architecture

### 6.0 Size and layering

New files have a soft cap of 600 lines. The existing oversized files (`service-worker.js`, `content-overlay.js`, `subtitle.js`, `popup.js`, `translation-api.js`) must not be split as a side effect of a bug fix.

| Path | Holds |
|---|---|
| `extension/background/` `offscreen/` `content/` `popup/` `subtitle/` | One folder per entry point (worker, offscreen capture page + worklet, injected overlay, popup, transcript page). Entry points never import each other; they talk only via `chrome.runtime` / `chrome.storage.local` |
| `extension/lib/` (`caption-utils.js` `ui-model.js` `glossary.js` `glossary-poe.js` `history-write-queue.js` `utterance.js` `speech-cleanup.js` `translation-api.js`) | Pure domain functions and queues (`ui-model.js` holds the capture-status vocabulary, display-mode labels and formatters shared by popup and subtitle; `content/content-overlay.js` keeps its own copies and `tests/ui-model.test.js` pins them to it; shared by 2+ modules or needing their own tests). No `chrome.*`, no browser DOM APIs; enforced by lint and typecheck. `content/overlay-history.js` is pure too but stays beside the overlay because it is injected as a classic script |
| `extension/storage/history-db.js` | IndexedDB `shengmu-caption-history` (v1: `sessions`, `lines`). The on-disk schema and the top-level `chrome.storage.local` keys (`settings`, `runtimeState`, `historyRevision`, `overlayPositions`) are frozen; new settings go through `normalizeSettings` / `migrateLegacySettings` |
| `extension/lib/translation-api.js` | Extension-free protocol layer (OpenAI-compatible `/chat/completions` batch translation, cleanup, retry). May use the equally pure `glossary.js`; no `chrome.*` |
| `scripts/` | `services.mjs` CLI, `dev-browser.mjs`, `local-service/` (service manager + `server.mjs` on `127.0.0.1:8014`), `check-syntax.mjs`, `smoke-extension.mjs` |

Broadcast boundary: `settingsForBroadcast` serves extension pages (includes `customGlossary`). Anything sent to tabs (`broadcastCaptionState`, the `injectOverlay` init) must use `settingsForCaptions`, which strips the 32 KB custom glossary.

### 6.1 Model sync and runtime cadences

- Local model tiers (translation `9b-q4km | 2b-iq4xs`, ASR `large-v3-turbo | medium`) stay in lockstep between `extension/lib/caption-utils.js` and `scripts/local-service/config.mjs` (`tests/service-manager.test.js` enforces it). For a one-off experiment pass `--translation-model-path`.
- A WS reconnect starts a new epoch; `shiftTimecode` / `mergeCaptionLines` accumulate it into one continuous session timecode. `finalizeSession` locks once (waits for in-flight translations up to `TRANSLATION_STOP_TIMEOUT_MS = 15000 ms`) and clears `overlayError` and `tabId`.
- Throttle budget: `pcm-worklet.js` sends frames in `100 ms` batches (`1600` frames at 16 kHz). Completed-line translation debounces `160 ms` (<= `6` lines per batch). The unfinalized buffer debounces `450 ms` (min interval `1200 ms`, and it yields only when the line queue backlog is > `2`, otherwise line translation starves the buffer). State persistence `350 ms`, history flush `700 ms`.
- WLK flags (`buildWlkArgs` in `scripts/local-service/config.mjs`, locked by a test; run a 120 s sample comparison before changing; `--openai-translation-*` and `--localagreement-beam-size` exist only in the WLK fork under `.research/WhisperLiveKit`): `--asr-coalesce-min-s 0.5` (`0.3` turns 54% of captions into "The."-sized shards), `--localagreement-beam-size 3`, `--buffer_trimming_sec 10` (`4` cuts audio every 4 s and triggers `Resetting buffer`), `--confidence-validation`.
- Translation prompt (`translation-api.js`): the system prompt is a static constant, byte-identical for every request, so providers' automatic prefix caching hits; never interpolate request data into it. Rules 1-6 are fixed (rule 4: a segment may be part of one continuous utterance; rule 5: adjacent segment translations flow without repeating the previous segment; rule 6: continue from `context` (includes source text of untranslated lines, `MAX_CONTEXT_CHARS` 480, default 4 lines) without repeating it; rule 2 removes fillers, verbal tics, stutters and self-interruptions). Rules 7-9 only explain the optional user-payload fields `partial` (carries its own short instruction), `domain` and `glossary`; the per-request variable parts live in that JSON payload, and tests assert on these numbers. `translateTexts` caches the accepted request shape (thinking / token field / temperature) in memory per `baseUrl + model` (`resetTranslationRequestShapeCache` for tests), `TranslationApiError.retryAfterMs` carries a clamped 429/503 Retry-After, and `isSplittableTranslationError` marks `count_mismatch` / `parse_error` / `truncated` batches that may be retried in halves. `recentTranslationContext(lines, limit, excludeIds)` must receive the current batch id set, otherwise a sentence appears in both `segments` and `context`.
- Translation mode coupling: when the popup starts local services it sends `translationMode` + `apiTranslationConfigured`. `api` with `apiTranslationConfigured === true` -> `server.mjs` starts with `asrOnly` (no 8013, all VRAM to ASR, no WLK fallback translation). `api` without a key, or `server` mode -> start the local translation model as fallback. WLK does not expose its translation mode, so `server.mjs` records the last launch mode in `startedWlkMode` (and the glossary in `startedGlossarySignature`) and must set `restart` on mismatch (always restart when ASR-only is wanted; restart when translation is wanted and 8013 is not listening). `restart` stops both services first, as `-Restart` did. If `runStopServices()` fails it must return 500 and not continue starting.

## 7. Security and verification

- Glossary (`paseo/11-glossary-0.5.3.md`, `paseo/12-poe-glossary-0.5.4.md`): `glossary.js` has zero `chrome.*` / DOM. `GLOSSARY_PRESETS` ships `poe` (313 official CN-server translations plus homophone aliases; the word list is the data module `glossary-poe.js`); a new domain is one more entry and `GLOSSARY_PRESET_IDS` derives automatically. `resolveEffectiveGlossary` merges entries (custom beats preset). The settings keys `glossaryEnabled` / `glossaryPresetIds` / `glossaryDomainHint` (<= 120 chars) / `customGlossary` (<= 32 KB) live inside `settings` and are **not** in `TAB_ALLOWED_SETTING_KEYS` (so a web page cannot inject prompt text through glossary entries).
- Glossary data red lines: `glossary-poe.js` holds data only, no logic. The sole source of a translation is the `<title>` of the entry page on `poedb.tw/cn` or `poe2db.tw/cn` (PoE 2 wins on conflict; category pages use the same site's navigation; concept terms are backed by the body text of a skill/keyword page that uses the mechanic). A term without a retrievable Chinese title is not added, and never filled in from memory. Plain everyday single words (`Hit`, `Kill`, `Life`, `Mana`, `Spark`, `Arc`, ...) are banned. `sources[1..]` holds only homophone mishearings and variants a regex cannot derive, and never enters ASR hotwords. Order is budget: the first 35 entries' `sources[0]` must fit in 360 characters; the preset validation in the test suite catches overruns and duplicates.
- Glossary matching constraints: word boundaries, English plural/possessive folding, and **longest-match-first with span masking** (with both `Orb` and `Orb of Augmentation`, only the longer one is injected); <= 24 entries per batch, each reported at most once per batch. `matched` keeps the ASR's misheard spelling so the model can correct it. `buildAsrContextPrompt` takes only ASCII English source terms, <= 360 chars (the WLK session `context` cap is 1000). `serializeWlkGlossary` must **expand** `|` aliases into separate `source -> target` pairs and **skip** sources containing `; : = ->` or newlines (WLK truncates/splits there, so a silent rewrite ships a term that never matches). Both the text and CSV paths of `exportGlossaryText` must quote sources that would parse as line syntax (`|`, full-width comma, full-width equals, `->`, tab, quotes, and a leading `#` or `//`), otherwise exporting `A=B` and re-importing it yields a different entry.
- API keys and write protection: broadcasts always go through `settingsForBroadcast`, which strips plaintext `translationApiKeys` (only `translationApiKeyConfigured` is sent). Non-extension-page senders are caught by `isExtensionPageSender`, limited to display fields by `sanitizeSettingsPatch`, and denied `refresh-overlay`. Changing any provider's `baseUrl` clears its key. A public endpoint with a key must be `https://` (exempt: `http://127.0.0.1`, `localhost`, `[::1]`).
- `8014` control service: binds `127.0.0.1` only; enforces `hostAllowed` (loopback `Host` only, against DNS rebinding), `originAllowed` (empty Origin or `chrome-extension://` only) and returns 403 on `sec-fetch-site === "cross-site"`. `/start` and `/download` hold `startPending` / `downloadPending` across their probes so concurrent requests get 409, and `/stop` bumps `stopGeneration` to cancel a start that is still probing. Once a start runs, `/stop` aborts it through `jobAbort` and awaits `jobSettled` before stopping (aborted starts spawn nothing further); shutdown aborts it too. Starting WLK must set `HF_HUB_DISABLE_XET=1` unless the caller set it (prevents the HF Xet deadlock behind a local proxy); `buildWlkEnv` does this.
- Acceptance testing uses the fixed local audio `.research/quality-samples/*poe*.wav` (never an online YouTube video with random ads as the transcription source) and must meet: `0` missing translations, `deliveredRatio >= 0.999`, local latency `1-3 s` (`paseo/03-verification.md`).
