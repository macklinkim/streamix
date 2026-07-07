import { jwtVerify } from "jose";
import { env } from "./env.js";
import { isDenied } from "./token.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

/** Verify a browser access token. Returns the user id, or null if invalid. */
export async function verifyAccessToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.typ !== "access" || typeof payload.sub !== "string") return null;
    // Denylist check: a revoked jti (logout / force-terminate) is rejected before
    // its natural expiry. Tokens without a jti (legacy) skip this.
    if (typeof payload.jti === "string" && (await isDenied(payload.jti))) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Decode jti + remaining lifetime (seconds) without failing on a denied token. */
export async function tokenMeta(
  token: string | null,
): Promise<{ jti: string; ttl: number } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.jti !== "string" || typeof payload.exp !== "number") return null;
    return { jti: payload.jti, ttl: Math.max(0, payload.exp - Math.floor(Date.now() / 1000)) };
  } catch {
    return null;
  }
}

/** Extract a bearer token from an Authorization header value. */
export function bearer(authHeader: string | undefined | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
}
