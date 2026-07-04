import { Redis } from "ioredis";
import { env } from "./env.js";

// Shared command connection (rate limits, viewers). Subscribers need their own.
export const redis = new Redis(env.REDIS_URL);
export const createSubscriber = (): Redis => new Redis(env.REDIS_URL);
