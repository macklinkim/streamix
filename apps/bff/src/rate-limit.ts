import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { Counter } from "prom-client";
import { redis } from "./redis.js";
import { env } from "./env.js";

// Rate-limit rejections, scraped via /metrics (V5-3 observability). Labelled by
// surface so auth brute-force vs generic RPC pressure are distinguishable.
export const rateLimitRejects = new Counter({
  name: "streamix_rate_limit_rejects_total",
  help: "Requests rejected by a rate limit, by surface.",
  labelNames: ["surface"] as const,
});

// Fixed-window counter. Returns true if this hit exceeds the limit. Fails OPEN
// on a Redis outage (availability over throttling, §10) so RPCs keep working.
export async function overLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec);
    return n > limit;
  } catch {
    return false;
  }
}

// Auth endpoints must NOT fail open: register/login burn Argon2 CPU upstream,
// so a Redis outage would otherwise leave them unthrottled (inbox/review.md
// P0-3). Falls back to a small process-local fixed window instead.
const localWindows = new Map<string, { count: number; resetAt: number }>();

export async function overLimitAuth(
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec);
    return n > limit;
  } catch {
    const now = Date.now();
    const w = localWindows.get(key);
    if (!w || now >= w.resetAt) {
      if (localWindows.size > 10_000) localWindows.clear(); // bound memory
      localWindows.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return false;
    }
    w.count += 1;
    return w.count > limit;
  }
}

// Rate-limits browser->BFF unary RPCs. Login/Register are throttled per email
// (brute-force guard); everything else per client IP (§8 Phase 2, §10 security).
export const rateLimitInterceptor: Interceptor = (next) => async (req) => {
  if (req.stream) return next(req);

  const name = req.method.name;
  if (name === "Login" || name === "Register") {
    const raw = (req.message as { email?: unknown }).email;
    const email = typeof raw === "string" ? raw : "?";
    if (
      await overLimit(
        `rl:auth:${name}:${email}`,
        env.RATE_LIMIT_AUTH_MAX,
        env.RATE_LIMIT_AUTH_WINDOW,
      )
    ) {
      rateLimitRejects.inc({ surface: "auth" });
      throw new ConnectError("too many attempts, slow down", Code.ResourceExhausted);
    }
  }

  // Rightmost x-forwarded-for entry: the one Fly's proxy appended. The leftmost
  // is client-supplied and spoofable (inbox/review.md P1-5).
  const ip = req.header.get("x-forwarded-for")?.split(",").pop()?.trim() || "local";
  if (await overLimit(`rl:rpc:${ip}`, env.RATE_LIMIT_RPC_MAX, env.RATE_LIMIT_RPC_WINDOW)) {
    rateLimitRejects.inc({ surface: "rpc" });
    throw new ConnectError("rate limit exceeded", Code.ResourceExhausted);
  }

  return next(req);
};
