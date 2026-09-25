import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowLimiter, rateLimitKey, workspaceRateLimitKey } from "./fixed-window-limiter";

test("fixed-window limiter allows the threshold then reports remaining window", () => {
  let now = 1_000;
  const limiter = new FixedWindowLimiter(2, 60_000, 10, () => now);

  assert.deepEqual(limiter.check(rateLimitKey("user-1", "127.0.0.1")), {
    allowed: true,
    retryAfterSeconds: 60,
  });
  assert.equal(limiter.check(rateLimitKey("user-1", "127.0.0.1")).allowed, true);
  const rejected = limiter.check(rateLimitKey("user-1", "127.0.0.1"));
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterSeconds, 60);

  now += 59_001;
  assert.equal(limiter.check(rateLimitKey("user-1", "127.0.0.1")).retryAfterSeconds, 1);
  now += 999;
  assert.equal(limiter.check(rateLimitKey("user-1", "127.0.0.1")).allowed, true);
});

test("limiter keys are isolated by user and IP, and expired keys are reclaimed", () => {
  let now = 0;
  const limiter = new FixedWindowLimiter(1, 1_000, 1, () => now);
  assert.equal(limiter.check(rateLimitKey("one", "same-ip")).allowed, true);
  assert.equal(limiter.check(rateLimitKey("two", "same-ip")).allowed, false);
  now = 1_000;
  assert.equal(limiter.check(rateLimitKey("two", "same-ip")).allowed, true);
});

test("limiter hard cap rejects untracked keys without growing memory", () => {
  let now = 0;
  const limiter = new FixedWindowLimiter(10, 60_000, 1, () => now);
  assert.equal(limiter.check("first").allowed, true);
  const rejected = limiter.check("second");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterSeconds, 60);
});

test("a workspace-scoped attempt budget does not block another actor or workspace", () => {
  const limiter = new FixedWindowLimiter(2, 60_000);
  const ownerA = workspaceRateLimitKey("owner", 1);
  assert.equal(limiter.check(ownerA).allowed, true);
  assert.equal(limiter.check(ownerA).allowed, true);
  assert.equal(limiter.check(ownerA).allowed, false);
  assert.equal(limiter.check(workspaceRateLimitKey("owner", 2)).allowed, true);
  assert.equal(limiter.check(workspaceRateLimitKey("other", 1)).allowed, true);
});