import { randomBytes, createHash } from "node:crypto";

// High-entropy stream key: sha256 (not argon2) so ValidateStreamKey can look it
// up by hash. Passwords use argon2; stream keys don't need slow hashing.
export function generateStreamKey(): string {
  return `live_${randomBytes(24).toString("hex")}`;
}

export function hashStreamKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
