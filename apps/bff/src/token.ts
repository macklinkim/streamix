import { SignJWT } from "jose";
import { redis } from "./redis.js";
import { env } from "./env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

// A random jti so a specific access token can be revoked before its 15m expiry
// (logout / force-terminate). node:crypto.randomUUID is available on Node 22.
function newJti(): string {
  return crypto.randomUUID();
}

export type MintedAccess = { token: string; jti: string };

/** Mint a short-lived access JWT carrying a jti for denylist revocation. */
export async function mintAccess(userId: string): Promise<MintedAccess> {
  const jti = newJti();
  const token = await new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TTL)
    .sign(secret);
  return { token, jti };
}

const denyKey = (jti: string) => `deny:jti:${jti}`;

/**
 * Revoke an access token immediately. TTL bounds the entry to the token's
 * remaining lifetime so it self-cleans once the JWT would expire anyway.
 */
export async function denylistJti(jti: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  try {
    await redis.set(denyKey(jti), "1", "EX", ttlSeconds);
  } catch {
    // Redis outage: cannot record revocation. Fail-open (token lives out its
    // <=15m natural expiry) — consistent with the repo's availability-first
    // degradation (§10). Documented tradeoff.
  }
}

/** True if this jti was revoked. Fails OPEN on a Redis outage (availability). */
export async function isDenied(jti: string): Promise<boolean> {
  try {
    return (await redis.exists(denyKey(jti))) === 1;
  } catch {
    return false;
  }
}
