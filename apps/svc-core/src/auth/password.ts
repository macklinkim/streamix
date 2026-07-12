import argon2 from "argon2";
import { createGate } from "./gate.js";

// Argon2 concurrency gate (inbox/review.md V3-1). Each argon2 op costs ~64 MiB;
// the Fly core instance has 256 MiB, so unbounded concurrent register/login
// requests OOM the process. Edge rate limits live in the BFF, but this is the
// process that actually burns the memory — it must protect itself. 2 concurrent
// ops ≈ 128 MiB peak, leaving headroom for Node + pg + runtime. Gate logic lives
// in gate.ts so it can be unit-tested without real Argon2 (V5-3).
const gate = createGate({ maxConcurrent: 2, maxQueue: 32, queueTimeoutMs: 5000 });

export function hashPassword(plain: string): Promise<string> {
  return gate(() => argon2.hash(plain));
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return gate(() => argon2.verify(hash, plain));
}
