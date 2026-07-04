import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import NodeMediaServer from "node-media-server";
import ffmpegStatic from "ffmpeg-static";
import { ConnectError } from "@connectrpc/connect";
import { env } from "./env.js";
import { core } from "./core-client.js";
import { startHlsServer } from "./hls-server.js";

const ffmpeg = ffmpegStatic as unknown as string;
mkdirSync(env.MEDIA_ROOT, { recursive: true });

type Session = { channelId: string; ff?: ChildProcess; hb?: NodeJS.Timeout };
const sessions = new Map<string, Session>();

const streamKeyOf = (streamPath: string) => streamPath.split("/").pop() ?? "";

// RTMP-only: HLS is served by our own authz server (hls-server.ts), not NMS http.
const nms = new NodeMediaServer({
  rtmp: { port: env.RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
});

// postPublish (stream established): validate the key + claim live state via Core
// (single writer, SET NX). On failure, reject the RTMP session. On success,
// package RTMP -> HLS keyed by channelId (never the secret key) + heartbeat.
// (All work is here, not split with prePublish, to avoid an async accept race.)
nms.on("postPublish", (id, streamPath) => {
  void (async () => {
    let channelId: string;
    try {
      ({ channelId } = await core.startStream({ streamKey: streamKeyOf(streamPath) }));
    } catch (e) {
      const code = e instanceof ConnectError ? e.code : "?";
      console.warn(`reject publish ${streamPath}: ${code}`);
      nms.getSession(id)?.reject();
      return;
    }

    const outDir = join(env.MEDIA_ROOT, channelId);
    mkdirSync(outDir, { recursive: true });
    const ff = spawn(
      ffmpeg,
      [
        "-i",
        `rtmp://127.0.0.1:${env.RTMP_PORT}${streamPath}`,
        "-c",
        "copy",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "4",
        "-hls_flags",
        "delete_segments+append_list",
        join(outDir, "index.m3u8"),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    ff.on("error", (err) => console.warn(`ffmpeg spawn error: ${err.message}`));
    const hb = setInterval(() => void core.heartbeat({ channelId }).catch(() => {}), 30_000);
    sessions.set(id, { channelId, ff, hb });
  })();
});

nms.on("donePublish", (id) => {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.hb) clearInterval(session.hb);
  session.ff?.kill("SIGKILL");
  void core.stopStream({ channelId: session.channelId }).catch(() => {});
});

nms.run();
startHlsServer();
console.log(
  `svc-media rtmp :${env.RTMP_PORT} http :${env.HTTP_PORT} (mediaroot ${env.MEDIA_ROOT})`,
);
