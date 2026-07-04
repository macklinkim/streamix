import { z } from "zod";

/**
 * Typed environment loader (dotenv + Zod parse, ADR-6 / §4.1).
 * Services call `loadEnv()` at boot; invalid/missing config fails fast.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
