// Static configuration for the local services: paths, per-OS defaults, model
// tiers and the exact command lines. Everything here is pure (no spawning, no
// network) so the tests can lock the flags and the per-OS table on any OS.
//
// Model tier ids must stay in lockstep with LOCAL_TRANSLATION_MODELS /
// LOCAL_ASR_MODELS in extension/lib/caption-utils.js; a test enforces it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_PORTS = Object.freeze({
  asr: 8010,
  // whisper.cpp only runs behind WhisperLiveKit (see ASR_BACKENDS), so it
  // takes a port of its own next to the public 8010.
  whisperCpp: 8011,
  translation: 8013,
  control: 8014
});

// Notes are chrome.i18n messages ({ key, params }) the popup renders with
// renderMessage; their text lives in the extension's _locales.
function modelNote(key, ...params) {
  return Object.freeze({ key, params: Object.freeze(params) });
}

export const TRANSLATION_MODELS = Object.freeze([
  Object.freeze({
    id: "9b-q4km",
    label: "Index-Translate-9B Q4_K_M",
    alias: "Index-Translate-9B",
    file: "Index-Translate-9B.Q4_K_M.gguf",
    subdir: "index-translate-9b",
    repo: "IndexTeam/Index-Translate-9B-GGUF",
    approxBytes: 5780090304,
    note: modelNote("server_model_note_best_quality", "5.4 GiB")
  }),
  Object.freeze({
    id: "2b-iq4xs",
    label: "Index-Translate-2B IQ4_XS",
    alias: "Index-Translate-2B",
    file: "Index-Translate-2B.IQ4_XS.gguf",
    subdir: "index-translate-2b",
    repo: "IndexTeam/Index-Translate-2B-GGUF",
    approxBytes: 1234377216,
    note: modelNote("server_model_note_low_vram", "1.15 GiB")
  })
]);

// The tiers the popup offers. faster-whisper and mlx-whisper fetch `hfRepo`
// into the Hugging Face cache on first use; whisper.cpp needs the `ggml` file,
// which the manager downloads itself before the first start.
export const ASR_MODELS = Object.freeze([
  Object.freeze({
    id: "large-v3-turbo",
    label: "large-v3-turbo",
    approxSize: "1.6 GB",
    note: modelNote("server_asr_note_default"),
    hfRepo: {
      "faster-whisper": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
      "mlx-whisper": "mlx-community/whisper-large-v3-turbo"
    },
    ggml: "ggml-large-v3-turbo.bin"
  }),
  Object.freeze({
    id: "medium",
    label: "medium",
    approxSize: "1.5 GB",
    note: modelNote("server_asr_note_faster"),
    hfRepo: {
      "faster-whisper": "Systran/faster-whisper-medium",
      "mlx-whisper": "mlx-community/whisper-medium-mlx"
    },
    ggml: "ggml-medium.bin"
  })
]);

// The CLI also accepts the two small sizes Start-Services.ps1 accepted.
export const ASR_MODEL_IDS = Object.freeze(["large-v3-turbo", "medium", "small", "base"]);
const GGML_FILES = { small: "ggml-small.bin", base: "ggml-base.bin" };
export const WHISPER_CPP_MODEL_REPO = "ggerganov/whisper.cpp";

// How each ASR backend reaches the extension. The extension always talks to
// WhisperLiveKit's /asr WebSocket, so every backend runs inside WLK.
//   faster-whisper  CUDA/CPU, the Windows reference setup.
//   mlx-whisper     Apple Silicon via MLX, a documented WLK backend.
//   whisper-cpp     WLK has no whisper.cpp backend. Its documented
//                   `openai-api` backend calls an OpenAI-compatible
//                   /v1/audio/transcriptions endpoint through the OpenAI SDK,
//                   which reads OPENAI_BASE_URL; whisper.cpp's whisper-server
//                   can serve that path with --inference-path. Experimental:
//                   whisper-server returns word timings per segment only.
export const ASR_BACKENDS = Object.freeze(["faster-whisper", "mlx-whisper", "whisper-cpp"]);
const WLK_BACKEND_FLAG = {
  "faster-whisper": "faster-whisper",
  "mlx-whisper": "mlx-whisper",
  "whisper-cpp": "openai-api"
};
// The OpenAI SDK refuses to build a client without a key. whisper-server
// ignores it, and a placeholder keeps a real OPENAI_API_KEY from the caller's
// environment out of the bridge.
export const WHISPER_CPP_PLACEHOLDER_KEY = "whisper-cpp-local";
export const WHISPER_CPP_INFERENCE_PATH = "/v1/audio/transcriptions";

