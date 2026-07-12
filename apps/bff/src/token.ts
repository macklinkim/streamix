import { SignJWT } from "jose";
import { redis } from "./redis.js";
import { env } from "./env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

// Pinned claims (inbox/review.md V1-4): verification rejects tokens signed for
// another issuer/audience or with a downgraded algorithm.
export const JWT_ISSUER = "streamix-bff";
export const JWT_AUDIENCE = "streamix-web";

// A random jti so a specific access token can be revoked before its 15m expiry
// (logout / force-terminate). node:crypto.randomUUID is available on Node 22.
function newJti(): string {
  return crypto.randomUUID();
}

export type MintedAccess = { token: string; jti: string };

/** env.ACCESS_TTL ("15m", "900s", "1h") in seconds; used to bound revocation-marker TTLs. */
export function accessTtlSec(): number {
  const m = /^(\d+)([smh])$/.exec(env.ACCESS_TTL);
  if (!m) return 900;
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
}

/**
 * Mint a short-lived access JWT carrying a jti for per-token revocation and,
 * when the login has a refresh session, a fam claim so revoking that session
 * family (logout / reuse detection) also kills every access token it issued
 * (inbox/review.md P1-1).
 */
export async function mintAccess(userId: string, family?: string): Promise<MintedAccess> {
  const jti = newJti();
  const token = await new SignJWT(family ? { typ: "access", fam: family } : { typ: "access" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
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

// Family-wide revocation marker (inbox/review.md P1-1): set when a session
// family is revoked so every access token minted under it dies immediately,
// not just the one presented at logout. TTL = access TTL (the longest any such
// token could still live).
const famDenyKey = (family: string) => `deny:fam:${family}`;

export async function isFamilyDenied(family: string): Promise<boolean> {
  try {
    return (await redis.exists(famDenyKey(family))) === 1;
  } catch {
    return false; // Redis outage: fail open, token expires naturally (<=15m).
  }
}
