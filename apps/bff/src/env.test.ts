import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Production fail-fast is enforced at module-load time via process.exit(1), so
// it can only be exercised in a subprocess (inbox/review.md V1-5/V5-2/P1-2).
// We run the env module under tsx with a controlled environment and assert the
// exit code. Importing env.ts has no server side effects — it validates and
// exits on its own.
const envEntry = fileURLToPath(new URL("./env.ts", import.meta.url));

const VALID_PROD = {
  NODE_ENV: "production",
  JWT_SECRET: "x".repeat(32),
  INTERNAL_TOKEN: "i".repeat(32),
  REDIS_URL: "redis://prod:6379",
  CORS_ORIGINS: "https://streamix-web.vercel.app",
  COOKIE_SAMESITE: "none",
  COOKIE_SECURE: "true",
};

function runEnv(overrides: Record<string, string | undefined>): number {
  const env: Record<string, string> = {};
  // Start from a clean base (PATH only) so host env doesn't leak in.
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // tsx on Windows
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) env[k] = v;
  }
  const res = spawnSync("tsx", [envEntry], { env, encoding: "utf8", shell: true });
  return res.status ?? -1;
}

describe("bff production env fail-fast", () => {
  it("boots with a fully valid production config", () => {
    expect(runEnv(VALID_PROD)).toBe(0);
  });

  it("uses dev defaults happily outside production", () => {
    expect(runEnv({ NODE_ENV: "development" })).toBe(0);
  });

  it("rejects the dev-default JWT secret in production", () => {
    expect(runEnv({ ...VALID_PROD, JWT_SECRET: "dev-insecure-secret-change-me" })).toBe(1);
  });

  it("rejects a too-short JWT secret", () => {
    expect(runEnv({ ...VALID_PROD, JWT_SECRET: "short" })).toBe(1);
  });

  it("rejects COOKIE_SAMESITE other than none (split-origin, V1-5)", () => {
    expect(runEnv({ ...VALID_PROD, COOKIE_SAMESITE: "lax" })).toBe(1);
  });

  it("rejects COOKIE_SECURE=false in production", () => {
    expect(runEnv({ ...VALID_PROD, COOKIE_SECURE: "false" })).toBe(1);
  });

  it("rejects ACCESS_TTL below 60s (V5-2)", () => {
    expect(runEnv({ ...VALID_PROD, ACCESS_TTL: "30s" })).toBe(1);
  });

  it("rejects ACCESS_TTL above 1h", () => {
    expect(runEnv({ ...VALID_PROD, ACCESS_TTL: "2h" })).toBe(1);
  });

  it("rejects REFRESH_ABS_MAX_DAYS < REFRESH_TTL_DAYS", () => {
    expect(runEnv({ ...VALID_PROD, REFRESH_TTL_DAYS: "30", REFRESH_ABS_MAX_DAYS: "10" })).toBe(1);
  });

  it("rejects a fractional REFRESH_GRACE_MS over the cap", () => {
    expect(runEnv({ ...VALID_PROD, REFRESH_GRACE_MS: "60000" })).toBe(1);
  });

  it("rejects the dev-default INTERNAL_TOKEN in production (P2-1)", () => {
    expect(runEnv({ ...VALID_PROD, INTERNAL_TOKEN: "dev-insecure-internal-token" })).toBe(1);
  });
});
