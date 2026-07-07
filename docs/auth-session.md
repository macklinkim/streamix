# Auth & session hardening

How Streamix stores credentials and manages sessions. Supersedes the earlier
`localStorage` access-token scheme.

## Threat model addressed

| Weakness (before)                                             | Mitigation                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Access token in `localStorage` → stealable by any XSS         | Access token is **memory-only**; long-lived refresh credential is an **HttpOnly cookie** JS can never read            |
| Refresh token was a stateless JWT, replayable forever         | Refresh is an **opaque, server-side, rotating** token with **reuse detection**                                        |
| No server-side revocation (logout couldn't kill a leaked JWT) | Redis session store + **access-token jti denylist**                                                                   |
| Password hashing                                              | Already **Argon2id** (`svc-core/src/auth/password.ts`) — unchanged, node-argon2 defaults (argon2id, 64 MiB, t=3, p=4) |

## Token model

- **Access token** — HS256 JWT, `typ=access`, carries a `jti`, TTL `ACCESS_TTL`
  (default 15m). Minted by the BFF. Sent as `Authorization: Bearer` on Connect
  RPCs. Held in memory (Zustand), never persisted.
- **Refresh token** — opaque random sid (`crypto.randomUUID`), stored in Redis,
  delivered **only** as the `sx_rt` HttpOnly cookie (`Path=/auth`, so it is sent
  to the refresh/logout routes and nowhere else).

## Flows (BFF, `apps/bff/src/routes/auth.ts`)

- `POST /auth/register` → svc-core (Argon2 hash) → user.
- `POST /auth/login` → svc-core verifies password → BFF mints access token +
  creates a refresh session → `Set-Cookie: sx_rt=...` + `{ accessToken, user }`.
- `POST /auth/refresh` → reads cookie → **rotates** the session (new sid, old
  marked used) → new access token + new cookie. Silent, called on page load and
  on any `Unauthenticated` Connect response (interceptor in `web/lib/connect.ts`).
- `POST /auth/logout` → revokes the session family + denylists the presented
  access token's `jti` → clears the cookie.

## Rotation, reuse detection, sliding window (`apps/bff/src/session.ts`)

A **family** is one login lineage. Every refresh rotates the sid and marks the
old one `used` (kept `GRACE_SEC`=60s so a concurrent double-refresh race doesn't
misfire). Presenting an already-`used` sid means the token was replayed (stolen)
→ the **entire family is revoked** (all rotations dead). Sliding window: each
rotation renews the family TTL to `REFRESH_TTL_DAYS` (30d), capped absolutely at
`REFRESH_ABS_MAX_DAYS` (90d). `revokeUser(userId)` force-logs-out every family of
a user (ready for an admin/password-change surface; not yet wired to an RPC).

## CSRF

The refresh cookie is the only ambient credential on `/auth/refresh` + `/auth/logout`.
Both require the custom header `x-sx-web: 1`; a cross-site page cannot set a
custom header without a CORS preflight, which the BFF origin allowlist rejects.

## Deployment note — SameSite (IMPORTANT)

Prod is **split-origin**: web `*.vercel.app`, BFF `*.fly.dev` = cross-site.
`SameSite=Strict`/`Lax` cookies are **not sent cross-site**, so the refresh
cookie needs `SameSite=None; Secure` in prod. Configure on the BFF (Fly secrets):

```
COOKIE_SAMESITE=none
COOKIE_SECURE=true
CORS_ORIGINS=https://streamix-web.vercel.app
```

Dev (localhost:3000 ↔ :8080 = same-site) defaults to `SameSite=Lax`.
True `SameSite=Strict` (the strongest posture) requires a **same-origin** deploy
(e.g. proxy the BFF under the Next.js origin); documented as a known deviation
from the original request, driven by the current split-origin topology.

## Redis outage behavior

Consistent with the repo's availability-first degradation: session
create/rotate/denylist fail **open** on a Redis outage (login still yields a 15m
access token; a revoked jti is not enforced only while Redis is down). Refresh
validation fails closed (can't validate → re-login).

## Smoke

`apps/bff/scripts/smoke-session.ts` — cookie flags, rotation, reuse detection
(family revoke), CSRF guard, logout revocation, access-token denylist. 15/15.
