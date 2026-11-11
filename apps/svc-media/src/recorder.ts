import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { env, m5 } from "./env.js";
import { core } from "./core-client.js";

const ffmpeg = ffmpegStatic as unknown as string;
export const vodDir = (streamId: string) => join(m5.VOD_ROOT, streamId);

// Replay recorder (benchmark G-15): one ffmpeg per live broadcast reading the
// MediaMTX RTMP path (reads are excluded from publish auth) and copy-remuxing
// to an HLS VOD under VOD_ROOT/<streamId>. Keyed by stream id, so the stream key
// that names the MediaMTX path never reaches disk or the database.
// Returns a stop function for the publish-gone path.
export function startRecording(streamId: string, mtxPath: string): () => void {
  if (!m5.VOD_ENABLED) return () => {};
  const dir = vodDir(streamId);
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const ff = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      `rtmp://127.0.0.1:${env.RTMP_PORT}/${mtxPath}`,
      "-c",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_playlist_type",
      "event",
      "-hls_segment_filename",
      join(dir, "seg%05d.ts"),
      join(dir, "index.m3u8"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  ff.stderr.on("data", (d: Buffer) => console.warn(`[vod ${streamId}] ${d.toString().trim()}`));

  let killTimer: NodeJS.Timeout | undefined;
  ff.on("exit", () => {
    clearTimeout(killTimer);
    void finalize(streamId, startedAt);
  });

  return () => {
    // The source normally ends first (publisher gone -> EOF) and ffmpeg exits on
    // its own; this is the fallback for a stuck reader.
    if (ff.exitCode !== null) return;
    ff.kill("SIGINT");
    killTimer = setTimeout(() => ff.kill("SIGKILL"), 10_000);
  };
}

async function finalize(streamId: string, startedAt: number): Promise<void> {
  const dir = vodDir(streamId);
  const playlist = join(dir, "index.m3u8");
  const tooShort = Date.now() - startedAt < m5.VOD_MIN_SECONDS * 1000;
  if (tooShort || !existsSync(playlist) || !readFileSync(playlist, "utf8").includes(".ts")) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  // A killed ffmpeg leaves an open EVENT playlist; close it so players treat it
  // as a finished VOD (seekable, no reload polling).
  if (!readFileSync(playlist, "utf8").includes("#EXT-X-ENDLIST"))
    appendFileSync(playlist, "#EXT-X-ENDLIST\n");
  try {
    await core.markVodReady({ streamId });
  } catch (e) {
    // ponytail: no retry queue — a core outage at this instant leaves a
    // recording on disk that is never listed; upgrade = retry from the sweep.
    console.warn(`[vod ${streamId}] markVodReady failed`, e);
  }
}