export const PLATFORMS = Object.freeze({
  win32: Object.freeze({ venvBin: "Scripts", exeSuffix: ".exe", asrBackend: "faster-whisper" }),
  darwin: Object.freeze({ venvBin: "bin", exeSuffix: "", asrBackend: "whisper-cpp" }),
  linux: Object.freeze({ venvBin: "bin", exeSuffix: "", asrBackend: "faster-whisper" })
});

export function platformInfo(platform) {
  return PLATFORMS[platform] || PLATFORMS.linux;
}

export function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function numberFrom(value, fallback) {
  const parsed = Number(value);
  return value != null && value !== "" && Number.isFinite(parsed) ? parsed : fallback;
}

// JSON arrays, not shell strings: no quoting rules to get wrong across
// cmd.exe, PowerShell and sh.
function parseArgList(value, label) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be a JSON array of strings`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) {
    throw new Error(`${label} must be a JSON array of strings`);
  }
  return parsed;
}

function parseCommand(value, label) {
  const parts = parseArgList(value, label);
  if (!parts.length) return null;
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Resolves every path, port and command source. `env` and `platform` are
 * injectable so tests can build a Windows table on macOS and point the
 * manager at stub executables and temp directories.
 */
export function resolveConfig({ env = process.env, platform = process.platform, root = REPO_ROOT } = {}) {
  const p = pathFor(platform);
  const info = platformInfo(platform);
  const researchDir = env.SHENGMU_RESEARCH_DIR || p.join(root, ".research");
  const asrBackend = env.SHENGMU_ASR_BACKEND || info.asrBackend;
  if (!ASR_BACKENDS.includes(asrBackend)) {
    throw new Error(`Unknown ASR backend '${asrBackend}'. Known: ${ASR_BACKENDS.join(", ")}`);
  }
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return {
    platform,
    root,
    researchDir,
    logsDir: env.SHENGMU_LOGS_DIR || p.join(root, "logs"),
    runtimeDir: env.SHENGMU_RUNTIME_DIR || p.join(root, ".runtime"),
    modelsDir: p.join(researchDir, "models"),
    whisperCppModelsDir: env.SHENGMU_WHISPER_CPP_MODELS_DIR || p.join(researchDir, "models", "whisper.cpp"),
    hfEndpoint: String(env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, ""),
    hfCacheDir: env.HF_HUB_CACHE || (env.HF_HOME ? p.join(env.HF_HOME, "hub") : p.join(home, ".cache", "huggingface", "hub")),
    asrBackend,
    ports: {
      asr: numberFrom(env.SHENGMU_ASR_PORT, DEFAULT_PORTS.asr),
      whisperCpp: numberFrom(env.SHENGMU_WHISPER_CPP_PORT, DEFAULT_PORTS.whisperCpp),
      translation: numberFrom(env.SHENGMU_TRANSLATION_PORT, DEFAULT_PORTS.translation)
    },
    wlkWorkdir: env.SHENGMU_WLK_WORKDIR || p.join(researchDir, "WhisperLiveKit"),
    sources: {
      wlk: parseCommand(env.SHENGMU_WLK_COMMAND, "SHENGMU_WLK_COMMAND"),
      llama: parseCommand(env.SHENGMU_LLAMA_COMMAND, "SHENGMU_LLAMA_COMMAND"),
      whisperCpp: parseCommand(env.SHENGMU_WHISPER_CPP_COMMAND, "SHENGMU_WHISPER_CPP_COMMAND")
    },
    paths: {
      wlk: env.SHENGMU_WLK_SERVER || "",
      llama: env.SHENGMU_LLAMA_SERVER || "",
      whisperCpp: env.SHENGMU_WHISPER_CPP_SERVER || ""
    },
    llamaExtraArgs: parseArgList(env.SHENGMU_LLAMA_EXTRA_ARGS, "SHENGMU_LLAMA_EXTRA_ARGS"),
    pollMs: numberFrom(env.SHENGMU_HEALTH_POLL_MS, 500)
  };
}

export function wlkServerPath(config) {
  const p = pathFor(config.platform);
  const info = platformInfo(config.platform);
  return p.join(config.researchDir, "wlk-venv", info.venvBin, `whisperlivekit-server${info.exeSuffix}`);
}

// llama.cpp release zips unpack to llama.cpp-b<build>/ with the binaries at
// the top level; source builds put them under build/bin (Release/ on MSVC).
export function llamaServerCandidates(config, readdir = fs.readdirSync) {
  const p = pathFor(config.platform);
  const exe = `llama-server${platformInfo(config.platform).exeSuffix}`;
  let dirs;
  try {
    dirs = readdir(config.researchDir)
      .filter((name) => /^llama\.cpp/i.test(name))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  } catch {
    dirs = [];
  }
  return dirs.flatMap((dir) =>
    ["", "bin", p.join("build", "bin"), p.join("build", "bin", "Release")].map((sub) =>
      p.join(config.researchDir, dir, sub, exe)
    )
  );
}

export function whisperCppServerCandidates(config) {
  const p = pathFor(config.platform);
  const exe = `whisper-server${platformInfo(config.platform).exeSuffix}`;
  const base = p.join(config.researchDir, "whisper.cpp");
  return [p.join(base, "build", "bin", exe), p.join(base, "build", "bin", "Release", exe)];
}

export function findOnPath(name, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const p = pathFor(platform);
  const dirs = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const suffixes = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => ext.toLowerCase())
    : [""];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = p.join(dir, name + suffix);
      if (exists(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * Picks the command for one service: an explicit JSON command (tests,
 * wrappers), then an explicit binary path, then the per-OS defaults, then
 * PATH. Returns { command, args, found, tried } and never throws, so the
 * manager can report every path it looked at.
 */
export function resolveServiceCommand(config, name, { env = process.env, exists = fs.existsSync } = {}) {
  const source = config.sources[name];
  if (source) return { ...source, found: true, tried: [source.command] };
  if (config.paths[name]) {
    return { command: config.paths[name], args: [], found: exists(config.paths[name]), tried: [config.paths[name]] };
  }
  const defaults = {
    wlk: () => [wlkServerPath(config)],
    llama: () => llamaServerCandidates(config),
    whisperCpp: () => whisperCppServerCandidates(config)
  }[name]();
  const hit = defaults.find((candidate) => exists(candidate));
  if (hit) return { command: hit, args: [], found: true, tried: defaults };
  const onPath = {
    wlk: "whisperlivekit-server",
    llama: "llama-server",
    whisperCpp: "whisper-server"
  }[name];
  const fromPath = findOnPath(onPath, { env, platform: config.platform, exists });
  if (fromPath) return { command: fromPath, args: [], found: true, tried: [...defaults, fromPath] };
  return { command: defaults[0] || onPath, args: [], found: false, tried: [...defaults, `${onPath} on PATH`] };
}

export function translationModelPath(config, model) {
  return pathFor(config.platform).join(config.modelsDir, model.subdir, model.file);
}

export function translationModelUrls(config, model) {
  return {
    pageUrl: `https://huggingface.co/${model.repo}`,
    downloadUrl: `${config.hfEndpoint}/${model.repo}/resolve/main/${model.file}`
  };
}

