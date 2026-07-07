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
  // Rate limits (§8 Phase 2). Configurable so the load rig can raise them.
  RATE_LIMIT_RPC_MAX: z.coerce.number().default(300),
  RATE_LIMIT_RPC_WINDOW: z.coerce.number().default(10),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(5),
  RATE_LIMIT_AUTH_WINDOW: z.coerce.number().default(30),
});

export const env = Env.parse(process.env);
export const corsOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim());
