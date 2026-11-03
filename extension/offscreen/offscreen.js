const TARGET_SAMPLE_RATE = 16000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const SERVER_FINISH_TIMEOUT_MS = 10000;
const FINAL_WRITE_TIMEOUT_MS = 5000;

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

function normalizeWsUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new Error("WebSocket 地址必须以 ws:// 或 wss:// 开头");
  }
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/asr";
  }
  if (!url.searchParams.has("target_language")) {
    url.searchParams.set("target_language", "zh");
  }
  return url.toString();
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
    wsConnected: websocket?.readyState === WebSocket.OPEN,
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
  if (!websocket || websocket.readyState !== WebSocket.OPEN || !audioContext) {
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
    if (resampled.length > 0) {
      websocket.send(floatToPCM16(resampled));
    }
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
    peak: Number(peak.toFixed(4))
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
    `${Math.round(delay / 1000)} 秒后重试字幕服务`
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
      `无法解析字幕服务消息：${error.message}`,
      { fatal: true }
    );
    return;
  }

  if (data.type === "config") {
    void publishStatus("capturing", "字幕模型已连接", { serverConfig: data });
    return;
  }
  if (data.type === "error") {
    await publishStatus(
      "error",
      data.error || "字幕服务返回错误",
      { fatal: true }
    );
    return;
  }
  if (data.type === "ready_to_stop") {
    await waitForChain(backgroundWriteChain, 3000);
    markServerFinished();
    await publishStatus("finished", "字幕服务已完成当前音频");
    return;
  }

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

function openWebSocket() {
  if (stopping || !sessionId) return;
  clearReconnectTimer();
  const token = ++connectionToken;
  let socket;
  try {
    socket = new WebSocket(requestedWsUrl);
  } catch (error) {
    void publishStatus("error", `WebSocket 地址无效：${error.message}`);
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
    void publishStatus("capturing", "正在接收实时转写");
  };

  socket.onmessage = (event) => {
    if (token !== connectionToken || socket !== websocket) return;
    serverMessageChain = serverMessageChain
      .then(() => handleServerMessage(event))
      .catch((error) =>
        publishStatus(
          "error",
          `处理字幕服务消息失败：${error?.message || error}`,
          { fatal: true }
        )
      );
  };

  socket.onerror = () => {
    if (token !== connectionToken) return;
    void publishStatus("reconnecting", "字幕服务连接异常");
  };

  socket.onclose = (event) => {
    if (token !== connectionToken) return;
    websocket = null;
    resetPendingAudio();
    if (stopping) return;
    if (serverFinished) {
      void publishStatus("finished", event.reason || "字幕服务已完成当前音频");
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
  requestedWsUrl = normalizeWsUrl(message.wsUrl);
  reconnectAttempts = 0;
  capturedAudioSamples = 0;
  latestAudioStats = null;
  windowPeak = 0;
  captureInfo = null;
  lastDataSignature = "";
  serverFinished = false;
  resamplePosition = 0;
  resampleTail = 0;
  finishWaiter = null;
  await publishStatus("starting", "正在读取标签页音频");

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
    if (!track) throw new Error("标签页没有可用的音频轨道");
    captureInfo = {
      label: track.label,
      settings: track.getSettings(),
      constraints: track.getConstraints()
    };
    track.addEventListener("ended", () => {
      if (stopping) return;
      console.info("[capture-diag] track ended", track.readyState);
      void publishStatus("error", "标签页音频已结束或页面已关闭");
      void stopCapture({ detail: "标签页音频已结束或页面已关闭" });
    });
    // Navigation can leave the track alive but muted (no active media in the
    // tab at that moment), which looks identical to a working capture until
    // the transcripts stop arriving. Report both edges for diagnosis.
    track.addEventListener("muted", () => {
      console.info("[capture-diag] track muted", track.readyState);
      void publishStatus("capturing", "标签页音频暂时静音，等待页面恢复播放", {
        trackMuted: true
      });
    });
    track.addEventListener("unmuted", () => {
      console.info("[capture-diag] track unmuted", track.readyState);
      void publishStatus("capturing", "标签页音频已恢复", { trackMuted: false });
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
    await publishStatus(
      "starting",
      `已捕获 ${track.label || "当前标签页"}，正在连接字幕服务`
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

function stopCapture(options = {}) {
  if (stopPromise) return stopPromise;
  stopPromise = performStopCapture(options).finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}

async function performStopCapture(options = {}) {
  const quiet = options.quiet === true;
  const stopDetail = options.detail || "标签页音频采集已停止";
  const stoppedSessionId = sessionId;
  stopping = true;
  clearReconnectTimer();

  if (websocket?.readyState === WebSocket.OPEN) {
    flushPackets(true);
    try {
      websocket.send(new Uint8Array(0));
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
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  void (async () => {
    try {
      if (message.type === "start-capture") {
        await startCapture(message);
        sendResponse({ ok: true, detail: "音频采集已启动" });
      } else if (message.type === "stop-capture") {
        sendResponse(await stopCapture({ quiet: message.quiet === true }));
      } else if (message.type === "get-offscreen-state") {
        sendResponse({
          ok: true,
          active: Boolean(sessionId),
          sessionId,
          targetTabId,
          wsState: websocket?.readyState ?? null,
          captureInfo,
          audio: latestAudioStats
        });
      } else {
        sendResponse({ ok: false, error: `未知消息：${message.type}` });
      }
    } catch (error) {
      await publishStatus("error", error?.message || String(error));
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});
