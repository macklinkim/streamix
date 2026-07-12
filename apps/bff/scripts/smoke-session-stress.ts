// Low-level session stress (inbox/review.md V5-4): hammers rotateSession and
// revokeSession concurrently against a real Redis, then asserts the durable
// guarantees directly on Redis keys — not just via HTTP status. Requires Redis.
//
// Checks:
//  1. N concurrent rotations of one sid -> exactly one live successor.
//  2. rotate racing revoke -> family stays dead; famrev marker exists with a
//     TTL in the sliding-window range; every family sid key is gone.
//  3. after the access-deny marker is manually deleted (simulating access-TTL
//     expiry), the surviving sid still cannot refresh (famrev outlives it).
import { createSession, rotateSession, revokeSession } from "../src/session.js";
import { redis } from "../src/redis.js";
import { env } from "../src/env.js";

let failures = 0;
function ok(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const ROUNDS = 50;
const CONCURRENCY = 20;
const slidingSec = env.REFRESH_TTL_DAYS * 86400;

// 1. Concurrent rotation converges to a single successor, every round.
let singleSuccessorRounds = 0;
for (let i = 0; i < ROUNDS; i++) {
  const s = await createSession(`stress-user-${i}`);
  if (!s) throw new Error("redis unavailable");
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => rotateSession(s.sid)),
  );
  const successors = new Set(
    results.filter((r) => r.status === "ok").map((r) => (r as { sid: string }).sid),
  );
  if (successors.size === 1) singleSuccessorRounds++;
}
ok(
  `concurrent rotation: single successor across ${ROUNDS} rounds`,
  singleSuccessorRounds === ROUNDS,
  `${singleSuccessorRounds}/${ROUNDS}`,
);

// 2. rotate racing revoke -> family dead, famrev present with sane TTL.
let deadAfterRace = 0;
let famrevOk = 0;
const raceRounds = 30;
for (let i = 0; i < raceRounds; i++) {
  const s = await createSession(`race-user-${i}`);
  if (!s) throw new Error("redis unavailable");
  const [rot] = await Promise.all([rotateSession(s.sid), revokeSession(s.sid)]);
  const survivor = rot.status === "ok" ? (rot as { sid: string }).sid : s.sid;
  const after = await rotateSession(survivor);
  if (after.status !== "ok") deadAfterRace++;

  const ttl = await redis.ttl(`famrev:${s.family}`);
  // Marker must exist and live no longer than the sliding window.
  if (ttl > 0 && ttl <= slidingSec) famrevOk++;

  // Every sid key of the family must be gone.
  const famMembers = await redis.smembers(`fam:${s.family}`);
  if (famMembers.length !== 0) deadAfterRace = -1; // force fail
}
ok(
  `logout||rotate: family dead every round`,
  deadAfterRace === raceRounds,
  `${deadAfterRace}/${raceRounds}`,
);
ok(
  `famrev marker present with sliding-window TTL`,
  famrevOk === raceRounds,
  `${famrevOk}/${raceRounds}`,
);

// 3. famrev outlives the access-deny marker: delete deny:fam, surviving sid
//    still can't refresh.
{
  const s = await createSession("outlive-user");
  if (!s) throw new Error("redis unavailable");
  await revokeSession(s.sid);
  await redis.del(`deny:fam:${s.family}`); // simulate access-TTL expiry
  const after = await rotateSession(s.sid);
  ok("refresh blocked after access-deny marker gone", after.status !== "ok", after.status);
}

await redis.quit();
console.log(failures ? `\nSTRESS FAILED (${failures})` : "\nSTRESS OK");
process.exit(failures ? 1 : 0);
