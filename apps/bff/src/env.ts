import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  CORE_URL: z.string().default("http://localhost:50051"),
  CHAT_URL: z.string().default("http://localhost:50052"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  // MUST match svc-core's secret (shared JWT verification). Prod: Fly secret.
  JWT_SECRET: z.string().default("dev-insecure-secret-change-me"),
  // Comma-separated allowed browser origins (Vercel domain in prod, ADR-8/§10).
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  // Session hardening (§ auth). Short-lived access JWT; refresh is an opaque
  // rotating token stored server-side in Redis, delivered only via HttpOnly cookie.
  ACCESS_TTL: z.string().default("15m"),
  // Sliding refresh window: each rotation renews TTL to this many days.
  REFRESH_TTL_DAYS: z.coerce.number().default(30),
  // Absolute cap: a session family cannot outlive this regardless of sliding.
  REFRESH_ABS_MAX_DAYS: z.coerce.number().default(90),
  // Refresh-cookie policy. Cross-site prod (Vercel<->Fly) REQUIRES SameSite=None
  // + Secure; Strict is only possible under a same-origin deploy. Dev: lax.
  COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("lax"),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  // Optional explicit cookie domain (unset = host-only cookie on the BFF host).
  COOKIE_DOMAIN: z.string().optional(),
  // Twitch OAuth (confidential client). Secret must come from a Fly secret in
  // prod — never commit it. Empty client id disables the Twitch login routes.
  TWITCH_CLIENT_ID: z.string().default(""),
  TWITCH_CLIENT_SECRET: z.string().default(""),
  // Must EXACTLY match a redirect URL registered in the Twitch console.
  TWITCH_REDIRECT_URI: z.string().default("http://localhost:8080/auth/twitch/callback"),
  // Where to send the browser back after a successful OAuth login.
  WEB_URL: z.string().default("http://localhost:3000"),
  // Rate limits (§8 Phase 2). Configurable so the load rig can raise them.
  RATE_LIMIT_RPC_MAX: z.coerce.number().default(300),
  RATE_LIMIT_RPC_WINDOW: z.coerce.number().default(10),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(5),
  RATE_LIMIT_AUTH_WINDOW: z.coerce.number().default(30),
});

export const env = Env.parse(process.env);
export const corsOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim());

// Fail fast in production instead of booting on known dev defaults an attacker
// could use to forge JWTs or hijack sessions (inbox/review.md P1-2).
if (process.env.NODE_ENV === "production") {
  const errors: string[] = [];
  if (!process.env.JWT_SECRET || env.JWT_SECRET === "dev-insecure-secret-change-me")
    errors.push("JWT_SECRET must be set (no dev default)");
  else if (env.JWT_SECRET.length < 32) errors.push("JWT_SECRET must be at least 32 characters");
  if (!process.env.REDIS_URL) errors.push("REDIS_URL must be set");
  if (!process.env.CORS_ORIGINS) errors.push("CORS_ORIGINS must be set");
  if (!process.env.COOKIE_SAMESITE) errors.push("COOKIE_SAMESITE must be set");
  if (env.COOKIE_SAMESITE === "none" && !env.COOKIE_SECURE)
    errors.push("COOKIE_SAMESITE=none requires COOKIE_SECURE=true");
  if (!env.COOKIE_SECURE) errors.push("COOKIE_SECURE must be true in production");
  if (errors.length > 0) {
    console.error(`[bff] fatal production config errors:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
}
