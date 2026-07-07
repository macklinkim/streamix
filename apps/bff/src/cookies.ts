import { env } from "./env.js";

// The refresh cookie: HttpOnly (invisible to JS => XSS-safe), scoped to /auth so
// it is only ever sent to the refresh/logout routes, never to data endpoints.
export const REFRESH_COOKIE = "sx_rt";
const COOKIE_PATH = "/auth";

// SameSite=None mandates Secure (browsers reject None without it). Cross-site
// prod (Vercel<->Fly) needs None; same-origin/dev can use Lax/Strict.
const secure = env.COOKIE_SECURE || env.COOKIE_SAMESITE === "none";
const sameSiteLabel = { strict: "Strict", lax: "Lax", none: "None" }[env.COOKIE_SAMESITE];

function attrs(maxAgeSec: number): string {
  const parts = [
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    `SameSite=${sameSiteLabel}`,
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  if (env.COOKIE_DOMAIN) parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  return parts.join("; ");
}

export function refreshCookie(sid: string): string {
  return `${REFRESH_COOKIE}=${sid}; ${attrs(env.REFRESH_TTL_DAYS * 86400)}`;
}

/** A Set-Cookie value that immediately expires the refresh cookie (logout). */
export function clearCookie(): string {
  return `${REFRESH_COOKIE}=; ${attrs(0)}`;
}

/** Pull the refresh sid out of a raw Cookie header. */
export function readRefreshCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === REFRESH_COOKIE) return v.join("=") || null;
  }
  return null;
}
