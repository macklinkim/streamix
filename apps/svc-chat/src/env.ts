import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(50052),
  REDIS_URL: z.string().default("redis://localhost:6379"),
});

export const env = Env.parse(process.env);
