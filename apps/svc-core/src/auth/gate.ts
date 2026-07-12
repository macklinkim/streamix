import { AppErrorCode } from "@streamix/schemas";
import { appError } from "../errors.js";

// Bounded-concurrency gate (inbox/review.md V3-1/V5-3). Extracted from
// password.ts so it can be unit-tested with an injected work function instead of
// real Argon2. Guarantees: never more than `maxConcurrent` tasks run at once;
// at most `maxQueue` wait; a waiter that times out is removed and rejects; a
// permit is always released on success, throw, or timeout (no leak).
export type Gate = <T>(fn: () => Promise<T>) => Promise<T>;

export function createGate(opts: {
  maxConcurrent: number;
  maxQueue: number;
  queueTimeoutMs: number;
}): Gate & { stats: () => { running: number; queued: number } } {
  const { maxConcurrent, maxQueue, queueTimeoutMs } = opts;
  let running = 0;
  const waiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  function release(): void {
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(); // hand the permit straight to the next waiter
    } else {
      running -= 1;
    }
  }

  function acquire(): Promise<void> {
    if (running < maxConcurrent) {
      running += 1;
      return Promise.resolve();
    }
    if (waiters.length >= maxQueue) {
      return Promise.reject(appError(AppErrorCode.RATE_LIMITED, "auth busy, retry"));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i !== -1) waiters.splice(i, 1);
          reject(appError(AppErrorCode.RATE_LIMITED, "auth busy, retry"));
        }, queueTimeoutMs),
      };
      waiters.push(waiter);
    });
  }

  const gate = (async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }) as Gate & { stats: () => { running: number; queued: number } };

  gate.stats = () => ({ running, queued: waiters.length });
  return gate;
}
