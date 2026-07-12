import { spawn } from "node:child_process";
import type { Server } from "node:http";
import type { Writable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import ffmpegStatic from "ffmpeg-static";
import { env, ingestAllowedOrigins } from "./env.js";
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
// Channels with an in-flight browser ingest. A second WS for the same channel
// (e.g. camera + screen started at once, fact 7) is rejected 4409 instead of
// silently replacing the publish. Released on WS close, so an ADR-14 restart —
// which closes the old socket before opening a new one — reconnects cleanly.
const activeChannels = new Set<string>();

// Pre-auth flood guards (inbox/review.md P1-4): before key validation returns,
// chunks are only buffered — an attacker opening many bogus connections and
// blasting large frames could exhaust the heap. Cap the per-connection pre-auth
// buffer, single frame size, and total concurrent ingest connections.
const PRE_AUTH_BUFFER_LIMIT = 8 * 1024 * 1024; // MediaRecorder chunks are ~100KB-1MB
const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 32; // well above legit concurrent browser encoders
const HANDSHAKES_PER_MIN = 10; // per source IP; a restart loop stays well under
let liveConnections = 0;

// Per-IP handshake fixed window (V2-5): rejected before the WS upgrade, so a
// connect flood can't even allocate sockets.
const handshakeWindows = new Map<string, { count: number; resetAt: number }>();
function handshakeAllowed(ip: string): boolean {
  const now = Date.now();
  const w = handshakeWindows.get(ip);
  if (!w || now >= w.resetAt) {
    if (handshakeWindows.size > 10_000) handshakeWindows.clear(); // bound memory
    handshakeWindows.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  w.count += 1;
  return w.count <= HANDSHAKES_PER_MIN;
}

export function attachIngest(server: Server): void {
  // Parsed + validated once in env.ts (V7-2) so env checks and runtime agree.
  const allowedOrigins = ingestAllowedOrigins;

  const wss = new WebSocketServer({
    server,
    path: "/ingest",
    maxPayload: MAX_PAYLOAD,
    // Reject at the HTTP upgrade, before a WebSocket ever exists (V2-5):
    // capacity, browser origin allowlist (absent Origin = non-browser encoder,
    // still key-gated below), and per-IP handshake rate.
    verifyClient: ({
      origin,
      req,
    }: {
      origin?: string;
      req: import("node:http").IncomingMessage;
    }) => {
      if (liveConnections >= MAX_CONNECTIONS) return false;
      if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) return false;
      // Behind Fly's proxy the socket peer is the proxy, not the client — every
      // browser would share one 10/min window (V6-1). Fly-Client-IP is set by
      // the Fly edge itself. Staging verification of the real header/XFF chain
      // is still pending; until then this is best-effort client keying.
      const flyClientIp = req.headers["fly-client-ip"];
      const ip =
        (typeof flyClientIp === "string" && flyClientIp) || req.socket.remoteAddress || "?";
      return handshakeAllowed(ip);
    },
  });

  wss.on("connection", (ws: WebSocket, req) => {
    if (liveConnections >= MAX_CONNECTIONS) {
      ws.close(1013, "ingest at capacity"); // Try Again Later (verifyClient race)
      return;
    }
    liveConnections += 1;
    ws.once("close", () => {
      liveConnections -= 1;
    });
    const url = new URL(req.url ?? "/", "http://localhost");
    const streamKey = url.searchParams.get("key") ?? "";
    const codec = url.searchParams.get("codec") ?? "";

    // Attach the message handler SYNCHRONOUSLY and buffer until ffmpeg is up:
    // the first chunk carries the webm EBML header, and dropping it during the
    // key-validation await leaves ffmpeg with an unparseable stream.
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    let sink: Writable | null = null;
    let closed = false;
    let guardedChannel = ""; // set once we hold the dup-ingest guard for a channel
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
        // Not yet authenticated: bound the buffer so a flood of unvalidated
        // connections can't grow the heap while core validation is pending (P1-4).
        pendingBytes += chunk.length;
        if (pendingBytes > PRE_AUTH_BUFFER_LIMIT) {
          ws.close(4009, "pre-auth buffer exceeded");
          return;
        }
        pending.push(chunk);
      }
    });
    ws.on("close", () => {
      closed = true;
      if (guardedChannel) activeChannels.delete(guardedChannel);
      if (sink && !sink.destroyed) sink.end(); // EOF -> ffmpeg flush -> RTMP unpublish
    });

    void (async () => {
      // Fast-reject bad keys before spawning ffmpeg (NMS would also reject,
      // but only after the RTMP handshake — this gives the browser a clean error).
      let channelId: string;
      try {
        const res = await core.validateStreamKey({ streamKey });
        if (!res.valid) {
          ws.close(4403, "invalid stream key");
          return;
        }
        channelId = res.channelId;
      } catch {
        ws.close(1011, "core unavailable");
        return;
      }
      if (closed) return;

      // Reject a second concurrent ingest for the same channel (fact 7). The
      // guard is released on WS close; an ADR-14 restart already closed its old
      // socket, so its new connection is not blocked.
      if (channelId && activeChannels.has(channelId)) {
        ws.close(4409, "channel already ingesting");
        return;
      }
      if (channelId) {
        activeChannels.add(channelId);
        guardedChannel = channelId;
      }

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
