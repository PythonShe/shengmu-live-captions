const TARGET_SAMPLE_RATE = 16000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const SERVER_FINISH_TIMEOUT_MS = 10000;
const FINAL_WRITE_TIMEOUT_MS = 5000;
// Live packets are dropped while more than this is still queued on the
// socket. PCM16 at 16 kHz is 32,000 bytes per second, so 64 KiB is about two
// seconds of audio: a backlog that size already pushes captions past the
// 1-3 s latency budget, and queueing more would only make them later (and
// grow memory without bound) when WhisperLiveKit or the link falls behind.
const WS_BUFFERED_LIMIT_BYTES = 64 * 1024;

// Offscreen documents get chrome.runtime only, no chrome.i18n. User-facing
// text therefore leaves here as { key, params } messages (the lib/
// i18n-message.js shape) and the worker renders it.
function msg(key, ...params) {
  return { key, params };
}

function localError(key, ...params) {
  return Object.assign(new Error(key), { localMessage: msg(key, ...params) });
}

// What to send for anything thrown: its message when it has one, else text.
function errorPayload(error) {
  return error?.localMessage || error?.message || String(error);
}

let sessionId = null;
let targetTabId = null;
let requestedWsUrl = "";
let stopping = false;
let audioContext = null;
let mediaStream = null;
let workletNode = null;
let monitorGain = null;
let silentGain = null;
let keepAlive = null;
let keepAliveGain = null;
let websocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let pendingSamples = [];
let pendingLength = 0;
let packetSamples = TARGET_SAMPLE_RATE / 10;
let captureStartedAt = 0;
let capturedAudioSamples = 0;
let droppedPackets = 0;
let droppedSamples = 0;
let latestAudioStats = null;
let windowPeak = 0;
let epochId = null;
let epochStartedAt = 0;
let connectionToken = 0;
let lastDataSignature = "";
let captureInfo = null;
let audioStatsTimer = null;
let serverFinished = false;
let resamplePosition = 0;
// Last input sample of the previous chunk: the carried position can land
// between it and the next chunk's first sample (index -1).
let resampleTail = 0;
let finishWaiter = null;
let stopPromise = null;
let serverMessageChain = Promise.resolve();
let backgroundWriteChain = Promise.resolve();
// The speech backend of this capture: { backend: "wlk", wsUrl } (the local
// WhisperLiveKit), { backend: "bailian", url, context } or
// { backend: "chrome", lang, phrases }. Only the last two load extra modules.
let asrConfig = null;
let asrLib = null;
let speechSession = null;
let bailianTaskId = null;
let bailianStarted = false;
let bailianLines = null;
let translatorPromise = null;

function normalizeWsUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw localError("ws_url_protocol");
  }
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/asr";
  }
  if (!url.searchParams.has("target_language")) {
    url.searchParams.set("target_language", "zh");
  }
  return url.toString();
}

function normalizeAsr(message) {
  const asr = message.asr || { backend: "wlk", wsUrl: message.wsUrl };
  if (asr.backend === "chrome") {
    return { backend: "chrome", lang: asr.lang || "en-US", phrases: Array.isArray(asr.phrases) ? asr.phrases : [] };
  }
  if (asr.backend === "bailian") {
    const url = new URL(String(asr.url || ""));
    if (url.protocol !== "wss:") throw localError("bailian_url_not_wss");
    return { backend: "bailian", url: url.toString(), context: String(asr.context || "") };
  }
  return { backend: "wlk", wsUrl: normalizeWsUrl(asr.wsUrl) };
}

// Audio may only go out once the server accepts it: Bailian rejects audio
// sent before its task-started event.
function transportReady() {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) return false;
  return asrConfig?.backend !== "bailian" || bailianStarted;
}

async function sendToBackground(type, payload = {}) {
  try {
    await chrome.runtime.sendMessage({
      target: "background",
      source: "offscreen",
      type,
      ...payload
    });
  } catch (error) {
    console.warn("声幕后台消息发送失败", error);
  }
}

