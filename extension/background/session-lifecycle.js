import { EMPTY_RUNTIME_STATE, normalizeWsUrl } from "../lib/caption-utils.js";
import { translationConfigIssue } from "../lib/translation-api.js";
import { linesChangedSince, reduceTranscriptUpdate } from "../lib/transcript-reducer.js";
import { TRANSLATION_STOP_TIMEOUT_MS } from "../lib/translation-scheduler.js";
import { requireLocalTranslation } from "./diagnostics.js";
import { safeClone } from "./runtime-store.js";

/** An error stop gives in-flight translations less time than a user stop. */
const ERROR_STOP_TIMEOUT_MS = 2500;

/**
 * @typedef {object} SessionLifecycleDeps
 * @property {any} store runtime-store.js
 * @property {any} settings settings-store.js
 * @property {any} views views.js
 * @property {any} offscreen offscreen-client.js
 * @property {any} history history-sync.js
 * @property {any} scheduler lib/translation-scheduler.js
 * @property {() => Promise<void>} ready The worker's initialize().
 * @property {{ grant: (url: string, apiKey: string) => Promise<void>, revoke: () => Promise<void> }} [asrAuth]
 *   asr-auth.js: the Bailian handshake header.
 */

const NO_ASR_AUTH = { grant: async () => {}, revoke: async () => {} };

/**
 * One capture session from start to its single finalize: start and stop
 * requests, the offscreen document's status, transcript and audio reports,
 * and recovery after the worker was recycled.
 *
 * @param {SessionLifecycleDeps} deps
 */
