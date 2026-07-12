import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(50051),
  DATABASE_URL: z.string().default("postgres://streamix:streamix@localhost:5432/streamix"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  // Dev-only default; prod injects a real secret via Fly secrets (§10).
  JWT_SECRET: z.string().default("dev-insecure-secret-change-me"),
  ACCESS_TTL: z.string().default("15m"),
  REFRESH_TTL: z.string().default("30d"),
  // Live-state key TTL; refreshed by media heartbeat (§5.2 zombie-stream guard).
  LIVE_TTL_SECONDS: z.coerce.number().default(90),
  // Playback URL signing (§5.2). MUST match svc-media's PLAYBACK_SECRET.
  PLAYBACK_SECRET: z.string().default("dev-insecure-playback-secret"),
  MEDIA_PUBLIC_URL: z.string().default("http://localhost:8090"),
  // Shared internal service token (§ P2-1). Dev default; prod injects a real
  // Fly secret shared with BFF + svc-media. Enforced only in production.
  INTERNAL_TOKEN: z.string().default("dev-insecure-internal-token"),
  // Internal-only Prometheus metrics port (V5-3). Reachable on the Fly private
  // network (streamix-svc-core.internal) — never exposed via a public
  // http_service. Distinct from the gRPC PORT.
  METRICS_PORT: z.coerce.number().default(9091),
});

export const env = Env.parse(process.env);

// Fail fast in production instead of booting on known dev defaults an attacker
// could use to forge JWTs or signed HLS URLs (inbox/review.md P1-2).
if (process.env.NODE_ENV === "production") {
  const errors: string[] = [];
  if (!process.env.JWT_SECRET || env.JWT_SECRET === "dev-insecure-secret-change-me")
    errors.push("JWT_SECRET must be set (no dev default)");
  else if (env.JWT_SECRET.length < 32) errors.push("JWT_SECRET must be at least 32 characters");
  if (!process.env.PLAYBACK_SECRET || env.PLAYBACK_SECRET === "dev-insecure-playback-secret")
    errors.push("PLAYBACK_SECRET must be set (no dev default)");
  else if (env.PLAYBACK_SECRET.length < 32)
    errors.push("PLAYBACK_SECRET must be at least 32 characters");
  if (!process.env.DATABASE_URL) errors.push("DATABASE_URL must be set");
  if (!process.env.REDIS_URL) errors.push("REDIS_URL must be set");
  if (!process.env.INTERNAL_TOKEN || env.INTERNAL_TOKEN === "dev-insecure-internal-token")
    errors.push("INTERNAL_TOKEN must be set (no dev default)");
  else if (env.INTERNAL_TOKEN.length < 32)
    errors.push("INTERNAL_TOKEN must be at least 32 characters");
  if (errors.length > 0) {
    console.error(`[svc-core] fatal production config errors:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
}
