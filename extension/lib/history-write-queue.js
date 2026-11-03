const DEFAULT_RETRY_DELAYS_MS = [700, 1500, 3000, 5000, 10000, 30000];

export class HistoryWriteQueue {
  constructor({
    writeBatch,
    debounceMs = 700,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    onError = () => {},
    setTimeoutFn = globalThis.setTimeout.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout.bind(globalThis)
  }) {
    if (typeof writeBatch !== "function") {
      throw new TypeError("writeBatch must be a function");
    }
    this.writeBatch = writeBatch;
    this.debounceMs = debounceMs;
    this.retryDelaysMs = retryDelaysMs;
    this.onError = onError;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.pending = new Map();
    this.inFlight = null;
    this.timer = null;
    this.retryAttempt = 0;
  }

  get pendingCount() {
    return this.pending.size;
  }

  enqueue(lines) {
    for (const line of lines || []) {
      if (line?.id) this.pending.set(line.id, line);
    }
    if (this.pending.size > 0 && !this.inFlight) {
      this.schedule();
    }
  }

  schedule(delay = this.debounceMs) {
    if (this.timer || this.inFlight) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, Math.max(0, delay));
  }

  cancelScheduled() {
    if (!this.timer) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  clear() {
    this.cancelScheduled();
    this.pending.clear();
    this.retryAttempt = 0;
  }

  restoreBatch(batch) {
    for (const line of batch) {
      if (!this.pending.has(line.id)) {
        this.pending.set(line.id, line);
      }
    }
  }

  retryDelay() {
    if (this.retryDelaysMs.length === 0) return null;
    const index = Math.min(
      this.retryAttempt,
      this.retryDelaysMs.length - 1
    );
    return this.retryDelaysMs[index];
  }

  async flush({ drain = false } = {}) {
    this.cancelScheduled();

    if (this.inFlight) {
      await this.inFlight.catch(() => {});
      if (!drain) return [];
    }
    if (this.pending.size === 0) return [];

    const batch = [...this.pending.values()];
    this.pending.clear();

    let run;
    try {
      run = Promise.resolve(this.writeBatch(batch));
      this.inFlight = run;
      await run;
      this.retryAttempt = 0;
    } catch (error) {
      this.restoreBatch(batch);
      const delay = this.retryDelay();
      this.retryAttempt += 1;
      if (this.inFlight === run) this.inFlight = null;
      this.onError(error, batch);
      if (delay != null) this.schedule(delay);
      throw error;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }

    if (drain && this.pending.size > 0) {
      return [...batch, ...(await this.flush({ drain: true }))];
    }
    if (this.pending.size > 0) this.schedule();
    return batch;
  }
}