function enqueueBackgroundWrite(type, payload = {}) {
  const task = backgroundWriteChain.then(() => sendToBackground(type, payload));
  backgroundWriteChain = task.catch(() => {});
  return task;
}

async function waitForChain(chain, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([chain, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function publishStatus(state, detail, extra = {}) {
  const status = {
    state,
    detail,
    // The Chrome backend has no socket: a running recognizer is its link.
    wsConnected: Boolean(speechSession) || websocket?.readyState === WebSocket.OPEN,
    audio: latestAudioStats,
    captureInfo,
    updatedAt: Date.now(),
    ...extra
  };
  await sendToBackground("status-report", { sessionId, status });
}

function floatToPCM16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(
      index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true
    );
  }
  return buffer;
}

function resampleLinear(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate || samples.length === 0) return samples;
  const ratio = sourceRate / targetRate;
  const output = [];
  let position = resamplePosition;
  while (position < samples.length - 1) {
    const lower = Math.floor(position);
    const fraction = position - lower;
    const base = lower < 0 ? resampleTail : samples[lower];
    output.push(base * (1 - fraction) + samples[lower + 1] * fraction);
    position += ratio;
  }
  resampleTail = samples[samples.length - 1];
  resamplePosition = position - samples.length;
  return Float32Array.from(output);
}

function appendSamples(samples) {
  if (samples.length === 0) return;
  capturedAudioSamples += samples.length;
  // Peak is the only honest silence signal: a muted tabCapture track still
  // delivers a full-rate stream of zeroed frames, so deliveredRatio cannot
  // tell "page went quiet" apart from "capture was interrupted".
  for (let index = 0; index < samples.length; index += 1) {
    const amplitude = samples[index] < 0 ? -samples[index] : samples[index];
    if (amplitude > windowPeak) windowPeak = amplitude;
  }
  pendingSamples.push(samples);
  pendingLength += samples.length;
  flushPackets(false);
}

function takeSamples(count) {
  const output = new Float32Array(count);
  let written = 0;
  while (written < count && pendingSamples.length > 0) {
    const chunk = pendingSamples[0];
    const needed = count - written;
    if (chunk.length <= needed) {
      output.set(chunk, written);
      written += chunk.length;
      pendingSamples.shift();
    } else {
      output.set(chunk.subarray(0, needed), written);
      pendingSamples[0] = chunk.subarray(needed);
      written += needed;
    }
  }
  pendingLength -= written;
  return output;
}

function flushPackets(force) {
  if (!transportReady() || !audioContext) {
    pendingSamples = [];
    pendingLength = 0;
    return;
  }
  if (!force && pendingLength < packetSamples) return;
  while (pendingLength > 0 && (force || pendingLength >= packetSamples)) {
    const sampleCount = force
      ? pendingLength
      : Math.min(pendingLength, packetSamples);
    if (!force && sampleCount < 160) return;
    const samples = takeSamples(sampleCount);
    const resampled = resampleLinear(
      samples,
      audioContext.sampleRate,
      TARGET_SAMPLE_RATE
    );
    if (resampled.length === 0) continue;
    // The final flush on stop is never dropped: it carries the end of the
    // last sentence. It is at most one packet, so it cannot grow the backlog.
    if (!force && websocket.bufferedAmount > WS_BUFFERED_LIMIT_BYTES) {
      droppedPackets += 1;
      droppedSamples += resampled.length;
      continue;
    }
    websocket.send(floatToPCM16(resampled));
  }
}

function resetPendingAudio() {
  pendingSamples = [];
  pendingLength = 0;
  resamplePosition = 0;
  resampleTail = 0;
}

