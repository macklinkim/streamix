import { join } from "node:path";
import { z } from "zod";

const Env = z.object({
  RTMP_PORT: z.coerce.number().default(1935),
  HTTP_PORT: z.coerce.number().default(8090),
  CORE_URL: z.string().default("http://localhost:50051"),
  MEDIA_ROOT: z.string().default(join(process.cwd(), "hls-tmp")),
  // Playback URL signing (§5.2). MUST match svc-core's PLAYBACK_SECRET.
  PLAYBACK_SECRET: z.string().default("dev-insecure-playback-secret"),
});

export const env = Env.parse(process.env);
