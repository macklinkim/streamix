import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Production fail-fast + ingest-origin validation run at module load via
// process.exit(1) (inbox/review.md V6-2/V7-2), so they're tested in a subprocess.
const envEntry = fileURLToPath(new URL("./env.ts", import.meta.url));

const VALID_PROD = {
  NODE_ENV: "production",
  PLAYBACK_SECRET: "y".repeat(32),
  INGEST_ALLOWED_ORIGINS: "https://streamix-web.vercel.app",
};

function runEnv(overrides: Record<string, string | undefined>): number {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) env[k] = v;
  }
  return spawnSync("tsx", [envEntry], { env, encoding: "utf8", shell: true }).status ?? -1;
}

describe("svc-media production env fail-fast", () => {
  it("boots with a valid production config", () => {
    expect(runEnv(VALID_PROD)).toBe(0);
  });

  it("uses dev defaults outside production", () => {
    expect(runEnv({ NODE_ENV: "development" })).toBe(0);
  });

  it("rejects the dev-default playback secret", () => {
    expect(runEnv({ ...VALID_PROD, PLAYBACK_SECRET: "dev-insecure-playback-secret" })).toBe(1);
  });

  it("rejects a short playback secret", () => {
    expect(runEnv({ ...VALID_PROD, PLAYBACK_SECRET: "short" })).toBe(1);
  });

  it("rejects empty ingest origins in production (V6-2)", () => {
    expect(runEnv({ ...VALID_PROD, INGEST_ALLOWED_ORIGINS: "" })).toBe(1);
  });

  it("rejects a comma-only ingest origins value (V7-2)", () => {
    expect(runEnv({ ...VALID_PROD, INGEST_ALLOWED_ORIGINS: " , " })).toBe(1);
  });

  it("rejects an http (non-https) ingest origin in production", () => {
    expect(runEnv({ ...VALID_PROD, INGEST_ALLOWED_ORIGINS: "http://insecure.example" })).toBe(1);
  });

  it("rejects an ingest origin with a path (V7-2)", () => {
    expect(runEnv({ ...VALID_PROD, INGEST_ALLOWED_ORIGINS: "https://good.example/path" })).toBe(1);
  });
});
