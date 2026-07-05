import { spawn } from "node:child_process";
import type { Server } from "node:http";
import type { Writable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import ffmpegStatic from "ffmpeg-static";
import { env } from "./env.js";
import { core } from "./core-client.js";

const ffmpeg = ffmpegStatic as unknown as string;

// ADR-9 codec negotiation: the studio page picks a MediaRecorder format the
// server can remux cheaply and passes its label as ?codec=. Copy paths skip
// re-encoding entirely (max CPU saving); everything else falls back to the
// M1 rate-controlled transcode for backward compatibility.
function codecArgs(codec: string): string[] {
  if (codec === "mp4-h264") {
    // fMP4 (H.264 + AAC): both streams FLV-compatible -> full copy, zero encode.
    return ["-c:v", "copy", "-c:a", "copy"];
  }
  if (codec === "webm-h264") {
    // H.264 video copies; Opus audio must become AAC (FLV can't carry Opus).
    return ["-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "128k"];
  }
  // VP8 / unspecified: full transcode with M1 rate control (§1.2 결함 3~5).
  const bitrate = env.INGEST_VIDEO_BITRATE; // e.g. "2500k"
  const bufsize = `${parseInt(bitrate, 10) * 2}${bitrate.replace(/[0-9]/g, "")}`;
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    bitrate,
    "-maxrate",
    bitrate,
    "-bufsize",
    bufsize,
    "-force_key_frames",
    "expr:gte(t,n_forced*2)",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "128k",
  ];
}

// Browser broadcast ingest (F: screen share). The studio page pipes
// MediaRecorder webm chunks over WS; ffmpeg transcodes stdin -> local RTMP,
// so the existing publish pipeline (key validation, SET NX single writer,
// HLS packaging, thumbnails, heartbeat, donePublish teardown) is reused as-is.
export function attachIngest(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ingest" });

  wss.on("connection", (ws: WebSocket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const streamKey = url.searchParams.get("key") ?? "";
    const codec = url.searchParams.get("codec") ?? "";

    // Attach the message handler SYNCHRONOUSLY and buffer until ffmpeg is up:
    // the first chunk carries the webm EBML header, and dropping it during the
    // key-validation await leaves ffmpeg with an unparseable stream.
    const pending: Buffer[] = [];
    let sink: Writable | null = null;
    let closed = false;
    const bufferLimit = env.INGEST_BUFFER_LIMIT_MB * 1024 * 1024;
    ws.on("message", (chunk: Buffer) => {
      if (sink) {
        if (sink.destroyed) return;
        const ok = sink.write(chunk);
        // A stalled/slow ffmpeg lets unflushed bytes pile up in the Node writable
        // buffer. Cap it so one wedged encoder can't OOM svc-media: drop the
        // connection and let the close handler flush/kill ffmpeg. (§1.2 결함 6, G5)
        if (!ok && sink.writableLength > bufferLimit) {
          ws.close(4009, "ingest backpressure");
        }
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

      const ff = spawn(
        ffmpeg,
        [
          "-i",
          "pipe:0",
          ...codecArgs(codec),
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
