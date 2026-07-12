import argon2 from "argon2";
import { Counter, Gauge, Histogram } from "prom-client";
import { createGate } from "./gate.js";

// Argon2 concurrency gate (inbox/review.md V3-1). Each argon2 op costs ~64 MiB;
// the Fly core instance has 256 MiB, so unbounded concurrent register/login
// requests OOM the process. Edge rate limits live in the BFF, but this is the
// process that actually burns the memory — it must protect itself. 2 concurrent
// ops ≈ 128 MiB peak, leaving headroom for Node + pg + runtime. Gate logic lives
// in gate.ts so it can be unit-tested without real Argon2 (V5-3).
const gate = createGate({ maxConcurrent: 2, maxQueue: 32, queueTimeoutMs: 5000 });

// Gate observability (V5-3), scraped via the internal metrics endpoint.
new Gauge({
  name: "streamix_argon2_gate_running",
  help: "Argon2 operations currently executing.",
  collect() {
    this.set(gate.stats().running);
  },
});
new Gauge({
  name: "streamix_argon2_gate_queued",
  help: "Requests waiting for an Argon2 gate slot.",
  collect() {
    this.set(gate.stats().queued);
  },
});
const argonOps = new Counter({
  name: "streamix_argon2_ops_total",
  help: "Completed Argon2 operations, by op.",
  labelNames: ["op"] as const,
});
const argonRejects = new Counter({
  name: "streamix_argon2_rejects_total",
  help: "Argon2 requests rejected by the gate (queue full / wait timeout).",
});
const argonDuration = new Histogram({
  name: "streamix_argon2_duration_seconds",
  help: "Argon2 operation wall time (excludes gate queue wait).",
  labelNames: ["op"] as const,
  buckets: [0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 5],
});

async function gated<T>(op: "hash" | "verify", fn: () => Promise<T>): Promise<T> {
  try {
    return await gate(async () => {
      const end = argonDuration.startTimer({ op });
      try {
        return await fn();
      } finally {
        end();
        argonOps.inc({ op });
      }
    });
  } catch (e) {
    // The gate rejects (ResourceExhausted) before fn runs when the queue is full
    // or the wait times out — count those distinctly from op completions.
    if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === 8)
      argonRejects.inc();
    throw e;
  }
}

export function hashPassword(plain: string): Promise<string> {
  return gated("hash", () => argon2.hash(plain));
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return gated("verify", () => argon2.verify(hash, plain));
}