export function createSessionLifecycle({
  store,
  settings,
  views,
  offscreen,
  history,
  scheduler,
  ready,
  asrAuth = NO_ASR_AUTH
}) {
  let finalizingPromise = null;
  // Set when finalize starts its final history flush, cleared when it ends.
  // A transcript update that lands before the seal (while settle waits for
  // translations) is applied, recorded and counted by that flush. One that
  // lands after it is dropped: the summary is already being computed from
  // IndexedDB, and the scheduler generation bump at the same point already
  // discards every translation result from then on, so applying the update
  // would only write rows the session summary never counts. The offscreen
  // document drains its final server messages before it answers the stop, so
  // what arrives this late is a stray message from a capture whose stop timed
  // out.
  let historySealed = false;
  // Two start requests (double click, popup plus shortcut) would both pass the
  // `active` check before either replaced the runtime state and leave an
  // orphaned session, so starts run one at a time and the later one wins.
  let startQueue = Promise.resolve();

  /** Persists the caption state and pushes it to every view and the history queue. */
  async function publishCaptions(extra = {}) {
    await store.persist();
    await views.broadcastToExtension({
      type: "caption-state",
      ...extra,
      lineCount: store.state.lineCount
    });
    await views.broadcastCaptionState();
    await history.flush(false);
  }

  function start(message) {
    const run = startQueue.then(() => startNow(message));
    startQueue = run.catch(() => {});
    return run;
  }

  async function startNow(message) {
    await ready();
    if (store.state.active) {
      await stop({ quiet: true });
    }

    let wsUrl;
    try {
      wsUrl = normalizeWsUrl(message.wsUrl || settings.current.wsUrl);
    } catch (error) {
      throw new Error(error?.message || String(error), { cause: error });
    }
    await settings.update({ wsUrl });

    const translation = settings.translationConfig();
    if (translation.mode === "api") {
      const issue = translationConfigIssue(translation);
      if (issue) {
        throw new Error(
          `${issue}。请在扩展控制面板的“翻译引擎”中完成配置，或切换为本地服务端。`
        );
      }
    } else {
      await requireLocalTranslation();
    }
    const asr = settings.sessionAsr(wsUrl);
    if (asr.backend === "bailian") {
      const apiKey = settings.bailianApiKey();
      if (!apiKey) {
        throw new Error("尚未填写阿里云百炼 API Key（语音识别与通义千问翻译共用），请在扩展控制面板中填写。");
      }
      await asrAuth.grant(asr.url, apiKey);
    }

    const sessionId = crypto.randomUUID();
    const startedAt = Date.now();
    const metadata = {
      id: sessionId,
      startedAt,
      title: message.tabTitle || "未命名直播",
      url: message.tabUrl || "",
      tabId: message.targetTabId ?? null,
      wsUrl,
      asrBackend: asr.backend,
      translationMode: translation.mode,
      translationProvider: translation.mode === "api" ? translation.provider : "",
      translationModel: translation.mode === "api" ? translation.model : "",
      status: "starting",
      lineCount: 0,
      preview: ""
    };
    history.resetSession();
    scheduler.reset();
    await history.createSession(metadata);

    store.replace({
      active: true,
      status: "starting",
      detail: "正在建立音频采集",
      sessionId,
      tabId: message.targetTabId ?? null,
      tabTitle: metadata.title,
      tabUrl: metadata.url,
      startedAt,
      updatedAt: startedAt,
      current: structuredClone(EMPTY_RUNTIME_STATE.current)
    });
    scheduler.refreshSummary();
    await store.persist(true);
    await views.updateBadge();
    await views.broadcastToExtension({ type: "session-state", session: metadata });
    await views.notifyHistoryChanged(sessionId);

    try {
      const result = await offscreen.send({
        type: "start-capture",
        sessionId,
        targetTabId: message.targetTabId,
        streamId: message.streamId,
        asr
      });
      if (!result?.ok) throw new Error(result?.error || "音频采集启动失败");
    } catch (error) {
      await finalize("error", error?.message || String(error), { quiet: true });
      throw error;
    }

    if (settings.current.overlayEnabled) {
      await views.injectOverlay(store.state.tabId);
    }
    let warning = "";
    if (settings.current.openPanelOnStart) {
      try {
        await views.openMonitorWindow();
      } catch (error) {
        warning = `字幕窗口未能自动打开：${error?.message || error}`;
        store.state.detail = warning;
        store.state.updatedAt = Date.now();
        await store.persist(true);
        await views.broadcastToExtension({ type: "session-state" });
      }
    }
    return { ok: true, sessionId, warning };
  }

  // Runs once per session: concurrent callers (stop button, offscreen
  // "stopped" report, tab closed) share the same promise.
  async function finalize(status, detail, options = {}) {
    if (finalizingPromise) return finalizingPromise;
    finalizingPromise = (async () => {
      const sessionId = store.state.sessionId;
      let finalStatus = status;
      let finalDetail = detail || store.state.detail;
      let lineCount = store.state.lineCount || 0;
      let translationMissing = 0;
      let preview =
        store.state.current?.lines?.at(-1)?.translation ||
        store.state.current?.lines?.at(-1)?.source ||
        "";

      try {
        try {
          await scheduler.settle(
            finalStatus === "error" ? ERROR_STOP_TIMEOUT_MS : TRANSLATION_STOP_TIMEOUT_MS
          );
          // Invalidate any request that outlived the stop deadline so it
          // cannot write history after the final flush/summary.
          historySealed = true;
          scheduler.invalidate();
          await history.flush(true);
        } catch (error) {
          finalStatus = "error";
          finalDetail = `字幕历史写入失败：${error?.message || error}`;
        }

        if (sessionId) {
          try {
            const summary = await history.summarize(sessionId);
            lineCount = summary.lineCount;
            translationMissing = summary.translationMissing;
            preview = summary.preview || preview;
            if (translationMissing > 0 && finalStatus === "stopped") {
              finalStatus = "incomplete";
              finalDetail = `${finalDetail}；${translationMissing} 条字幕缺少译文`;
            }
            await history.updateSession(sessionId, {
              endedAt: Date.now(),
              status: finalStatus,
              lineCount,
              translationMissing,
              preview
            });
          } catch (error) {
            finalStatus = "error";
            finalDetail = `字幕历史收尾失败：${error?.message || error}`;
          }
        }
      } finally {
        store.state.active = false;
        store.state.status = finalStatus;
        store.state.detail = finalDetail || store.state.detail;
        // The overlay failure belongs to the session that just ended; keeping
        // it would leave a stale warning in the popup and a tabId to re-inject
        // into.
        store.state.overlayError = "";
        store.state.wsConnected = false;
        store.state.lineCount = lineCount;
        store.state.translationMissing = translationMissing;
        store.state.pendingStopDetail = "";
        store.state.updatedAt = Date.now();
        try {
          await store.persist(true);
          await views.updateBadge();
        } catch (error) {
          console.error("声幕运行状态收尾失败", error);
        }
        if (!options.quiet) {
          await views.broadcastToExtension({
            type: "session-ended",
            status: finalStatus,
            detail: store.state.detail
          });
          await views.broadcastCaptionState();
        }
        if (sessionId) await views.notifyHistoryChanged(sessionId);
        scheduler.reset({ keepUsage: true });
        historySealed = false;
        await asrAuth.revoke();
      }
    })();
    try {
      return await finalizingPromise;
    } finally {
      finalizingPromise = null;
    }
  }

  async function stop(options = {}) {
    await ready();
    if (!store.state.active && !(await offscreen.hasDocument())) {
      return { ok: true, alreadyStopped: true };
    }
    if (store.state.active) {
      // Kept in runtime state: if the worker is recycled before the offscreen
      // "stopped" report arrives, that report still ends the session with the
      // reason the user saw (tab closed, fatal error) instead of a generic one.
      store.state.pendingStopDetail = options.detail || "标签页音频采集已停止";
      await store.persist(true);
    }
    await offscreen.stopCapture();
    // The offscreen document outlives its session, so a stale stop button can
    // land here after finalize already ran; finalizing again would overwrite
    // the ended session's status and endedAt.
    if (!store.state.active && !finalizingPromise) {
      return { ok: true, alreadyStopped: true };
    }
    await finalize(
      options.status || "stopped",
      store.state.pendingStopDetail || options.detail || "标签页音频采集已停止",
      { quiet: options.quiet === true }
    );
    return { ok: true };
  }

  async function handleStatusReport(message) {
    if (message.sessionId && store.state.sessionId && message.sessionId !== store.state.sessionId) {
      return;
    }
    const status = message.status || {};
    if (!store.state.active) return;
    store.state.status = status.state || store.state.status;
    store.state.detail = status.detail || store.state.detail;
    store.state.wsConnected = Boolean(status.wsConnected);
    store.state.audio = status.audio || store.state.audio;
    store.state.captureInfo = status.captureInfo || store.state.captureInfo;
    store.state.updatedAt = status.updatedAt || Date.now();
    await store.persist();
    await views.updateBadge();
    await views.broadcastToExtension({ type: "status", status: safeClone(status) });
    await views.broadcastCaptionState();

    if (status.state === "error" && status.fatal && store.state.active) {
      await stop({
        status: "error",
        detail: status.detail || "字幕服务发生致命错误"
      });
      return;
    }
    if (status.state === "stopped" && store.state.active) {
      await finalize("stopped", store.state.pendingStopDetail || status.detail || "采集已停止");
    }
  }

  async function handleTranscriptUpdate(message) {
    if (!store.state.active || message.sessionId !== store.state.sessionId) return;
    if (historySealed) {
      console.warn("声幕会话正在收尾，已丢弃迟到的转写", {
        sessionId: message.sessionId,
        epochId: message.epochId || null,
        reason: "history-sealed"
      });
      return { dropped: "history-sealed" };
    }
    const apiConfig = settings.translationConfig();
    const useApi = apiConfig.mode === "api" && apiConfig.enabled;
    const next = reduceTranscriptUpdate(store.state, message, {
      knownLines: history.knownLines,
      useApi,
      apiError: scheduler.lastError,
      now: Date.now()
    });
    history.record(next.historyLines);
    Object.assign(store.state, next.patch);
    scheduler.refreshSummary();

    if (useApi && next.bufferChanged) scheduler.abortStaleBuffer();

    await publishCaptions({ epochId: message.epochId });

    // Once a stop began, settle drives the remaining line translations itself,
    // and the unfinished buffer is display-only for a session that is ending;
    // a timer armed here would only start a request that finalize aborts.
    if (useApi && !finalizingPromise) {
      scheduler.scheduleLines();
      scheduler.scheduleBuffer();
    }
  }

  async function handleAudioStats(message) {
    if (message.sessionId && message.sessionId !== store.state.sessionId) return;
    store.state.audio = message.audio || store.state.audio;
    store.state.updatedAt = Date.now();
    await views.broadcastToExtension({ type: "audio-stats", audio: safeClone(store.state.audio) });
    await store.persist();
  }

  /** Keeps the session title and URL in step with the captured tab. */
  async function refreshSourceMetadata(tabId) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
    const title = String(tab.title || store.state.tabTitle || "未命名直播");
    const url = String(tab.url || store.state.tabUrl || "");
    if (title === store.state.tabTitle && url === store.state.tabUrl) return;

    store.state.tabTitle = title;
    store.state.tabUrl = url;
    store.state.updatedAt = Date.now();
    if (store.state.sessionId) {
      await history.updateSession(store.state.sessionId, {
        title,
        url,
        updatedAt: store.state.updatedAt
      });
    }
    await store.persist(true);
    await views.broadcastToExtension({ type: "session-state" });
  }

  /**
   * The worker was (re)started with a persisted runtime state: end a session
   * whose capture document is gone, or resume translating one that survived.
   * Safe to call more than once.
   */
  async function recover() {
    await views.updateBadge();
    if (!store.state.active) return;
    // A recycled worker lost its history queue and its copy of every row it
    // wrote. Re-record the persisted rows, so a translation that landed just
    // before the restart still reaches IndexedDB and the final summary even
    // if no further transcript update arrives. Rows go through knownLines, so
    // a second recovery or the next identical transcript update writes
    // nothing again; history upserts by line id, so a row that was already
    // flushed is merely rewritten with the same content.
    const restored = linesChangedSince(store.state.current?.lines || [], history.knownLines);
    if (restored.length > 0) {
      history.record(restored);
      await history.flush(false);
    }
    if (!(await offscreen.hasDocument())) {
      await finalize("error", "浏览器后台采集页面已中断，请重新开始", { quiet: true });
    } else if (settings.apiTranslationActive()) {
      // None of the translation queue or its timers survive a restart; the
      // scheduler rebuilds them from the restored runtime rows.
      scheduler.resume();
    }
  }

  return {
    start,
    stop,
    finalize,
    handleStatusReport,
    handleTranscriptUpdate,
    handleAudioStats,
    refreshSourceMetadata,
    recover,
    publishCaptions
  };
}
