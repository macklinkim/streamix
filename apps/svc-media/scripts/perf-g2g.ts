// M0 baseline: glass-to-glass (g2g) latency harness.
// Ingests a test source with the host wall-clock burned into every frame
// (drawtext %{localtime}), then serves a self-contained hls.js page that plays
// the signed HLS URL AND overlays a live JS wall-clock from the SAME machine.
// A single screenshot then contains both clocks; g2g = (page now) - (burned time).
//
// Measurement only — does not modify any app source.
//
// Usage (from apps/svc-media):
//   node --import tsx scripts/perf-g2g.ts                      # browser path (WS ingest)
//   PERF_G2G_PATH=rtmp node --import tsx scripts/perf-g2g.ts   # OBS path (direct RTMP)
//   PERF_G2G_SECONDS=120 node --import tsx scripts/perf-g2g.ts
//
// PERF_G2G_PATH=rtmp publishes H.264+AAC FLV straight to rtmp://:1935/live/<key>
// (exactly what OBS does); PERF_G2G_PATH=ws (default) emulates the studio page
// (webm chunks over WS -> ingest.ts transcoding).
//
// While it runs it prints the page path (perf-out/g2g.html) + the signed URL.
// Open the page in a browser, screenshot, and read the two clocks.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import WebSocket from "ws";
import { AuthService, ChannelService } from "@streamix/proto";

const ff = ffmpegStatic as unknown as string;
const CORE = process.env.CORE_URL ?? "http://localhost:50051";
const WSBASE = process.env.MEDIA_WS_URL ?? "ws://localhost:8090";
const SECONDS = Number(process.env.PERF_G2G_SECONDS ?? 90);
const PATH_MODE = (process.env.PERF_G2G_PATH ?? "ws").toLowerCase(); // ws | rtmp
const RTMP_PORT = Number(process.env.RTMP_PORT ?? 1935);
const OUT_DIR = join(process.cwd(), "perf-out");
const HTML = join(OUT_DIR, "g2g.html");

const t = createGrpcTransport({ baseUrl: CORE });
const auth = createClient(AuthService, t);
const channel = createClient(ChannelService, t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EMAIL = "g2g@streamix.test";
const PASSWORD = "g2gpassword123";
const SLUG = "perf-g2g";

// Burn the host wall clock into the frame. %{localtime} (default format,
// "YYYY-MM-DD HH:MM:SS") avoids strftime colon-escaping pitfalls; it is
// evaluated at encode time which, under -re realtime pacing, tracks capture.
const drawtext =
  "drawtext=text='%{localtime}':x=20:y=40:fontsize=56:" +
  "fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=10";

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await auth.register({ email: EMAIL, password: PASSWORD, displayName: "g2g" }).catch((e) => {
    if (!(e instanceof ConnectError && e.code === Code.AlreadyExists)) throw e;
  });
  const login = await auth.login({ email: EMAIL, password: PASSWORD });
  const userHeader = { headers: { "x-user-id": login.user!.id } };
  let mine = (await channel.getMyChannel({}, userHeader)).channel;
  if (!mine) {
    await channel.createChannel({ title: "g2g", slug: SLUG, category: "test" }, userHeader);
    mine = (await channel.getMyChannel({}, userHeader)).channel;
  }
  const { streamKey } = await channel.rotateStreamKey({}, userHeader);

  const srcArgs = [
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-vf",
    drawtext,
  ];
  let producer;
  let ws: WebSocket | null = null;
  if (PATH_MODE === "rtmp") {
    // OBS path: H.264+AAC FLV direct to NMS RTMP (keyframe every 2s like the
    // recommended OBS setting), then main.ts packages it with -c copy.
    producer = spawn(ff, [
      ...srcArgs,
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
      "-b:v",
      "2500k",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-t",
      String(SECONDS),
      "-f",
      "flv",
      `rtmp://127.0.0.1:${RTMP_PORT}/live/${streamKey}`,
    ]);
    producer.stderr.on("data", () => {});
  } else {
    // Browser path: webm over WS -> ingest.ts transcoding.
    producer = spawn(ff, [
      ...srcArgs,
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "2500k",
      "-c:a",
      "libopus",
      "-t",
      String(SECONDS),
      "-f",
      "webm",
      "pipe:1",
    ]);
    producer.stderr.on("data", () => {});
    const sock = new WebSocket(`${WSBASE}/ingest?key=${streamKey}`);
    ws = sock;
    await new Promise<void>((resolve, reject) => {
      sock.on("open", () => resolve());
      sock.on("error", reject);
    });
    producer.stdout!.on("data", (chunk: Buffer) => {
      if (sock.readyState === sock.OPEN) sock.send(chunk);
    });
  }

  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    await sleep(1000);
    live = (await channel.getChannel({ slug: SLUG })).channel!.isLive;
  }
  if (!live) throw new Error("stream never went live");

  const { url } = await channel.getPlaybackUrl({ slug: SLUG });
  writeFileSync(HTML, pageHtml(url));
  console.log(`[g2g] LIVE (${PATH_MODE} path). streaming ${SECONDS}s`);
  console.log(`[g2g] signed URL: ${url}`);
  console.log(`[g2g] open page:  ${HTML}`);
  console.log(`[g2g] screenshot the page; g2g = (JS NOW clock) - (video burned clock)`);

  producer.on("close", () => {
    ws?.close();
    console.log("[g2g] source ended");
    process.exit(0);
  });
}

// Self-contained hls.js player + a live JS wall-clock overlay from the same host.
function pageHtml(url: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>g2g</title>
<style>body{margin:0;background:#111;color:#fff;font-family:monospace}
#now{font-size:64px;padding:12px;background:#003;color:#0f0}
video{width:1280px;max-width:100%;display:block}</style></head>
<body>
<div id="now">NOW --:--:--.---</div>
<video id="v" autoplay muted playsinline></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<script>
const url=${JSON.stringify(url)};
const v=document.getElementById('v');
function tick(){const d=new Date();const p=n=>String(n).padStart(2,'0');
document.getElementById('now').textContent='NOW '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())+'.'+String(d.getMilliseconds()).padStart(3,'0');
requestAnimationFrame(tick);}tick();
if(window.Hls&&Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3});h.loadSource(url);h.attachMedia(v);}
else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src=url;}
</script></body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