function updateAudioStats() {
  if (!audioContext) return;
  const wallSeconds = (performance.now() - captureStartedAt) / 1000;
  const audioSeconds = capturedAudioSamples / audioContext.sampleRate;
  const track = mediaStream?.getAudioTracks()[0] || null;
  const peak = windowPeak;
  windowPeak = 0;
  latestAudioStats = {
    audioSeconds,
    wallSeconds,
    deliveredRatio: wallSeconds > 0 ? audioSeconds / wallSeconds : null,
    sampleRate: audioContext.sampleRate,
    state: audioContext.state,
    trackState: track?.readyState || "",
    trackMuted: Boolean(track?.muted),
    peak: Number(peak.toFixed(4)),
    // Audio withheld from the ASR because the socket was backed up; see
    // WS_BUFFERED_LIMIT_BYTES.
    droppedPackets,
    droppedSeconds: Number((droppedSamples / TARGET_SAMPLE_RATE).toFixed(2)),
    wsBufferedBytes: websocket?.bufferedAmount ?? 0
  };
  void sendToBackground("audio-stats", {
    sessionId,
    audio: latestAudioStats
  });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function markServerFinished() {
  serverFinished = true;
  if (finishWaiter) {
    const resolve = finishWaiter;
    finishWaiter = null;
    resolve(true);
  }
}

function waitForServerFinished(timeoutMs) {
  if (serverFinished) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (finishWaiter === onFinished) finishWaiter = null;
      resolve(false);
    }, timeoutMs);
    const onFinished = (finished) => {
      clearTimeout(timer);
      resolve(finished);
    };
    finishWaiter = onFinished;
  });
}

function scheduleReconnect() {
  if (stopping || !sessionId || reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[
    Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)
  ];
  reconnectAttempts += 1;
  void publishStatus(
    "reconnecting",
    msg("offscreen_retry_in", Math.round(delay / 1000))
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openWebSocket();
  }, delay);
}

async function handleServerMessage(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (error) {
    await publishStatus(
      "error",
      msg("offscreen_unparsable_message", error.message),
      { fatal: true }
    );
    return;
  }

  if (data.type === "config") {
    void publishStatus("capturing", msg("offscreen_model_connected"), { serverConfig: data });
    return;
  }
  if (data.type === "error") {
    await publishStatus(
      "error",
      data.error || msg("offscreen_server_error"),
      { fatal: true }
    );
    return;
  }
  if (data.type === "ready_to_stop") {
    await waitForChain(backgroundWriteChain, 3000);
    markServerFinished();
    await publishStatus("finished", msg("offscreen_server_finished"));
    return;
  }

  await emitTranscript(data);
}

async function emitTranscript(data) {
  const signature = JSON.stringify({
    lines: data.lines,
    bufferTranscription: data.buffer_transcription,
    bufferTranslation: data.buffer_translation,
    translationError: data.translation_error
  });
  if (signature === lastDataSignature) return;
  lastDataSignature = signature;

  await enqueueBackgroundWrite("transcript-update", {
    sessionId,
    epochId,
    epochStartedAt,
    data
  });
}

async function handleBailianMessage(event) {
  if (typeof event.data !== "string") return;
  const parsed = asrLib.parseBailianEvent(event.data);
  if (parsed.kind === "started") {
    bailianStarted = true;
    void publishStatus("capturing", msg("offscreen_bailian_connected"));
    return;
  }
  if (parsed.kind === "finished") {
    await waitForChain(backgroundWriteChain, 3000);
    markServerFinished();
    await publishStatus("finished", msg("offscreen_bailian_finished"));
    return;
  }
  if (parsed.kind === "failed") {
    // The server closes the socket after a failed task; a reconnect would
    // fail the same way (bad key, no quota), so the capture ends instead.
    markServerFinished();
    await publishStatus("error", asrLib.bailianErrorDetail(parsed.code, parsed.message), { fatal: true });
    return;
  }
  if (parsed.kind !== "sentence") return;
  if (parsed.final) {
    bailianLines.final(parsed.text, parsed.beginSeconds, parsed.endSeconds ?? parsed.beginSeconds);
  } else {
    bailianLines.interim(parsed.text);
  }
  await emitTranscript(bailianLines.message());
}

