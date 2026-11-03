// Starts, stops and inspects the local model services (WhisperLiveKit on 8010,
// llama.cpp's llama-server on 8013, and whisper.cpp's whisper-server on 8011
// when that ASR backend is selected). This is the Node port of
// Start-Services.ps1 / Stop-Services.ps1: same options, same order of checks,
// same failure messages. The control service (server.mjs) and the CLI
// (scripts/services.mjs) both drive it in-process.
//
// Processes are tracked by PID files in .runtime/ instead of the old
// command-line matching, so stop() only ever kills what start() launched.
import fs from "node:fs";
import path from "node:path";
import {
  ASR_MODEL_IDS,
  TRANSLATION_MODELS,
  buildLlamaArgs,
  buildWhisperCppArgs,
  buildWlkArgs,
  buildWlkEnv,
  resolveConfig,
  resolveServiceCommand,
  translationModelPath,
  whisperCppModel
} from "./config.mjs";
import { downloadToFile, probeTotalBytes } from "./download.mjs";
import {
  fetchJson,
  isPidAlive,
  isPortListening,
  killServiceTree,
  readPidFile,
  removePidFile,
  sleep,
  spawnService,
  tailFile,
  waitForHealth,
  waitForPort
} from "./processes.mjs";

// PID file / log base names. The WLK log names match what Start-Services.ps1
// wrote (logs/wlk.stdout.log, logs/wlk.stderr.log).
export const SERVICE_NAMES = Object.freeze({ wlk: "wlk", translation: "llama-server", whisperCpp: "whisper-cpp" });

export const DEFAULT_TIMEOUTS = Object.freeze({
  translationHealthMs: 120_000,
  existingWlkHealthMs: 10_000,
  // A first run with an uncached ASR model downloads ~1.5 GB from Hugging
  // Face before /health answers, which can exceed three minutes.
  wlkHealthMs: 600_000,
  whisperCppReadyMs: 120_000,
  stopGraceMs: 5_000,
  // Start-Services.ps1 waited a second after Stop-Services before probing.
  portSettleMs: 1_000
});

export class ServiceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ServiceError";
  }
}

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] base environment for children and config
 * @param {ReturnType<typeof resolveConfig>} [options.config]
 * @param {(line: string) => void} [options.log]
 * @param {Partial<typeof DEFAULT_TIMEOUTS>} [options.timeouts]
 */
