import argon2 from "argon2";
import { AppErrorCode } from "@streamix/schemas";
import { appError } from "../errors.js";

// Argon2 concurrency gate (inbox/review.md V3-1). Each argon2 op costs ~64 MiB;
// the Fly core instance has 256 MiB, so unbounded concurrent register/login
// requests OOM the process. Edge rate limits live in the BFF, but this is the
// process that actually burns the memory — it must protect itself. 2 concurrent
// ops ≈ 128 MiB peak, leaving headroom for Node + pg + runtime.
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 32;
const QUEUE_TIMEOUT_MS = 5000;

let running = 0;
const waiters: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

function release(): void {
  const next = waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve();
  } else {
    running -= 1;
  }
}

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return;
  }
  if (waiters.length >= MAX_QUEUE) {
    throw appError(AppErrorCode.RATE_LIMITED, "auth busy, retry");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(appError(AppErrorCode.RATE_LIMITED, "auth busy, retry"));
      }, QUEUE_TIMEOUT_MS),
    };
    waiters.push(waiter);
  });
}

async function withGate<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function hashPassword(plain: string): Promise<string> {
  return withGate(() => argon2.hash(plain));
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return withGate(() => argon2.verify(hash, plain));
}