function openWebSocket() {
  if (stopping || !sessionId) return;
  clearReconnectTimer();
  const token = ++connectionToken;
  let socket;
  try {
    socket = new WebSocket(requestedWsUrl);
  } catch (error) {
    void publishStatus("error", msg("offscreen_ws_url_invalid", error.message));
    scheduleReconnect();
    return;
  }
  websocket = socket;
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    if (token !== connectionToken || socket !== websocket) return;
    reconnectAttempts = 0;
    epochId = crypto.randomUUID();
    epochStartedAt = Date.now();
    lastDataSignature = "";
    serverFinished = false;
    serverMessageChain = Promise.resolve();
    backgroundWriteChain = Promise.resolve();
    resetPendingAudio();
    if (asrConfig?.backend === "bailian") {
      bailianStarted = false;
      bailianTaskId = crypto.randomUUID().replaceAll("-", "");
      bailianLines = asrLib.createLineAccumulator();
      socket.send(JSON.stringify(asrLib.bailianRunTask({ taskId: bailianTaskId, context: asrConfig.context })));
      void publishStatus("starting", msg("offscreen_bailian_starting"));
      return;
    }
    void publishStatus("capturing", msg("offscreen_receiving"));
  };

  socket.onmessage = (event) => {
    if (token !== connectionToken || socket !== websocket) return;
    const handle = asrConfig?.backend === "bailian" ? handleBailianMessage : handleServerMessage;
    serverMessageChain = serverMessageChain
      .then(() => handle(event))
      .catch((error) =>
        publishStatus(
          "error",
          msg("offscreen_message_failed", errorPayload(error)),
          { fatal: true }
        )
      );
  };

  socket.onerror = () => {
    if (token !== connectionToken) return;
    void publishStatus("reconnecting", msg("offscreen_connection_problem"));
  };

  socket.onclose = (event) => {
    if (token !== connectionToken) return;
    websocket = null;
    resetPendingAudio();
    if (stopping) return;
    if (serverFinished) {
      void publishStatus("finished", event.reason || msg("offscreen_server_finished"));
      return;
    }
    scheduleReconnect();
  };
}

