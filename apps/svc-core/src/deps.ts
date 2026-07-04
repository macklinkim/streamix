import { createDb, type Database } from "@streamix/db";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const db: Database = createDb(env.DATABASE_URL);
export const redis = new Redis(env.REDIS_URL);
