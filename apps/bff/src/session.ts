import { redis } from "./redis.js";
import { env } from "./env.js";

// Server-side rotating refresh sessions (§ auth hardening).
//
// A "family" is one login lineage. Every /auth/refresh rotates the sid to a new
// one and marks the old used. Presenting an already-used sid means the token was
// replayed (stolen) — we revoke the entire family (reuse detection). Sliding
// window: each rotation renews the family TTL up to an absolute cap.
//
// Keys:
//   refresh:{sid}   HASH {userId, family, born, used}   EXPIRE = sliding window
//   fam:{family}    SET  of live sids                   EXPIRE = sliding window
//   usess:{userId}  SET  of families (admin force-logout) EXPIRE = sliding window

const slidingSec = () => env.REFRESH_TTL_DAYS * 86400;
const absMaxMs = () => env.REFRESH_ABS_MAX_DAYS * 86400 * 1000;
const GRACE_SEC = 60; // used-token lingers this long so concurrent refresh races don't trip reuse

const rk = (sid: string) => `refresh:${sid}`;
const fk = (family: string) => `fam:${family}`;
const uk = (userId: string) => `usess:${userId}`;

export type RotateResult =
  | { status: "ok"; userId: string; sid: string }
  | { status: "invalid" }
  | { status: "reuse" }
  | { status: "expired" };

/** Create a fresh session family. Returns the sid to put in the cookie, or null on outage. */
export async function createSession(userId: string): Promise<string | null> {
  const family = crypto.randomUUID();
  const sid = crypto.randomUUID();
  const ttl = slidingSec();
  try {
    await redis
      .multi()
      .hset(rk(sid), { userId, family, born: Date.now().toString(), used: "0" })
      .expire(rk(sid), ttl)
      .sadd(fk(family), sid)
      .expire(fk(family), ttl)
      .sadd(uk(userId), family)
      .expire(uk(userId), ttl)
      .exec();
    return sid;
  } catch {
    return null; // Redis down: login still succeeds, session limited to access TTL.
  }
}

async function revokeFamily(family: string, userId: string): Promise<void> {
  const sids = await redis.smembers(fk(family));
  const pipe = redis.multi();
  for (const s of sids) pipe.del(rk(s));
  pipe.del(fk(family)).srem(uk(userId), family);
  await pipe.exec();
}

/** Validate + rotate a refresh sid. Detects replay of an already-rotated token. */
export async function rotateSession(sid: string): Promise<RotateResult> {
  let cur: Record<string, string>;
  try {
    cur = await redis.hgetall(rk(sid));
  } catch {
    return { status: "invalid" }; // outage: cannot validate, force re-login.
  }
  if (!cur.userId) return { status: "invalid" };

  const userId = cur.userId;
  const { family = "", born = "0", used = "0" } = cur;
  if (used === "1") {
    await revokeFamily(family, userId); // replay of a used token => stolen. Kill family.
    return { status: "reuse" };
  }
  if (Date.now() - Number(born) > absMaxMs()) {
    await revokeFamily(family, userId);
    return { status: "expired" };
  }

  const newSid = crypto.randomUUID();
  const ttl = slidingSec();
  await redis
    .multi()
    .hset(rk(sid), "used", "1")
    .expire(rk(sid), GRACE_SEC)
    .hset(rk(newSid), { userId, family, born, used: "0" })
    .expire(rk(newSid), ttl)
    .sadd(fk(family), newSid)
    .srem(fk(family), sid)
    .expire(fk(family), ttl)
    .expire(uk(userId), ttl)
    .exec();
  return { status: "ok", userId, sid: newSid };
}

/** Revoke the session family behind this sid (logout). No-op if already gone. */
export async function revokeSession(sid: string): Promise<void> {
  try {
    const cur = await redis.hgetall(rk(sid));
    if (cur.userId && cur.family) await revokeFamily(cur.family, cur.userId);
  } catch {
    // outage: nothing to do; the token still expires on its own.
  }
}

/** Force-logout every session of a user (admin / password change). */
export async function revokeUser(userId: string): Promise<number> {
  try {
    const families = await redis.smembers(uk(userId));
    for (const f of families) await revokeFamily(f, userId);
    await redis.del(uk(userId));
    return families.length;
  } catch {
    return 0;
  }
}
