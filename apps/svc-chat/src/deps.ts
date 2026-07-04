import { Redis } from "ioredis";
import { env } from "./env.js";

// Publisher / general command connection.
export const redis = new Redis(env.REDIS_URL);

// ioredis requires a dedicated connection in subscriber mode (one per Join).
export function createSubscriber(): Redis {
  return new Redis(env.REDIS_URL);
}

export function chatChannel(channelId: string): string {
  return `chat:${channelId}`;
}
