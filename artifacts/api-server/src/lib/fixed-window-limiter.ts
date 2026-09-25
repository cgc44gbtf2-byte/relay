/**
 * A deliberately small, process-local fixed-window limiter.
 *
 * This is intended for inexpensive abuse controls, not distributed traffic
 * shaping. Each process has its own counters and restarting a process clears
 * them.
 */
export type Clock = () => number;

export type LimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type Window = { startedAt: number; count: number };

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: Clock = Date.now,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Limit must be positive");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("Window must be positive");
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new Error("Max keys must be positive");
  }

  check(key: string): LimitResult {
    const now = this.now();
    const current = this.windows.get(key);
    if (current && now - current.startedAt < this.windowMs) {
      current.count += 1;
      return this.result(current, now);
    }

    // Expiry is lazy: discard stale entries when they are encountered, and
    // also make room for new keys without running a periodic cleanup task.
    if (current) this.windows.delete(key);
    for (const [trackedKey, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(trackedKey);
    }
    if (this.windows.size >= this.maxKeys) {
      return { allowed: false, retryAfterSeconds: this.retryAfter(now) };
    }

    const window = { startedAt: now, count: 1 };
    this.windows.set(key, window);
    return this.result(window, now);
  }

  private result(window: Window, now: number): LimitResult {
    return {
      allowed: window.count <= this.limit,
      retryAfterSeconds: this.retryAfter(now, window.startedAt),
    };
  }

  private retryAfter(now: number, startedAt = now): number {
    return Math.max(1, Math.ceil((this.windowMs - (now - startedAt)) / 1000));
  }
}

export function rateLimitKey(userId: string, ip: string): string {
  return `${userId}\u0000${ip}`;
}

export function workspaceRateLimitKey(userId: string, workspaceId: number): string {
  return `${userId}\u0000workspace:${workspaceId}`;
}