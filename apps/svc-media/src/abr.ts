import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import ffmpegStatic from "ffmpeg-static";
import { env, m5 } from "./env.js";

// Publish credential for a channel's rendition path, checked by the MediaMTX
// auth hook. Derived from the internal service secret so outsiders can't
// publish into `abr/<channelId>` and hijack a quality level.
const abrSecret = (channelId: string) =>
  createHmac("sha256", env.INTERNAL_TOKEN).update(`abr.${channelId}`).digest("hex");
export function abrCredentialValid(channelId: string, password: string | undefined): boolean {
  const expected = abrSecret(channelId);
  return (
    typeof password === "string" &&
    password.length === expected.length &&
    timingSafeEqual(Buffer.from(password), Buffer.from(expected))
  );
}

const ffmpeg = ffmpegStatic as unknown as string;

// MediaMTX path of a channel's extra 480p rendition. It is published from
// loopback only (see the auth hook in main.ts) and never treated as a broadcast.
export const ABR_PREFIX = "abr/";
export const abrPath = (channelId: string) => `${ABR_PREFIX}${channelId}`;

let active = 0;

// Quality ladder (benchmark G-05): transcode the source to 480p and publish it as
// a second MediaMTX path; hls-server merges both into one multivariant playlist.
// Returns a stop function, or a no-op when disabled or at the transcode cap.
export function startRendition(channelId: string, mtxPath: string): () => void {
  if (!m5.ABR_ENABLED || active >= m5.ABR_MAX_TRANSCODES) return () => {};
  active += 1;
  const rtmp = `rtmp://127.0.0.1:${env.RTMP_PORT}`;
  const ff = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      `${rtmp}/${mtxPath}`,
      "-vf",
      "scale=-2:480",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-b:v",
      m5.ABR_VIDEO_BITRATE,
      "-maxrate",
      m5.ABR_VIDEO_BITRATE,
      "-bufsize",
      `${parseInt(m5.ABR_VIDEO_BITRATE, 10) * 2}k`,
      // 1s GOP so MediaMTX can cut the same 1s segments as the source path.
      "-force_key_frames",
      "expr:gte(t,n_forced*1)",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-f",
      "flv",
      `${rtmp}/${abrPath(channelId)}?user=abr&pass=${abrSecret(channelId)}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  ff.stderr.on("data", (d: Buffer) => console.warn(`[abr ${channelId}] ${d.toString().trim()}`));
  let done = false;
  ff.on("exit", () => {
    if (!done) active -= 1;
    done = true;
  });
  return () => {
    if (ff.exitCode === null) ff.kill("SIGKILL");
  };
}