export function ggmlFileFor(asrModelId) {
  return ASR_MODELS.find((model) => model.id === asrModelId)?.ggml || GGML_FILES[asrModelId] || "";
}

export function whisperCppModel(config, asrModelId) {
  const file = ggmlFileFor(asrModelId);
  return {
    file,
    path: pathFor(config.platform).join(config.whisperCppModelsDir, file),
    downloadUrl: `${config.hfEndpoint}/${WHISPER_CPP_MODEL_REPO}/resolve/main/${file}`
  };
}

export function resolveTranslationModel(id) {
  return TRANSLATION_MODELS.find((model) => model.id === id) || null;
}

export function resolveAsrModel(id) {
  return ASR_MODELS.find((model) => model.id === id) || null;
}

// PowerShell's double.ToString(InvariantCulture) prints 1.0 as "1" and 2.5 as
// "2.5"; String() matches it for the values the launcher ever passed.
function invariantNumber(value) {
  return String(Number(value));
}

/**
 * WhisperLiveKit's command line, flag for flag what Start-Services.ps1 passed.
 * Several flags (--openai-translation-*, --localagreement-beam-size) exist only
 * in the WhisperLiveKit fork under .research/WhisperLiveKit, not upstream.
 * Run the 120 s sample comparison before changing any value here.
 */
