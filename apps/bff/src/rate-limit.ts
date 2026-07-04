import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { redis } from "./redis.js";

// Fixed-window counter. Returns true if this hit exceeds the limit.
async function overLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n > limit;
}

// Rate-limits browser->BFF unary RPCs. Login/Register are throttled per email
// (brute-force guard); everything else per client IP (§8 Phase 2, §10 security).
export const rateLimitInterceptor: Interceptor = (next) => async (req) => {
  if (req.stream) return next(req);

  const name = req.method.name;
  if (name === "Login" || name === "Register") {
    const raw = (req.message as { email?: unknown }).email;
    const email = typeof raw === "string" ? raw : "?";
    if (await overLimit(`rl:auth:${name}:${email}`, 5, 30)) {
      throw new ConnectError("too many attempts, slow down", Code.ResourceExhausted);
    }
  }

  const ip = req.header.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (await overLimit(`rl:rpc:${ip}`, 300, 10)) {
    throw new ConnectError("rate limit exceeded", Code.ResourceExhausted);
  }

  return next(req);
};
