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
// Within this window, replaying a just-used sid idempotently returns the SAME
// successor (concurrent refresh race). Outside it, replay = theft => family kill.
const GRACE_MS = 60_000;

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

// Atomic validate+rotate (inbox/review.md P0-2). The old read-then-write flow
// let two concurrent requests both see used=0 and each mint a live successor.
// One Lua script now does check / used-flip / successor-create / family-update
// in a single step. The used sid stays as a tombstone for the full sliding
// window (not 60s) so late replays are still detected as theft; replays inside
// GRACE_MS idempotently return the already-minted successor instead of killing
// the family.
const ROTATE_LUA = `
local sidKey = KEYS[1]
local now = tonumber(ARGV[1])
local graceMs = tonumber(ARGV[2])
local absMaxMs = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local newSid = ARGV[5]

local cur = redis.call('HGETALL', sidKey)
if #cur == 0 then return {'invalid'} end
local h = {}
for i = 1, #cur, 2 do h[cur[i]] = cur[i + 1] end
local userId, family, born = h['userId'], h['family'], tonumber(h['born'] or '0')

local function revokeFamily()
  local famKey = 'fam:' .. family
  local sids = redis.call('SMEMBERS', famKey)
  for _, s in ipairs(sids) do redis.call('DEL', 'refresh:' .. s) end
  redis.call('DEL', famKey)
  redis.call('SREM', 'usess:' .. userId, family)
  redis.call('DEL', sidKey)
end

if h['used'] == '1' then
  local next = h['next']
  if next and (now - tonumber(h['usedAt'] or '0')) <= graceMs
     and redis.call('EXISTS', 'refresh:' .. next) == 1 then
    return {'ok', userId, next}
  end
  revokeFamily()
  return {'reuse'}
end
if now - born > absMaxMs then
  revokeFamily()
  return {'expired'}
end

redis.call('HSET', sidKey, 'used', '1', 'usedAt', tostring(now), 'next', newSid)
redis.call('EXPIRE', sidKey, ttl)
redis.call('HSET', 'refresh:' .. newSid,
  'userId', userId, 'family', family, 'born', tostring(born), 'used', '0')
redis.call('EXPIRE', 'refresh:' .. newSid, ttl)
local famKey = 'fam:' .. family
redis.call('SADD', famKey, newSid)
redis.call('EXPIRE', famKey, ttl)
redis.call('EXPIRE', 'usess:' .. userId, ttl)
return {'ok', userId, newSid}
`;

/** Validate + rotate a refresh sid. Detects replay of an already-rotated token. */
export async function rotateSession(sid: string): Promise<RotateResult> {
  let res: string[];
  try {
    res = (await redis.eval(
      ROTATE_LUA,
      1,
      rk(sid),
      Date.now().toString(),
      GRACE_MS.toString(),
      absMaxMs().toString(),
      slidingSec().toString(),
      crypto.randomUUID(),
    )) as string[];
  } catch {
    return { status: "invalid" }; // outage: cannot validate, force re-login.
  }
  if (res[0] === "ok") return { status: "ok", userId: res[1]!, sid: res[2]! };
  if (res[0] === "reuse") return { status: "reuse" };
  if (res[0] === "expired") return { status: "expired" };
  return { status: "invalid" };
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
