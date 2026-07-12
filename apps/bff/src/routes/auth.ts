import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Code, ConnectError } from "@connectrpc/connect";
import { coreAuth } from "../clients.js";
import { mintAccess, denylistJti } from "../token.js";
import { tokenMeta, bearer } from "../auth.js";
import { createSession, rotateSession, revokeSession } from "../session.js";
import { refreshCookie, clearCookie, readRefreshCookie } from "../cookies.js";
import { overLimitAuth } from "../rate-limit.js";
import { env } from "../env.js";

// Cookie-based browser session surface (§ auth hardening). The browser holds
// only a short-lived access token in memory; the long-lived rotating refresh
// token lives solely in an HttpOnly cookie the JS can never read (XSS-safe).
//
// The Connect AuthService (login/refresh over gRPC) is retained for internal /
// programmatic callers; browsers use these routes instead.

// CSRF guard for cookie-authenticated state-changing routes: a custom header a
// cross-site page cannot set without a CORS preflight our allowlist rejects.
function csrfOk(req: FastifyRequest): boolean {
  return req.headers["x-sx-web"] === "1";
}

// Global in-flight ceiling for Argon2-burning endpoints (register/login). Last
// line of defense if per-IP limits fail (proxy misdetection, botnet): core CPU
// stays bounded regardless (inbox/review.md V1-3).
const MAX_INFLIGHT_AUTH = 16;
let inflightAuth = 0;

// Proto User -> plain JSON. Timestamp fields carry BigInt (unserializable by
// Fastify) and the browser only needs identity + display name.
type ProtoUser = { id: string; email: string; displayName: string } | undefined;
function toSessionUser(u: ProtoUser) {
  return u ? { id: u.id, email: u.email, displayName: u.displayName } : null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (req, reply) => {
    // IP-keyed throttle: every register triggers an Argon2 hash in svc-core, so
    // an unauthenticated flood is a CPU-exhaustion vector (inbox/review.md P0-3).
    if (
      await overLimitAuth(
        `rl:auth:register:ip:${req.ip}`,
        env.RATE_LIMIT_AUTH_MAX,
        env.RATE_LIMIT_AUTH_WINDOW,
      )
    ) {
      return reply.code(429).send({ error: "too many attempts" });
    }
    if (inflightAuth >= MAX_INFLIGHT_AUTH) {
      return reply.code(503).send({ error: "auth busy, retry" });
    }
    const body = (req.body ?? {}) as { email?: string; password?: string; displayName?: string };
    inflightAuth += 1;
    try {
      const res = await coreAuth.register({
        email: body.email ?? "",
        password: body.password ?? "",
        displayName: body.displayName ?? "",
      });
      return reply.code(201).send({ user: toSessionUser(res.user) });
    } catch (e) {
      return sendConnectError(reply, e);
    } finally {
      inflightAuth -= 1;
    }
  });

  app.post("/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = body.email ?? "";
    // Rate-limit key is canonicalized so case/whitespace variants of one email
    // share a window; the upstream login call keeps the raw value.
    const emailKey = email.trim().toLowerCase();
    // Per-email brute-force guard plus an IP-keyed limit so an attacker cannot
    // dodge throttling by rotating emails (credential stuffing / Argon2 burn).
    const [byEmail, byIp] = await Promise.all([
      overLimitAuth(
        `rl:auth:login:${emailKey}`,
        env.RATE_LIMIT_AUTH_MAX,
        env.RATE_LIMIT_AUTH_WINDOW,
      ),
      overLimitAuth(
        `rl:auth:login:ip:${req.ip}`,
        env.RATE_LIMIT_AUTH_MAX,
        env.RATE_LIMIT_AUTH_WINDOW,
      ),
    ]);
    if (byEmail || byIp) {
      return reply.code(429).send({ error: "too many attempts" });
    }
    if (inflightAuth >= MAX_INFLIGHT_AUTH) {
      return reply.code(503).send({ error: "auth busy, retry" });
    }
    inflightAuth += 1;
    try {
      const res = await coreAuth.login({ email, password: body.password ?? "" });
      const userId = res.user!.id;
      const session = await createSession(userId);
      // fam claim ties this access token to the refresh family so revoking the
      // family (logout / reuse) kills it too (P1-1). No session on a Redis
      // outage -> token has no fam and simply expires naturally.
      const { token } = await mintAccess(userId, session?.family);
      if (session) reply.header("set-cookie", refreshCookie(session.sid));
      return reply.code(200).send({ accessToken: token, user: toSessionUser(res.user) });
    } catch (e) {
      return sendConnectError(reply, e);
    } finally {
      inflightAuth -= 1;
    }
  });

  app.post("/auth/refresh", async (req, reply) => {
    if (!csrfOk(req)) return reply.code(403).send({ error: "csrf" });
    const sid = readRefreshCookie(req.headers.cookie);
    if (!sid) return reply.code(401).send({ error: "no session" });

    const r = await rotateSession(sid);
    if (r.status !== "ok") {
      reply.header("set-cookie", clearCookie());
      return reply.code(401).send({ error: r.status }); // invalid | reuse | expired
    }
    const { token } = await mintAccess(r.userId, r.family);
    reply.header("set-cookie", refreshCookie(r.sid));
    return reply.code(200).send({ accessToken: token });
  });

  app.post("/auth/logout", async (req, reply) => {
    if (!csrfOk(req)) return reply.code(403).send({ error: "csrf" });
    const sid = readRefreshCookie(req.headers.cookie);
    if (sid) await revokeSession(sid);
    // Also revoke the presented access token immediately (denylist by jti).
    const meta = await tokenMeta(bearer(req.headers.authorization));
    if (meta) await denylistJti(meta.jti, meta.ttl);
    reply.header("set-cookie", clearCookie());
    return reply.code(204).send();
  });
}

function sendConnectError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ConnectError) {
    switch (e.code) {
      case Code.Unauthenticated:
        return reply.code(401).send({ error: "invalid credentials" });
      case Code.AlreadyExists:
        return reply.code(409).send({ error: "email already exists" });
      case Code.InvalidArgument:
        return reply.code(400).send({ error: e.rawMessage });
      case Code.ResourceExhausted:
        return reply.code(429).send({ error: "rate limited" });
      default:
        return reply.code(502).send({ error: "upstream unavailable" });
    }
  }
  return reply.code(500).send({ error: "internal" });
}
