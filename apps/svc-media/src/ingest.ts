import { spawn } from "node:child_process";
import type { Server } from "node:http";
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
          "-g",
          "60",
          "-c:a",
          "aac",
          "-ar",
          "44100",
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

      ws.on("message", (chunk: Buffer) => {
        if (!ff.stdin.destroyed) ff.stdin.write(chunk);
      });
      ws.on("close", () => {
        if (!ff.stdin.destroyed) ff.stdin.end(); // EOF -> ffmpeg flushes -> RTMP unpublish
        setTimeout(() => ff.kill("SIGKILL"), 5000).unref();
      });
    })();
  });

  console.log("svc-media ws ingest on /ingest");
}
