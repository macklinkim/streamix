import { join } from "node:path";
import { z } from "zod";

const Env = z.object({
  RTMP_PORT: z.coerce.number().default(1935),
  HTTP_PORT: z.coerce.number().default(8090),
  CORE_URL: z.string().default("http://localhost:50051"),
  MEDIA_ROOT: z.string().default(join(process.cwd(), "hls-tmp")),
  // Playback URL signing (§5.2). MUST match svc-core's PLAYBACK_SECRET.
  PLAYBACK_SECRET: z.string().default("dev-insecure-playback-secret"),
  THUMB_INTERVAL_SECONDS: z.coerce.number().default(15),
  // A channel dir with no HLS update for this long is reaped (§ ADR-3 retention).
  RETENTION_TTL_SECONDS: z.coerce.number().default(120),
  // Browser-ingest transcode target bitrate (b:v = maxrate, bufsize = 2x). §1.2 결함 3.
  INGEST_VIDEO_BITRATE: z.string().default("2500k"),
  // Max unflushed ingest bytes buffered for a stalled ffmpeg before we drop the
  // connection (4009). Caps svc-media heap growth under backpressure. §1.2 결함 6.
  INGEST_BUFFER_LIMIT_MB: z.coerce.number().default(64),
  // Comma-separated browser origins allowed to open /ingest WebSockets. Empty =
  // no origin filtering (dev / non-browser encoders). Prod: the web origin
  // (inbox/review.md V2-5).
  INGEST_ALLOWED_ORIGINS: z.string().default(""),
});

export const env = Env.parse(process.env);
export const thumbRoot = join(env.MEDIA_ROOT, "_thumbs");

// Fail fast in production instead of booting on the known dev playback secret,
// which would let anyone forge signed HLS URLs (inbox/review.md P1-2).
if (process.env.NODE_ENV === "production") {
  const errors: string[] = [];
  if (!process.env.PLAYBACK_SECRET || env.PLAYBACK_SECRET === "dev-insecure-playback-secret")
    errors.push("PLAYBACK_SECRET must be set (no dev default)");
  else if (env.PLAYBACK_SECRET.length < 32)
    errors.push("PLAYBACK_SECRET must be at least 32 characters");
  if (errors.length > 0) {
    console.error(`[svc-media] fatal production config errors:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
}

// --- ADR-10: MediaMTX LL-HLS plane (appended; see M3 in 작업계획서-개선.md) ---
// New vars only, kept at file end to avoid churn in the schema above.
const MtxEnv = z.object({
  // MediaMTX HLS origin the signed proxy (hls-server.ts) fetches from.
  MEDIAMTX_HLS_ORIGIN: z.string().default("http://127.0.0.1:8888"),
  // MediaMTX control API (paths/list) used to detect publish end.
  MEDIAMTX_API_ORIGIN: z.string().default("http://127.0.0.1:9997"),
  // Internal-only HTTP port that MediaMTX's http auth posts to (publish authz).
  MEDIA_INTERNAL_PORT: z.coerce.number().default(8091),
});
const mtxEnv = MtxEnv.parse(process.env);
export const mtx = {
  hlsOrigin: mtxEnv.MEDIAMTX_HLS_ORIGIN,
  apiOrigin: mtxEnv.MEDIAMTX_API_ORIGIN,
  internalPort: mtxEnv.MEDIA_INTERNAL_PORT,
};
