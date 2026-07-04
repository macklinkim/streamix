import { join } from "node:path";
import { z } from "zod";

const Env = z.object({
  RTMP_PORT: z.coerce.number().default(1935),
  HTTP_PORT: z.coerce.number().default(8090),
  CORE_URL: z.string().default("http://localhost:50051"),
  MEDIA_ROOT: z.string().default(join(process.cwd(), "hls-tmp")),
});

export const env = Env.parse(process.env);
