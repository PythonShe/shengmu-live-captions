import { lineNeedsTranslation } from "../lib/caption-utils.js";
import { errorText, t } from "./i18n.js";
import { HistoryWriteQueue } from "../lib/history-write-queue.js";
import { rememberLine } from "../lib/transcript-reducer.js";
import {
  countHistoryLines,
  createHistorySession,
  getHistoryLines,
  updateHistorySession,
  upsertHistoryLines
} from "../storage/history-db.js";

export const HISTORY_FLUSH_DELAY_MS = 700;

/**
 * Mirrors the session into IndexedDB. `knownLines` is the last copy of every
 * row written (or queued) for the current session, including rows that left
 * the 120-row runtime window, so late translations still reach history.
 *
 * @param {{ store: any, views: any }} deps
 */
export function createHistorySync({ store, views }) {
  const knownLines = new Map();
  let lastWriteError = "";

  async function commitBatch(lines) {
    const bySession = new Map();
    for (const line of lines || []) {
      if (!line?.sessionId) continue;
      if (!bySession.has(line.sessionId)) bySession.set(line.sessionId, []);
      bySession.get(line.sessionId).push(line);
    }

    for (const [sessionId, sessionLines] of bySession) {
      await upsertHistoryLines(sessionLines);
      const count = await countHistoryLines(sessionId);
      const lastLine = [...sessionLines]
        .filter((line) => line.source || line.translation)
        .sort((left, right) => (left.order || 0) - (right.order || 0))
        .at(-1);
      const isCurrentSession = sessionId === store.state.sessionId;
      if (isCurrentSession) store.state.lineCount = count;
      const patch = {
        lineCount: count,
        preview: lastLine?.translation || lastLine?.source || ""
      };
      if (isCurrentSession) {
        patch.status = store.state.active ? "capturing" : store.state.status;
      }
      await updateHistorySession(sessionId, patch);
      if (isCurrentSession) {
        if (lastWriteError) {
          lastWriteError = "";
          // The retry text ends with the error ($1), so its empty rendering is the
          // prefix; it survives a worker restart, unlike a remembered string.
          if (store.state.detail.startsWith(t("history_write_retrying", ""))) {
            store.state.detail = t("history_write_recovered");
          }
        }
        await store.persist(true);
        await views.broadcastToExtension({ type: "line-count", lineCount: count });
      }
    }
  }

  function handleWriteError(error) {
    lastWriteError = errorText(error);
    console.error("声幕历史字幕写入失败", error);
    if (!store.state.active) return;
    store.state.detail = t("history_write_retrying", lastWriteError);
    store.state.updatedAt = Date.now();
    void store.persist();
    void views.broadcastToExtension({
      type: "status",
      status: {
        state: store.state.status,
        detail: store.state.detail,
        wsConnected: store.state.wsConnected
      }
    });
  }

  const queue = new HistoryWriteQueue({
    writeBatch: commitBatch,
    debounceMs: HISTORY_FLUSH_DELAY_MS,
    onError: handleWriteError
  });

  async function summarize(sessionId) {
    const lines = await getHistoryLines(sessionId);
    const ordered = [...lines].sort((left, right) => (left.order || 0) - (right.order || 0));
    const lastLine = ordered.at(-1);
    return {
      lineCount: ordered.length,
      translationMissing: ordered.filter(lineNeedsTranslation).length,
      preview: lastLine?.translation || lastLine?.source || ""
    };
  }

  return {
    knownLines,
    enqueue: (lines) => queue.enqueue(lines),
    /** Remembers rows the reducer saw change and queues them for history. */
    record(lines) {
      for (const line of lines) knownLines.set(line.id, rememberLine(line));
      if (lines.length > 0) queue.enqueue(lines);
    },
    /** Debounced write, or with `force` a full drain that rethrows failures. */
    async flush(force = false) {
      if (!force) {
        queue.schedule();
        return;
      }
      await queue.flush({ drain: true });
    },
    summarize,
    createSession: createHistorySession,
    updateSession: updateHistorySession,
    /** A new session starts: forget the previous one's rows. */
    resetSession() {
      knownLines.clear();
    },
    get pendingCount() {
      return queue.pendingCount;
    }
  };
}
