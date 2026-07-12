import { bffUrl } from "./api-base";
import type { SessionUser } from "./auth-store";

// Cookie-session client for the BFF /auth/* routes. `credentials: "include"`
// lets the browser send/receive the HttpOnly refresh cookie; `x-sx-web` is the
// CSRF marker the server requires on refresh/logout (a cross-site page cannot
// set it without a CORS preflight the allowlist rejects).
const headers = { "content-type": "application/json", "x-sx-web": "1" };
// Bodyless POSTs must NOT declare a JSON content-type (Fastify rejects an empty
// JSON body with 400). Refresh/logout carry no body — only the CSRF marker.
const csrfHeaders = { "x-sx-web": "1" };

export class AuthError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super(code ?? `auth_${status}`);
  }
}

async function errorOf(res: Response): Promise<string | undefined> {
  return res
    .json()
    .then((b) => (b as { error?: string }).error)
    .catch(() => undefined);
}

export async function apiRegister(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<void> {
  const res = await fetch(`${bffUrl}/auth/register`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new AuthError(res.status, await errorOf(res));
}

export async function apiLogin(input: {
  email: string;
  password: string;
}): Promise<{ accessToken: string; user: SessionUser }> {
  const res = await fetch(`${bffUrl}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new AuthError(res.status, await errorOf(res));
  return res.json();
}

/** Silent refresh: mint a new access token from the HttpOnly cookie. */
export async function apiRefresh(): Promise<string | null> {
  const res = await fetch(`${bffUrl}/auth/refresh`, {
    method: "POST",
    credentials: "include",
    headers: csrfHeaders,
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { accessToken?: string } | null;
  return body?.accessToken ?? null;
}

export async function apiLogout(token: string | null): Promise<void> {
  await fetch(`${bffUrl}/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: { ...csrfHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }).catch(() => {});
}

/**
 * Change the password. The server revokes ALL sessions on success, so the caller
 * must drop local auth state and send the user back to login (P2-4).
 */
export async function apiChangePassword(
  token: string | null,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const res = await fetch(`${bffUrl}/auth/change-password`, {
    method: "POST",
    credentials: "include",
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new AuthError(res.status, await errorOf(res));
}
