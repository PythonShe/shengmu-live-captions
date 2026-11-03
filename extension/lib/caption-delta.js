/**
 * Delta encoding for the caption state the worker broadcasts several times a
 * second. A full message carries the whole 120-row window; a delta carries the
 * window's row order (ids only), the rows whose content changed and the small
 * non-row fields. Receivers that miss a message see a sequence gap and ask for
 * a resync instead of rendering a wrong list.
 *
 * Pure: no chrome.*, no DOM. The overlay (a classic script) keeps an inline
 * copy of applyCaptionMessage; tests/caption-delta.test.js pins the two.
 */

/** Rows covered by the caption window, matching the runtime snapshot. */
export const CAPTION_WINDOW_LINES = 120;

function windowLines(current) {
  const lines = Array.isArray(current?.lines) ? current.lines : [];
  return lines.slice(-CAPTION_WINDOW_LINES);
}

function fieldsOf(current) {
  const { lines: _lines, ...fields } = current || {};
  return fields;
}

/**
 * @typedef {object} CaptionMessage
 * @property {number} seq
 * @property {number | null} baseSeq Sequence the delta applies on top of.
 * @property {any} [full] Whole caption state (rows included).
 * @property {{ fields: any, lineIds: string[], lines: any[] }} [delta]
 */

export function createCaptionDeltaEncoder() {
  let seq = 0;
  let needsFull = true;
  /** @type {Map<string, string>} row id -> JSON of the copy last sent */
  let sent = new Map();

  function remember(lines) {
    const next = new Map();
    const changed = [];
    for (const line of lines) {
      if (!line?.id) continue;
      const json = JSON.stringify(line);
      if (sent.get(line.id) !== json) changed.push(JSON.parse(json));
      next.set(line.id, json);
    }
    sent = next;
    return changed;
  }

  return {
    /** The next message is a full one (new receiver, sequence gap). */
    reset() {
      needsFull = true;
    },

    /**
     * @param {any} current runtimeState.current
     * @returns {CaptionMessage}
     */
    encode(current) {
      const baseSeq = seq;
      seq += 1;
      const lines = windowLines(current);
      if (needsFull) {
        needsFull = false;
        remember(lines);
        return {
          seq,
          baseSeq: null,
          full: { ...structuredClone(fieldsOf(current)), lines: lines.map((line) => structuredClone(line)) }
        };
      }
      const changed = remember(lines);
      return {
        seq,
        baseSeq,
        delta: {
          fields: structuredClone(fieldsOf(current)),
          lineIds: lines.filter((line) => line?.id).map((line) => line.id),
          lines: changed
        }
      };
    }
  };
}

/**
 * Applies one caption message on top of what the receiver holds.
 * @param {{ seq: number, current: any } | null} held
 * @param {CaptionMessage | null | undefined} message
 * @returns {{ seq: number, current: any, changed: any[] } | null}
 *   null when the message cannot apply (sequence gap or a row the receiver
 *   never saw): the caller asks for a resync and keeps what it has.
 */
export function applyCaptionMessage(held, message) {
  if (!message) return held ? { ...held, changed: [] } : null;
  if (message.full) {
    return { seq: message.seq, current: message.full, changed: message.full.lines || [] };
  }
  const delta = message.delta;
  if (!delta || !held || held.seq !== message.baseSeq) return null;
  const byId = new Map();
  for (const line of held.current?.lines || []) {
    if (line?.id) byId.set(line.id, line);
  }
  for (const line of delta.lines) byId.set(line.id, line);
  const lines = [];
  for (const id of delta.lineIds) {
    const line = byId.get(id);
    if (!line) return null;
    lines.push(line);
  }
  return { seq: message.seq, current: { ...delta.fields, lines }, changed: delta.lines };
}

/**
 * Upserts changed rows into a long, order-sorted history list without
 * rebuilding it: changed rows are almost always at the tail, so each one is
 * found by scanning back from the end, and a new row is appended when it
 * sorts last. Anything else falls back to a full merge by the caller.
 * @param {any[]} lines Sorted by `order`; mutated in place.
 * @param {any[]} changed
 * @param {number} limit
 * @returns {boolean} false when the caller must rebuild (out-of-order row)
 */
export function upsertTailLines(lines, changed, limit) {
  for (const line of changed) {
    if (!line?.id) continue;
    let index = -1;
    for (let cursor = lines.length - 1; cursor >= 0 && cursor >= lines.length - 400; cursor -= 1) {
      if (lines[cursor]?.id === line.id) {
        index = cursor;
        break;
      }
    }
    if (index >= 0) {
      lines[index] = { ...lines[index], ...line };
      continue;
    }
    const lastOrder = Number(lines.at(-1)?.order) || 0;
    if (lines.length > 0 && (Number(line.order) || 0) < lastOrder) return false;
    lines.push(line);
  }
  if (lines.length > limit) lines.splice(0, lines.length - limit);
  return true;
}

/** Minimum gap between two resync requests from one receiver. */
export const CAPTION_RESYNC_INTERVAL_MS = 1000;

/**
 * Receiver side for extension pages: holds the caption state, applies each
 * message and asks for a resync (at most once per interval) on a gap.
 * @param {{ requestResync: () => void, now?: () => number }} deps
 */
export function createCaptionReceiver({ requestResync, now = Date.now }) {
  /** @type {{ seq: number, current: any } | null} */
  let held = null;
  let lastResyncAt = -Infinity;

  return {
    get current() {
      return held?.current ?? null;
    },
    /**
     * @param {CaptionMessage | null | undefined} message
     * @returns {any[] | null} the changed rows, or null when nothing applied
     */
    apply(message) {
      if (!message) return null;
      const next = applyCaptionMessage(held, message);
      if (!next) {
        if (now() - lastResyncAt >= CAPTION_RESYNC_INTERVAL_MS) {
          lastResyncAt = now();
          requestResync();
        }
        return null;
      }
      held = { seq: next.seq, current: next.current };
      return next.changed;
    },
    /** A get-state snapshot: good to render, but outside the sequence. */
    seed(current) {
      if (!held && current) held = { seq: Number.NaN, current };
    }
  };
}