export function buildWlkArgs({
  port,
  asrBackend = "faster-whisper",
  asrModel,
  asrOnly = false,
  translationPort = DEFAULT_PORTS.translation,
  translationAlias = "",
  glossary = "",
  translateOnComplete = false,
  pauseSegmentationSeconds = 1.0,
  translationMaxSegmentSeconds = 2.5
}) {
  const args = [
    "--host", "127.0.0.1",
    "--port", String(port),
    "--backend", WLK_BACKEND_FLAG[asrBackend] || asrBackend,
    "--model", asrModel,
    "--lan", "en",
    "--pause-segmentation-seconds", invariantNumber(pauseSegmentationSeconds),
    "--pcm-input",
    "--backend-policy", "localagreement",
    // Kept at 0.5 s on purpose: 0.3 produced a decode pass twice as often,
    // which turned 54% of the lines into fragments such as "The." / "现在。"
    // on the 120 s quality sample.
    "--asr-coalesce-min-s", "0.5",
    // Beam 3 instead of greedy: fast speech needs the second opinion, and two
    // decodes that never agree are what force a buffer reset.
    "--localagreement-beam-size", "3",
    "--retention-seconds", "300",
    // 10 s (upstream default 15) instead of 4: a sentence that fails to commit
    // is trimmed instead of being thrown away wholesale.
    "--buffer_trimming", "segment",
    "--buffer_trimming_sec", "10",
    // Commit words with probability > 0.95 without waiting for a second
    // agreeing pass: CJK subtitles land ~0.5 s earlier per line.
    "--confidence-validation",
    "--log-level", "INFO"
  ];
  if (!asrOnly) {
    args.push(
      "--target-language", "zh",
      "--translation-backend", "openai",
      "--openai-translation-url", `http://127.0.0.1:${translationPort}/v1`,
      "--openai-translation-model", translationAlias,
      "--openai-translation-max-tokens", "768",
      "--openai-translation-max-segment-seconds", invariantNumber(translationMaxSegmentSeconds)
    );
    if (translateOnComplete) args.push("--translate-on-complete");
    if (glossary) args.push("--openai-translation-glossary", glossary);
  }
  return args;
}

/**
 * Environment for WhisperLiveKit. huggingface_hub's Xet transfer stalls behind
 * the maintainer's local proxy while plain HTTP completes, so Xet is disabled
 * unless the caller already chose a value.
 */
export function buildWlkEnv(baseEnv, { asrBackend, whisperCppPort }) {
  const env = { ...baseEnv };
  if (!env.HF_HUB_DISABLE_XET) env.HF_HUB_DISABLE_XET = "1";
  if (asrBackend === "whisper-cpp") {
    env.OPENAI_BASE_URL = `http://127.0.0.1:${whisperCppPort}/v1`;
    env.OPENAI_API_KEY = WHISPER_CPP_PLACEHOLDER_KEY;
  }
  return env;
}

/**
 * llama.cpp's llama-server, replacing the untracked
 * .research/start_translation_server.ps1 (-Port -Alias -ModelPath
 * -ContextSize 2048). `-ngl 999` offloads every layer, which every llama.cpp
 * build accepts; SHENGMU_LLAMA_EXTRA_ARGS appends anything else that launcher
 * passed.
 */
export function buildLlamaArgs({ port, alias, modelPath, contextSize = 2048, extraArgs = [] }) {
  return [
    "-m", modelPath,
    "--alias", alias,
    "--host", "127.0.0.1",
    "--port", String(port),
    "-c", String(contextSize),
    "-ngl", "999",
    ...extraArgs
  ];
}

// whisper.cpp's whisper-server flags; Metal is on by default on Apple Silicon.
export function buildWhisperCppArgs({ port, modelPath, language = "en" }) {
  return [
    "-m", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--inference-path", WHISPER_CPP_INFERENCE_PATH,
    "-l", language
  ];
}
