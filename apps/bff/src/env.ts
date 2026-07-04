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
  // Rate limits (§8 Phase 2). Configurable so the load rig can raise them.
  RATE_LIMIT_RPC_MAX: z.coerce.number().default(300),
  RATE_LIMIT_RPC_WINDOW: z.coerce.number().default(10),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().default(5),
  RATE_LIMIT_AUTH_WINDOW: z.coerce.number().default(30),
});

export const env = Env.parse(process.env);
export const corsOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim());
