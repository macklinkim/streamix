import { jwtVerify } from "jose";
import { env } from "./env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

/** Verify a browser access token. Returns the user id, or null if invalid. */
export async function verifyAccessToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.typ !== "access" || typeof payload.sub !== "string") return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Extract a bearer token from an Authorization header value. */
export function bearer(authHeader: string | undefined | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
}