async function cleanupAudio() {
  if (audioStatsTimer) {
    clearInterval(audioStatsTimer);
    audioStatsTimer = null;
  }
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (monitorGain) {
    monitorGain.disconnect();
    monitorGain = null;
  }
  if (silentGain) {
    silentGain.disconnect();
    silentGain = null;
  }
  if (keepAlive) {
    try {
      keepAlive.stop();
    } catch {
      // The oscillator may already have stopped.
    }
    keepAlive.disconnect();
    keepAlive = null;
  }
  if (keepAliveGain) {
    keepAliveGain.disconnect();
    keepAliveGain = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  resetPendingAudio();
}

async function startCapture(message) {
  await stopCapture({ quiet: true });
  stopping = false;
  sessionId = message.sessionId;
  targetTabId = message.targetTabId;
  asrConfig = normalizeAsr(message);
  requestedWsUrl = asrConfig.wsUrl || asrConfig.url || "";
  asrLib = asrConfig.backend === "wlk"
    ? null
    : await import(chrome.runtime.getURL("lib/asr-sessions.js"));
  reconnectAttempts = 0;
  capturedAudioSamples = 0;
  droppedPackets = 0;
  droppedSamples = 0;
  latestAudioStats = null;
  windowPeak = 0;
  captureInfo = null;
  lastDataSignature = "";
  serverFinished = false;
  resamplePosition = 0;
  resampleTail = 0;
  finishWaiter = null;
  await publishStatus("starting", msg("offscreen_reading_audio"));

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId
        }
      },
      video: false
    });
    const track = mediaStream.getAudioTracks()[0];
    if (!track) throw localError("offscreen_no_audio_track");
    captureInfo = {
      label: track.label,
      settings: track.getSettings(),
      constraints: track.getConstraints()
    };
    track.addEventListener("ended", () => {
      if (stopping) return;
      console.info("[capture-diag] track ended", track.readyState);
      void publishStatus("error", msg("offscreen_track_ended"));
      void stopCapture({ detail: msg("offscreen_track_ended") });
    });
    // Navigation can leave the track alive but muted (no active media in the
    // tab at that moment), which looks identical to a working capture until
    // the transcripts stop arriving. Report both edges for diagnosis.
    track.addEventListener("muted", () => {
      console.info("[capture-diag] track muted", track.readyState);
      void publishStatus("capturing", msg("offscreen_track_muted"), {
        trackMuted: true
      });
    });
    track.addEventListener("unmuted", () => {
      console.info("[capture-diag] track unmuted", track.readyState);
      void publishStatus("capturing", msg("offscreen_track_unmuted"), { trackMuted: false });
    });

    // Monitor at the device rate and resample only the ASR stream.
    audioContext = new AudioContext({ latencyHint: "interactive" });
    await audioContext.audioWorklet.addModule(
      chrome.runtime.getURL("offscreen/pcm-worklet.js")
    );
    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm-tap", {
      channelCount: 1,
      channelCountMode: "explicit",
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    monitorGain = audioContext.createGain();
    monitorGain.gain.value = 1;
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    keepAlive = audioContext.createOscillator();
    keepAlive.frequency.value = 20;
    keepAliveGain = audioContext.createGain();
    keepAliveGain.gain.value = 0.00001;

    source.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    source.connect(monitorGain);
    monitorGain.connect(audioContext.destination);
    keepAlive.connect(keepAliveGain);
    keepAliveGain.connect(audioContext.destination);
    keepAlive.start();
    await audioContext.resume();

    packetSamples = Math.max(160, Math.round(audioContext.sampleRate / 10));
    captureStartedAt = performance.now();
    workletNode.port.onmessage = (event) => {
      appendSamples(new Float32Array(event.data));
    };
    audioStatsTimer = setInterval(updateAudioStats, 1000);

    captureInfo.contextSampleRate = audioContext.sampleRate;
    captureInfo.packetSamples = packetSamples;
    captureInfo.asrBackend = asrConfig.backend;
    if (asrConfig.backend === "chrome") {
      // The recognizer gets its own copy of the audio from the graph, the
      // route the Chrome 155 probe verified.
      const speechOutput = audioContext.createMediaStreamDestination();
      source.connect(speechOutput);
      await startWebSpeech(speechOutput.stream.getAudioTracks()[0]);
      return;
    }
    await publishStatus(
      "starting",
      msg("offscreen_captured_connecting", track.label || msg("offscreen_this_tab"))
    );
    openWebSocket();
  } catch (error) {
    stopping = true;
    clearReconnectTimer();
    if (websocket) {
      try {
        websocket.close();
      } catch {
        // Ignore close races.
      }
      websocket = null;
    }
    await cleanupAudio();
    throw error;
  }
}

async function startWebSpeech(track) {
  const speech = await import(chrome.runtime.getURL("offscreen/web-speech.js"));
  await speech.prepareWebSpeech({
    lang: asrConfig.lang,
    onStatus: (detail) => void publishStatus("starting", detail)
  });
  epochId = crypto.randomUUID();
  epochStartedAt = Date.now();
  lastDataSignature = "";
  backgroundWriteChain = Promise.resolve();
  speechSession = speech.createWebSpeechSession({
    track,
    lang: asrConfig.lang,
    phrases: asrConfig.phrases,
    onMessage: (data) => void emitTranscript(data),
    onFatal: (detail) => void publishStatus("error", detail, { fatal: true })
  });
  await publishStatus("capturing", msg("offscreen_using_chrome_speech"));
}

function stopCapture(options = {}) {
  if (stopPromise) return stopPromise;
  stopPromise = performStopCapture(options).finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}

