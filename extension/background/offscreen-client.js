export const OFFSCREEN_URL = "offscreen/offscreen.html";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The worker's side of the offscreen capture document: create it on demand,
 * talk to it, and tell it to stop. The document itself is
 * offscreen/offscreen.js.
 */
export function createOffscreenClient({
  runtime = chrome.runtime,
  offscreen = chrome.offscreen
} = {}) {
  async function hasDocument() {
    const contexts = await runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  }

  async function ensureDocument() {
    if (await hasDocument()) return;
    await offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Capture one tab, play its audio, and stream PCM to local captions."
    });
    await delay(120);
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

  return { hasDocument, ensureDocument, send, stopCapture };
}
