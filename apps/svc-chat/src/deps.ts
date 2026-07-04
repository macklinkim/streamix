import { Redis } from "ioredis";
import { env } from "./env.js";

// Publisher / general command connection. Fail fast + never crash on outage
// (§10 graceful degradation); callers surface "unavailable" instead.
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on("error", () => {});

// ioredis requires a dedicated connection in subscriber mode (one per Join).
export function createSubscriber(): Redis {
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  sub.on("error", () => {});
  return sub;
}

export function chatChannel(channelId: string): string {
  return `chat:${channelId}`;
}
