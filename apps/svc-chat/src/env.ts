import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(50052),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  // Shared internal service token (§ P2-1). Dev default; prod injects a real
  // Fly secret shared with the BFF. Enforced only in production.
  INTERNAL_TOKEN: z.string().default("dev-insecure-internal-token"),
});

export const env = Env.parse(process.env);

if (process.env.NODE_ENV === "production") {
  if (!process.env.INTERNAL_TOKEN || env.INTERNAL_TOKEN === "dev-insecure-internal-token") {
    console.error("[svc-chat] fatal: INTERNAL_TOKEN must be set (no dev default)");
    process.exit(1);
  }
  if (env.INTERNAL_TOKEN.length < 32) {
    console.error("[svc-chat] fatal: INTERNAL_TOKEN must be at least 32 characters");
    process.exit(1);
  }
}
