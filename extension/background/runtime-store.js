import { EMPTY_RUNTIME_STATE, RUNTIME_STATE_KEY } from "../lib/caption-utils.js";

export const STATE_PERSIST_DELAY_MS = 350;
/** Rows kept in the persisted and broadcast snapshot of the runtime state. */
export const SNAPSHOT_LINE_LIMIT = 120;

export function safeClone(value) {
  return value == null ? value : structuredClone(value);
}

function emptyRuntimeState() {
  return structuredClone(EMPTY_RUNTIME_STATE);
}

/**
 * Owns runtimeState, the one mutable record of the capture session that every
 * view renders. It lives in chrome.storage.session so a recycled service
 * worker can pick the session up again.
 *
 * Callers mutate `store.state` in place and then call persist(); start and
 * rehydrate swap the whole object, so never hold on to a reference across an
 * await that might start a new session.
 */
export function createRuntimeStore({
  storage = chrome.storage.session,
  persistDelayMs = STATE_PERSIST_DELAY_MS
} = {}) {
  let state = emptyRuntimeState();
  let persistTimer = null;

  function snapshot() {
    return {
      ...safeClone(state),
      current: {
        ...safeClone(state.current),
        lines: (state.current?.lines || []).slice(-SNAPSHOT_LINE_LIMIT)
      }
    };
  }

  /** The state without caption rows; rows travel as caption deltas. */
  function metaSnapshot() {
    const { current: _current, ...meta } = state;
    return safeClone(meta);
  }

  async function persist(immediate = false) {
    if (!immediate) {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void storage.set({ [RUNTIME_STATE_KEY]: snapshot() });
      }, persistDelayMs);
      return;
    }
    clearTimeout(persistTimer);
    persistTimer = null;
    await storage.set({ [RUNTIME_STATE_KEY]: snapshot() });
  }

  /** Loads the persisted state; returns it, or null when there is none. */
  async function rehydrate() {
    const values = await storage.get([RUNTIME_STATE_KEY]);
    const stored = values[RUNTIME_STATE_KEY];
    if (!stored) return null;
    state = {
      ...emptyRuntimeState(),
      ...stored,
      current: {
        ...structuredClone(EMPTY_RUNTIME_STATE.current),
        ...(stored.current || {})
      }
    };
    return state;
  }

  return {
    get state() {
      return state;
    },
    /** Starts a new session record on top of an empty state. */
    replace(patch) {
      state = { ...emptyRuntimeState(), ...patch };
      return state;
    },
    snapshot,
    metaSnapshot,
    persist,
    rehydrate
  };
}
