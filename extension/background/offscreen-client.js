export const OFFSCREEN_URL = "offscreen/offscreen.html";
// offscreen.js reports ready as soon as its message listener exists, which on
// a warm browser takes a few milliseconds. The timeout only matters when the
// document is slow to load (cold start, busy machine); on expiry the worker
// sends anyway, which is what the fixed 120 ms delay this replaces always did.
export const OFFSCREEN_READY_TIMEOUT_MS = 2000;

/**
 * The worker's side of the offscreen capture document: create it on demand,
 * wait until it can receive messages, talk to it, and tell it to stop. The
 * document itself is offscreen/offscreen.js.
 */
export function createOffscreenClient({
  runtime = chrome.runtime,
  offscreen = chrome.offscreen,
  readyTimeoutMs = OFFSCREEN_READY_TIMEOUT_MS
} = {}) {
  let creating = null;
  let settleReady = null;

  async function hasDocument() {
    const contexts = await runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  }

  /** Resolves true when the document reports ready, false on timeout. */
  function waitForReady() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), readyTimeoutMs);
      function settle(ready) {
        clearTimeout(timer);
        if (settleReady === settle) settleReady = null;
        resolve(ready);
      }
      settleReady = settle;
    });
  }

  async function createIfMissing() {
    if (await hasDocument()) return;
    // Armed before createDocument: the document can report ready before the
    // create promise settles.
    const ready = waitForReady();
    try {
      await offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: "Capture one tab, play its audio, and stream PCM to local captions."
      });
    } catch (error) {
      settleReady?.(false);
      throw error;
    }
    if (!(await ready)) {
      console.warn("声幕音频采集页面未报告就绪，继续尝试连接", { timeoutMs: readyTimeoutMs });
    }
  }

  // Chrome allows one offscreen document per extension, so concurrent callers
  // share a single creation.
  function ensureDocument() {
    if (!creating) {
      creating = createIfMissing().finally(() => {
        creating = null;
      });
    }
    return creating;
  }

  /** The document's "offscreen-ready" message: its listener is registered. */
  function markReady() {
    settleReady?.(true);
  }

  async function send(message) {
    await ensureDocument();
    try {
      return await runtime.sendMessage({ target: "offscreen", ...message });
    } catch (error) {
      throw new Error(`无法联系音频采集页面：${error?.message || error}`, { cause: error });
    }
  }

  /** Stops a running capture; a missing or unresponsive document is only logged. */
  async function stopCapture() {
    try {
      if (await hasDocument()) {
        await runtime.sendMessage({ target: "offscreen", type: "stop-capture", quiet: true });
      }
    } catch (error) {
      console.warn("声幕停止采集时出现错误", error);
    }
  }

  return { hasDocument, ensureDocument, markReady, send, stopCapture };
}
