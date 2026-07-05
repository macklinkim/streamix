// Helper: stream 30s of test video via WS ingest for the given key (argv[2]).
// Used to manually verify the watch page's offline->online transition.
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import WebSocket from "ws";

const ff = ffmpegStatic as unknown as string;
const streamKey = process.argv[2];
if (!streamKey) throw new Error("usage: tsx smoke-stream-30s.ts <streamKey>");

const producer = spawn(ff, [
  "-re",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=640x360:rate=24",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440",
  "-c:v",
  "libvpx",
  "-deadline",
  "realtime",
  "-cpu-used",
  "8",
  "-b:v",
  "800k",
  "-c:a",
  "libopus",
  "-t",
  process.env.STREAM_SECONDS ?? "30",
  "-f",
  "webm",
  "pipe:1",
]);

const base = process.env.MEDIA_WS_URL ?? "ws://localhost:8090";
const ws = new WebSocket(`${base}/ingest?key=${streamKey}`);
ws.on("open", () => {
  console.log("ingest connected, streaming 30s...");
  producer.stdout.on("data", (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
});
producer.on("close", () => {
  ws.close();
  console.log("done");
  process.exit(0);
});
