import { Redis } from "ioredis";
import { env } from "./env.js";

// Shared command connection (rate limits, viewers). Subscribers need their own.
// Fail fast + never crash on outage (§10 graceful degradation).
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on("error", () => {});

export const createSubscriber = (): Redis => {
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  sub.on("error", () => {});
  return sub;
};
