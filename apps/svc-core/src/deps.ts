import { createDb, type Database } from "@streamix/db";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const db: Database = createDb(env.DATABASE_URL);

// Fail commands fast on outage (don't hang) and never crash on a connection
// error — callers degrade gracefully (§10 Redis SPOF fallback).
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on("error", () => {});
