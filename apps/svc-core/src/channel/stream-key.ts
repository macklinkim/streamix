import { randomBytes, createHash } from "node:crypto";

// High-entropy stream key: sha256 (not argon2) so ValidateStreamKey can look it
// up by hash. Passwords use argon2; stream keys don't need slow hashing.
export function generateStreamKey(): string {
  return `live_${randomBytes(24).toString("hex")}`;
}

export function hashStreamKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Short-lived browser ingest token (ADR-13). The "bit_" prefix lets
// ValidateStreamKey/StartStream route it to the Redis lookup instead of the
// durable stream-key hash, so browser go-live never exposes the OBS key.
export const INGEST_TOKEN_PREFIX = "bit_";
export function generateIngestToken(): string {
  return `${INGEST_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
}
