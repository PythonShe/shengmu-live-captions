import assert from "node:assert/strict";
import test from "node:test";

import {
  COOLDOWN_JITTER,
  RATE_LIMIT_DEFAULT_COOLDOWN_MS,
  createTranslationCooldown
} from "../extension/lib/translation-cooldown.js";
import { createFakeClock, settleAsync } from "./helpers/fake-clock.js";

function setup(random = () => 0) {
  const clock = createFakeClock();
  const cooldown = createTranslationCooldown({
    now: clock.now,
    random,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  return { clock, cooldown };
}

test("only rate limits and explicit Retry-After hints start a cooldown", () => {
  const { cooldown } = setup();
  cooldown.note({ code: "timeout" });
  cooldown.note({ code: "server", retryAfterMs: null });
  assert.equal(cooldown.remainingMs(), 0);
  cooldown.note({ code: "rate_limit", retryAfterMs: null });
  assert.equal(cooldown.remainingMs(), RATE_LIMIT_DEFAULT_COOLDOWN_MS);
  cooldown.note({ code: "server", retryAfterMs: 4000 });
  assert.equal(cooldown.remainingMs(), 4000);
  cooldown.note({ code: "rate_limit", retryAfterMs: 1000 });
  assert.equal(cooldown.remainingMs(), 4000, "a shorter hint never shortens the cooldown");
  cooldown.reset();
  assert.equal(cooldown.remainingMs(), 0);
});

test("jitter adds at most its share of the wait", () => {
  const { cooldown } = setup(() => 0.999);
  cooldown.note({ code: "rate_limit", retryAfterMs: 10000 });
  const remaining = cooldown.remainingMs();
  assert.ok(remaining > 10000 && remaining <= 10000 * (1 + COOLDOWN_JITTER));
});

test("wait resolves when the cooldown ends and rejects on abort", async () => {
  const { clock, cooldown } = setup();
  await cooldown.wait();
  cooldown.note({ code: "rate_limit", retryAfterMs: 2000 });
  let done = false;
  void cooldown.wait().then(() => {
    done = true;
  });
  await clock.advance(1999);
  assert.equal(done, false);
  await clock.advance(1);
  await settleAsync();
  assert.equal(done, true);

  cooldown.note({ code: "rate_limit", retryAfterMs: 2000 });
  const controller = new AbortController();
  const waiting = cooldown.wait(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await assert.rejects(cooldown.wait(controller.signal), { name: "AbortError" });
});
