// A manual clock for code that takes injected setTimeout/clearTimeout/now.
// advance() fires due timers in order and lets promise chains settle between
// them, so async schedulers can be stepped deterministically.

export async function settleAsync(rounds = 20) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

export function createFakeClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => current,
    setTimeout: (callback, ms = 0) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, at: current + Math.max(0, Number(ms) || 0), callback });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    get timerCount() {
      return timers.size;
    },
    nextTimerIn() {
      const next = [...timers.values()].sort((left, right) => left.at - right.at)[0];
      return next ? next.at - current : null;
    },
    async advance(ms) {
      const target = current + ms;
      await settleAsync();
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        timers.delete(due.id);
        current = due.at;
        due.callback();
        await settleAsync();
      }
      current = target;
      await settleAsync();
    }
  };
}
