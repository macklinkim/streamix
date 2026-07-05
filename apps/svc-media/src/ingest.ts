import { spawn } from "node:child_process";
import type { Server } from "node:http";
import type { Writable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import ffmpegStatic from "ffmpeg-static";
import { env } from "./env.js";
import { core } from "./core-client.js";

const ffmpeg = ffmpegStatic as unknown as string;

// Browser broadcast ingest (F: screen share). The studio page pipes
// MediaRecorder webm chunks over WS; ffmpeg transcodes stdin -> local RTMP,
// so the existing publish pipeline (key validation, SET NX single writer,
// HLS packaging, thumbnails, heartbeat, donePublish teardown) is reused as-is.
export function attachIngest(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ingest" });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const streamKey = url.searchParams.get("key") ?? "";

    // Attach the message handler SYNCHRONOUSLY and buffer until ffmpeg is up:
    // the first chunk carries the webm EBML header, and dropping it during the
    // key-validation await leaves ffmpeg with an unparseable stream.
    const pending: Buffer[] = [];
    let sink: Writable | null = null;
    let closed = false;
    ws.on("message", (chunk: Buffer) => {
      if (sink) {
        if (!sink.destroyed) sink.write(chunk);
      } else {
        pending.push(chunk);
      }
    });
    ws.on("close", () => {
      closed = true;
      if (sink && !sink.destroyed) sink.end(); // EOF -> ffmpeg flush -> RTMP unpublish
    });

    void (async () => {
      // Fast-reject bad keys before spawning ffmpeg (NMS would also reject,
      // but only after the RTMP handshake — this gives the browser a clean error).
      try {
        const { valid } = await core.validateStreamKey({ streamKey });
        if (!valid) {
          ws.close(4403, "invalid stream key");
          return;
        }
      } catch {
        ws.close(1011, "core unavailable");
        return;
      }
      if (closed) return;

      const bitrate = env.INGEST_VIDEO_BITRATE; // e.g. "2500k"
      const bufsize = `${parseInt(bitrate, 10) * 2}${bitrate.replace(/[0-9]/g, "")}`;
      const ff = spawn(
        ffmpeg,
        [
          "-i",
          "pipe:0",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          // Rate control: cap output so scene complexity can't spike bitrate and
          // stall viewers (§1.2 결함 3). maxrate=b:v with a 2x bufsize (CBR-ish).
          "-b:v",
          bitrate,
          "-maxrate",
          bitrate,
          "-bufsize",
          bufsize,
          // 2s keyframes independent of source fps (§1.2 결함 4), aligned to hls_time=2.
          "-force_key_frames",
          "expr:gte(t,n_forced*2)",
          "-c:a",
          "aac",
          // Keep MediaRecorder's 48kHz Opus; drop the needless 44.1k resample (§1.2 결함 5).
          "-ar",
          "48000",
          "-b:a",
          "128k",
          "-f",
          "flv",
          `rtmp://127.0.0.1:${env.RTMP_PORT}/live/${streamKey}`,
        ],
        { stdio: ["pipe", "ignore", "inherit"] },
      );
      ff.stdin.on("error", () => {}); // EPIPE when ffmpeg dies mid-write

      ff.on("close", (code) => {
        // NMS rejecting the publish (key race / already live) also lands here.
        if (ws.readyState === ws.OPEN) ws.close(1011, `encoder exited (${code})`);
      });

      for (const chunk of pending) ff.stdin.write(chunk);
      pending.length = 0;
      sink = ff.stdin;
      if (closed) ff.stdin.end(); // ws closed during validation -> flush + teardown
      ws.on("close", () => {
        setTimeout(() => ff.kill("SIGKILL"), 5000).unref(); // backstop if EOF hangs
      });
    })();
  });

  console.log("svc-media ws ingest on /ingest");
}