export function createServiceManager({ env = process.env, config, log = () => {}, timeouts = {} } = {}) {
  const cfg = config || resolveConfig({ env });
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const pollMs = cfg.pollMs;

  function resolveTranslation(request) {
    if (request.translationModelPath) {
      const modelPath = path.resolve(request.translationModelPath);
      const alias = path.basename(modelPath, path.extname(modelPath));
      return { modelPath, alias, label: alias };
    }
    const id = request.translationModel || "9b-q4km";
    const preset = TRANSLATION_MODELS.find((model) => model.id === id);
    if (!preset) {
      throw new ServiceError(
        `Unknown translation model '${id}'. Known: ${TRANSLATION_MODELS.map((model) => model.id).join(", ")}`
      );
    }
    return { modelPath: translationModelPath(cfg, preset), alias: preset.alias, label: preset.label, preset };
  }

  function requireCommand(name, label) {
    const resolved = resolveServiceCommand(cfg, name, { env });
    if (!resolved.found) {
      throw new ServiceError(`${label} launcher not found. Looked for: ${resolved.tried.join(", ")}`);
    }
    return resolved;
  }

  async function ensureWhisperCppModel(asrModel, signal) {
    const model = whisperCppModel(cfg, asrModel);
    if (fs.existsSync(model.path)) return model.path;
    fs.mkdirSync(path.dirname(model.path), { recursive: true });
    log(`whisper.cpp model ${model.file} missing; downloading ${model.downloadUrl}`);
    const totalBytes = await probeTotalBytes(model.downloadUrl, { signal });
    await downloadToFile({ url: model.downloadUrl, targetPath: model.path, totalBytes, signal });
    log(`whisper.cpp model saved to ${model.path}`);
    return model.path;
  }

  async function failWithLog(spawned, label, port) {
    const lines = tailFile(spawned.stderrPath, 80);
    lines.forEach((line) => log(line));
    const exited = spawned.state.exited
      ? ` (exited with code ${spawned.state.exitCode ?? spawned.state.signal})`
      : "";
    throw new ServiceError(`${label} did not become ready on port ${port}${exited}.`);
  }

  /**
   * Port of Start-Services.ps1. Resolves with a summary object, rejects with
   * ServiceError (or the signal's reason when aborted). Aborting stops the
   * waits and prevents any further spawn; already started children are left
   * for stop() to clean up through their PID files.
   *
   * @param {object} [request]
   * @param {string} [request.asrModel]
   * @param {string} [request.translationModel]
   * @param {string} [request.translationModelPath]
   * @param {boolean} [request.asrOnly]
   * @param {boolean} [request.restart]
   * @param {string} [request.glossary]
   * @param {boolean} [request.translateOnComplete]
   * @param {number} [request.pauseSegmentationSeconds]
   * @param {number} [request.translationMaxSegmentSeconds]
   * @param {{ signal?: AbortSignal }} [control]
   */
  async function start(request = {}, { signal } = {}) {
    const asrOnly = Boolean(request.asrOnly);
    const asrModel = request.asrModel || "large-v3-turbo";
    const glossary = request.glossary || "";
    const ports = cfg.ports;
    const translation = resolveTranslation(request);

    if (!asrOnly && !fs.existsSync(translation.modelPath)) {
      throw new ServiceError(
        `Translation model file not found: ${translation.modelPath}. Download ${translation.label} from https://huggingface.co/IndexTeam first.`
      );
    }
    if (!ASR_MODEL_IDS.includes(asrModel)) {
      throw new ServiceError(`Unknown ASR model '${asrModel}'. Known: ${ASR_MODEL_IDS.join(", ")}`);
    }
    const llama = asrOnly ? null : requireCommand("llama", "Translation (llama-server)");
    const wlk = requireCommand("wlk", "WhisperLiveKit");
    const whisperCpp = cfg.asrBackend === "whisper-cpp" ? requireCommand("whisperCpp", "whisper.cpp (whisper-server)") : null;

    if (request.restart) await stop();

    let translationStatus;
    if (asrOnly) {
      translationStatus = "skipped";
      if (await isPortListening(ports.translation)) {
        log(`WARNING: Port ${ports.translation} is still serving a translation model. Stop it (or use --restart) to free GPU memory.`);
      }
    } else {
      if (!(await isPortListening(ports.translation))) {
        signal?.throwIfAborted();
        const spawned = await spawnService({
          name: SERVICE_NAMES.translation,
          command: llama.command,
          args: [
            ...llama.args,
            ...buildLlamaArgs({
              port: ports.translation,
              alias: translation.alias,
              modelPath: translation.modelPath,
              extraArgs: cfg.llamaExtraArgs
            })
          ],
          cwd: path.isAbsolute(llama.command) ? path.dirname(llama.command) : cfg.root,
          env,
          logsDir: cfg.logsDir,
          runtimeDir: cfg.runtimeDir,
          port: ports.translation,
          platform: cfg.platform
        });
        log(`Started llama-server (PID ${spawned.pid}) on port ${ports.translation} with ${translation.alias}`);
        translationStatus = "started";
        const healthy = await waitForHealth(`http://127.0.0.1:${ports.translation}/health`, {
          timeoutMs: limits.translationHealthMs,
          pollMs,
          signal,
          isDead: () => spawned.state.exited
        });
        if (!healthy) await failWithLog(spawned, "Translation server", ports.translation);
      } else {
        const models = await fetchJson(`http://127.0.0.1:${ports.translation}/v1/models`, 5000);
        const loaded = Array.isArray(models.body?.data)
          ? [...new Set(models.body.data.map((entry) => entry?.id).filter(Boolean))]
          : [];
        if (!loaded.includes(translation.alias)) {
          const detail = models.ok ? `Port ${ports.translation} is serving: ${loaded.join(", ")}` : `HTTP ${models.status}`;
          throw new ServiceError(
            `Port ${ports.translation} is occupied but does not expose ${translation.alias}. Use --restart only after confirming the process is yours. ${detail}`
          );
        }
        translationStatus = "running";
        const healthy = await waitForHealth(`http://127.0.0.1:${ports.translation}/health`, {
          timeoutMs: limits.translationHealthMs,
          pollMs,
          signal
        });
        if (!healthy) throw new ServiceError(`Translation server did not become ready on port ${ports.translation}.`);
      }
    }

    let wlkStatus;
    if (await isPortListening(ports.asr)) {
      const healthy = await waitForHealth(`http://127.0.0.1:${ports.asr}/health`, {
        timeoutMs: limits.existingWlkHealthMs,
        pollMs,
        signal
      });
      if (!healthy) {
        throw new ServiceError(
          `Port ${ports.asr} is occupied but WhisperLiveKit health check failed. Use --restart to replace this project's service.`
        );
      }
      if (asrOnly) {
        throw new ServiceError(
          `WhisperLiveKit is already running on port ${ports.asr} and may still translate. Use --restart to apply ASR-only mode.`
        );
      }
      wlkStatus = "running";
    } else {
      if (whisperCpp && !(await isPortListening(ports.whisperCpp))) {
        const modelPath = await ensureWhisperCppModel(asrModel, signal);
        signal?.throwIfAborted();
        const spawned = await spawnService({
          name: SERVICE_NAMES.whisperCpp,
          command: whisperCpp.command,
          args: [...whisperCpp.args, ...buildWhisperCppArgs({ port: ports.whisperCpp, modelPath })],
          cwd: path.dirname(modelPath),
          env,
          logsDir: cfg.logsDir,
          runtimeDir: cfg.runtimeDir,
          port: ports.whisperCpp,
          platform: cfg.platform
        });
        log(`Started whisper-server (PID ${spawned.pid}) on port ${ports.whisperCpp}`);
        const ready = await waitForPort(ports.whisperCpp, {
          timeoutMs: limits.whisperCppReadyMs,
          pollMs,
          signal,
          isDead: () => spawned.state.exited
        });
        if (!ready) await failWithLog(spawned, "whisper.cpp server", ports.whisperCpp);
      }
      signal?.throwIfAborted();
      const args = buildWlkArgs({
        port: ports.asr,
        asrBackend: cfg.asrBackend,
        asrModel,
        asrOnly,
        translationPort: ports.translation,
        translationAlias: translation.alias,
        glossary,
        translateOnComplete: Boolean(request.translateOnComplete),
        pauseSegmentationSeconds: request.pauseSegmentationSeconds ?? 1.0,
        translationMaxSegmentSeconds: request.translationMaxSegmentSeconds ?? 2.5
      });
      const workdir = fs.existsSync(cfg.wlkWorkdir) ? cfg.wlkWorkdir : cfg.root;
      const spawned = await spawnService({
        name: SERVICE_NAMES.wlk,
        command: wlk.command,
        args: [...wlk.args, ...args],
        cwd: workdir,
        env: buildWlkEnv(env, { asrBackend: cfg.asrBackend, whisperCppPort: ports.whisperCpp }),
        logsDir: cfg.logsDir,
        runtimeDir: cfg.runtimeDir,
        port: ports.asr,
        platform: cfg.platform
      });
      log(`Started WhisperLiveKit (PID ${spawned.pid}) on port ${ports.asr}, backend ${cfg.asrBackend}, model ${asrModel}`);
      const healthy = await waitForHealth(`http://127.0.0.1:${ports.asr}/health`, {
        timeoutMs: limits.wlkHealthMs,
        pollMs,
        signal,
        isDead: () => spawned.state.exited
      });
      if (!healthy) await failWithLog(spawned, "WhisperLiveKit", ports.asr);
      wlkStatus = "started";
    }

    return {
      translation: translationStatus,
      translationPort: asrOnly ? "disabled" : ports.translation,
      translationModel: asrOnly ? "ASR only" : translation.alias,
      wlk: wlkStatus,
      wlkPort: ports.asr,
      wlkBackend: cfg.asrBackend,
      wlkModel: asrModel,
      translationLabel: asrOnly ? "ASR only" : translation.label,
      translationModelPath: asrOnly ? "" : translation.modelPath,
      translateOnComplete: asrOnly ? false : Boolean(request.translateOnComplete),
      glossary: asrOnly ? "" : glossary
    };
  }

  /**
   * Port of Stop-Services.ps1: stops what start() launched (by PID file), then
   * warns about anything still listening on the ports, which this project did
   * not start and therefore leaves alone. Throws only when a kill fails.
   */
  async function stop() {
    const stopped = [];
    const warnings = [];
    // WLK first so it never sees its translation backend vanish mid-request.
    for (const name of [SERVICE_NAMES.wlk, SERVICE_NAMES.whisperCpp, SERVICE_NAMES.translation]) {
      const record = readPidFile(cfg.runtimeDir, name);
      if (!record) {
        removePidFile(cfg.runtimeDir, name);
        continue;
      }
      const outcome = await killServiceTree(record, { platform: cfg.platform, graceMs: limits.stopGraceMs });
      if (outcome === "killed") {
        stopped.push({ service: name, pid: record.pid });
        log(`Stopped ${name} (PID ${record.pid})`);
      } else if (outcome === "foreign") {
        warnings.push(`PID ${record.pid} from ${name}.pid now belongs to another program; left it running.`);
      }
      removePidFile(cfg.runtimeDir, name);
    }
    if (stopped.length) await sleep(limits.portSettleMs);
    for (const port of [cfg.ports.translation, cfg.ports.asr]) {
      if (await isPortListening(port)) {
        warnings.push(`Port ${port} is still listening. It was not stopped because this project did not start it.`);
      }
    }
    warnings.forEach((line) => log(`WARNING: ${line}`));
    return { stopped, warnings };
  }

  async function serviceStatus(name, port, healthPath) {
    const record = readPidFile(cfg.runtimeDir, name);
    const listening = await isPortListening(port);
    const health = listening && healthPath ? await fetchJson(`http://127.0.0.1:${port}${healthPath}`, 2000) : null;
    return {
      port,
      listening,
      healthy: healthPath ? Boolean(health?.ok && health.body?.status === "ok") : listening,
      pid: record && isPidAlive(record.pid) ? record.pid : null
    };
  }

  async function status() {
    const [asr, translation, whisperCpp] = await Promise.all([
      serviceStatus(SERVICE_NAMES.wlk, cfg.ports.asr, "/health"),
      serviceStatus(SERVICE_NAMES.translation, cfg.ports.translation, "/health"),
      cfg.asrBackend === "whisper-cpp" ? serviceStatus(SERVICE_NAMES.whisperCpp, cfg.ports.whisperCpp, "") : null
    ]);
    return { asrBackend: cfg.asrBackend, asr, translation, ...(whisperCpp ? { whisperCpp } : {}) };
  }

  return { config: cfg, start, stop, status };
}
