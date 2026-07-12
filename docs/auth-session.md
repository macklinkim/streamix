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

- **Access token** — HS256 JWT, `typ=access`, `iss=streamix-bff`,
  `aud=streamix-web`, carries a `jti` (mandatory — tokens without one are
  rejected) and a `fam` claim binding it to its refresh family, TTL `ACCESS_TTL`
  (default 15m). Minted by the BFF; verification pins algorithm, issuer, and
  audience. Sent as `Authorization: Bearer` on Connect RPCs. Held in memory
  (Zustand), never persisted.
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
  access token's `jti` → clears the cookie. Because every access token carries
  its family in `fam`, revoking the family also kills **all** access tokens it
  ever issued (family-wide marker, TTL = access TTL), not just the presented one.

The Connect `AuthService` `Register`/`Login`/`Refresh` RPCs are **blocked**
(`PermissionDenied`) on the public BFF: they returned stateless 30d refresh JWTs
that bypassed this session model entirely. Browsers must use the REST routes
above. (svc-core still implements the stateless RPCs internally; removing them
is tracked as separate structural work.)

## Rotation, reuse detection, sliding window (`apps/bff/src/session.ts`)

A **family** is one login lineage. Validation + rotation run as a **single
atomic Redis Lua script** — two concurrent refreshes with the same sid cannot
both mint live successors. Within a short grace window (`REFRESH_GRACE_MS`,
default 3s) replaying the just-used sid idempotently returns the **same**
successor (concurrent double-refresh race); past the grace, a replay means the
token was stolen → the **entire family is revoked** (all rotations dead, plus
every access token minted under the family via the `fam` marker). Used sids
persist as tombstones for the full sliding window, so late replays are still
detected. Sliding window: each rotation renews the family TTL to
`REFRESH_TTL_DAYS` (30d), capped absolutely at `REFRESH_ABS_MAX_DAYS` (90d).
`revokeUser(userId)` force-logs-out every family of a user (ready for an
admin/password-change surface; not yet wired to an RPC).

Known limitation: within the grace window a stolen sid replayed by an attacker
receives the same successor as the legitimate client (the window is why it is
kept at seconds). Removing the grace entirely requires client-side refresh
single-flight — tracked as follow-up work.

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

## Production fail-fast

In `NODE_ENV=production` the BFF refuses to boot on dev-default or short (<32
char) `JWT_SECRET`, missing `REDIS_URL`/`CORS_ORIGINS`, `COOKIE_SECURE` unset,
or `COOKIE_SAMESITE` other than `none` (split-origin requirement above).
svc-core and svc-media apply the same policy to their secrets.

## Smoke

`apps/bff/scripts/smoke-session.ts` — cookie flags, rotation, grace-window
idempotency, 20-way concurrent refresh (single successor), post-grace reuse
detection (family revoke incl. family-wide access-token kill), public Connect
credential-RPC block, CSRF guard, logout revocation, access-token denylist.
21/21.
