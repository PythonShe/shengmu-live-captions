// Rolling caption history for the page overlay.
//
// The overlay re-renders on every caption-state message (~12 times/second), so
// it must not rebuild or re-sort its history array per frame. This log patches
// entries in place, appends new lines in order, and only touches the array when
// a line is really added or the cap is exceeded.
//
// Content scripts are injected as classic scripts (no ESM), so the helpers are
// published on the global object; the unit tests import this file for the same
// side effect.
(function (root) {
  "use strict";

  function createHistoryLog(limit) {
    return {
      limit: Math.max(1, Number(limit) || 1),
      entries: [],
      byId: new Map()
    };
  }

  function resetHistoryLog(log) {
    if (!log) return;
    log.entries.length = 0;
    log.byId.clear();
  }

  // `lines` items must already be normalized to { id, order, source, translation }.
  // Returns true only when the log actually changed, so callers can skip work.
  function syncHistoryLog(log, lines) {
    if (!log || !Array.isArray(lines) || lines.length === 0) return false;
    let changed = false;

    for (const line of lines) {
      const id = line && line.id;
      if (!id) continue;
      if (!line.source && !line.translation) continue;
      const existing = log.byId.get(id);
      if (existing) {
        // Late translations arrive after the source, so patch the same entry
        // instead of replacing it; open scrollback views keep their position.
        if (line.translation && existing.translation !== line.translation) {
          existing.translation = line.translation;
          changed = true;
        }
        if (line.source && existing.source !== line.source) {
          existing.source = line.source;
          changed = true;
        }
        continue;
      }
      const order = Number(line.order) || 0;
      // A full log already holds its newest `limit` lines. Older lines from the
      // caller's bigger window would only be inserted and trimmed again on the
      // next sync, so ignore them and keep the log stable.
      if (log.entries.length >= log.limit) {
        const oldest = log.entries[0].order || 0;
        if (order > 0 && oldest > 0 && order <= oldest) continue;
      }
      const entry = {
        id,
        order,
        source: line.source,
        translation: line.translation
      };
      log.byId.set(id, entry);
      insertByOrder(log.entries, entry);
      changed = true;
    }

    if (log.entries.length > log.limit) {
      const dropped = log.entries.splice(0, log.entries.length - log.limit);
      for (const entry of dropped) log.byId.delete(entry.id);
      changed = true;
    }
    return changed;
  }

  // Lines arrive in ascending order in every case observed so far, which makes
  // this loop a single comparison; out-of-order lines fall back to an insert.
  function insertByOrder(entries, entry) {
    let index = entries.length;
    while (index > 0 && (entries[index - 1].order || 0) > entry.order) {
      index -= 1;
    }
    entries.splice(index, 0, entry);
  }

  root.ShengmuOverlayHistory = {
    createHistoryLog,
    resetHistoryLog,
    syncHistoryLog
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