async function performStopCapture(options = {}) {
  const quiet = options.quiet === true;
  const stopDetail = options.detail || msg("session_capture_stopped");
  const stoppedSessionId = sessionId;
  stopping = true;
  clearReconnectTimer();

  if (speechSession) {
    await speechSession.stop();
    speechSession = null;
    await waitForChain(backgroundWriteChain, FINAL_WRITE_TIMEOUT_MS);
  }
  if (websocket?.readyState === WebSocket.OPEN && transportReady()) {
    flushPackets(true);
    try {
      // WhisperLiveKit ends on an empty frame, Bailian on finish-task.
      websocket.send(
        asrConfig?.backend === "bailian"
          ? JSON.stringify(asrLib.bailianFinishTask(bailianTaskId))
          : new Uint8Array(0)
      );
    } catch {
      // The socket may have closed between the state check and send.
    }
    const finished = await waitForServerFinished(SERVER_FINISH_TIMEOUT_MS);
    if (finished) {
      await waitForChain(serverMessageChain, FINAL_WRITE_TIMEOUT_MS);
      await waitForChain(backgroundWriteChain, FINAL_WRITE_TIMEOUT_MS);
    } else {
      await waitForChain(serverMessageChain, 1000);
      await waitForChain(backgroundWriteChain, 1000);
    }
  }
  if (websocket) {
    try {
      websocket.close(1000, "capture stopped");
    } catch {
      // Ignore close races.
    }
    websocket = null;
  }
  // Invalidate late callbacks only after the final server messages were handled.
  connectionToken += 1;

  await cleanupAudio();
  if (!quiet && stoppedSessionId) {
    sessionId = stoppedSessionId;
    await publishStatus("stopped", stopDetail);
  }
  sessionId = null;
  targetTabId = null;
  requestedWsUrl = "";
  captureInfo = null;
  latestAudioStats = null;
  lastDataSignature = "";
  serverFinished = false;
  resamplePosition = 0;
  resampleTail = 0;
  finishWaiter = null;
  serverMessageChain = Promise.resolve();
  backgroundWriteChain = Promise.resolve();
  epochId = null;
  epochStartedAt = 0;
  asrConfig = null;
  bailianTaskId = null;
  bailianStarted = false;
  bailianLines = null;
  return { ok: true };
}

// Chrome's built-in Translator exists in documents only, so the worker asks
// here. Creating it needs a user gesture while the model is still
// downloadable; the popup's download button supplies that once.
function builtinTranslator() {
  if (!translatorPromise) {
    translatorPromise = (async () => {
      if (!globalThis.Translator) {
        throw Object.assign(localError("offscreen_no_translator"), {
          code: "builtin_unavailable"
        });
      }
      const languages = { sourceLanguage: "en", targetLanguage: "zh" };
      const availability = await Translator.availability(languages);
      if (availability !== "available") {
        throw Object.assign(
          localError("offscreen_translator_not_downloaded"),
          { code: "builtin_unavailable" }
        );
      }
      return Translator.create(languages);
    })().catch((error) => {
      translatorPromise = null;
      throw error;
    });
  }
  return translatorPromise;
}

async function builtinTranslate(texts) {
  const translator = await builtinTranslator();
  const translations = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    translations.push(await translator.translate(String(text)));
  }
  return translations;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  void (async () => {
    try {
      if (message.type === "start-capture") {
        await startCapture(message);
        sendResponse({ ok: true, detail: msg("offscreen_capture_started") });
      } else if (message.type === "builtin-translate") {
        try {
          sendResponse({ ok: true, translations: await builtinTranslate(message.texts) });
        } catch (error) {
          sendResponse({ ok: false, error: errorPayload(error), code: error?.code || "api_error" });
        }
        return;
      } else if (message.type === "stop-capture") {
        sendResponse(await stopCapture({ quiet: message.quiet === true }));
      } else if (message.type === "get-offscreen-state") {
        sendResponse({
          ok: true,
          active: Boolean(sessionId),
          sessionId,
          targetTabId,
          wsState: websocket?.readyState ?? null,
          asrBackend: asrConfig?.backend ?? null,
          captureInfo,
          audio: latestAudioStats
        });
      } else {
        sendResponse({ ok: false, error: msg("error_unknown_message", message.type) });
      }
    } catch (error) {
      await publishStatus("error", errorPayload(error));
      sendResponse({ ok: false, error: errorPayload(error) });
    }
  })();
  return true;
});

// The worker holds its first message until this arrives, so it must go out
// only after the listener above is registered.
void sendToBackground("offscreen-ready");
