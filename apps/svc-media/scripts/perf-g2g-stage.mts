// G3 stage verdict: g2g against the DEPLOYED stack (BFF + Fly svc-media/MediaMTX).
// Publishes wall-clock-burned video to prod RTMP like OBS, writes a local page
// that plays the signed prod HLS URL next to a live JS clock from this machine.
// Screenshot the page; g2g = (page clock) - (burned clock).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";

const ff = ffmpegStatic as unknown as string;
const BFF = process.env.BFF_URL ?? "https://streamix-bff.fly.dev";
const RTMP = process.env.RTMP_URL ?? "rtmp://37.16.16.21:1935/live";
const SECONDS = Number(process.env.PERF_G2G_SECONDS ?? 120);
const OUT_DIR = join(process.cwd(), "perf-out");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(service: string, method: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BFF}/${service}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { code?: string; message?: string };
  if (!res.ok) throw new Error(`${method}: ${res.status} ${json.code ?? ""} ${json.message ?? ""}`);
  return json;
}

// Credentials come from the environment — never committed. NOTE: this script is
// currently STALE regardless (the Connect AuthService below is blocked at the BFF
// edge since P0-1); see 작업계획서-모바일방송.md §10.
const email = process.env.EMAIL;
const password = process.env.PASSWORD;
if (!email || !password) {
  console.error("FAIL (config) missing required env EMAIL/PASSWORD");
  process.exit(2);
}
const login = await rpc<{ accessToken: string }>("user.v1.AuthService", "Login", {
  email,
  password,
});
const { streamKey } = await rpc<{ streamKey: string }>(
  "channel.v1.ChannelService",
  "RotateStreamKey",
  {},
  login.accessToken,
);

const drawtext =
  "drawtext=text='%{localtime}':x=20:y=40:fontsize=56:" +
  "fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=10";
const producer = spawn(ff, [
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
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-tune",
  "zerolatency",
  "-g",
  "60",
  "-c:a",
  "aac",
  "-t",
  String(SECONDS),
  "-f",
  "flv",
  `${RTMP}/${streamKey}`,
]);
producer.stderr.on("data", () => {});

let live = false;
for (let i = 0; i < 40 && !live; i++) {
  await sleep(1000);
  const r = await rpc<{ channel?: { isLive?: boolean } }>(
    "channel.v1.ChannelService",
    "GetChannel",
    { slug: "ingest-prod-smoke" },
  );
  live = !!r.channel?.isLive;
}
if (!live) {
  console.error("never live");
  process.exit(1);
}
const { url } = await rpc<{ url: string }>("channel.v1.ChannelService", "GetPlaybackUrl", {
  slug: "ingest-prod-smoke",
});

mkdirSync(OUT_DIR, { recursive: true });
const html = `<!doctype html><meta charset="utf-8"><title>g2g stage</title>
<body style="background:#111;color:#fff;font-family:monospace">
<div id="clock" style="font-size:44px;padding:8px"></div>
<video id="v" muted autoplay playsinline style="width:960px"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script>
setInterval(()=>{const d=new Date();document.getElementById("clock").textContent=
  d.toLocaleTimeString("en-GB")+"."+String(d.getMilliseconds()).padStart(3,"0")},33);
const hls=new Hls({lowLatencyMode:true});
hls.loadSource(${JSON.stringify(url)});hls.attachMedia(document.getElementById("v"));
hls.on(Hls.Events.ERROR,(e,d)=>{if(d.fatal){setTimeout(()=>{hls.loadSource(${JSON.stringify(url)});hls.startLoad()},2000)}});
</script>`;
const page = join(OUT_DIR, "g2g-stage.html");
writeFileSync(page, html);
console.log(`PAGE=${page}`);
console.log(`URL=${url}`);
console.log(`streaming ${SECONDS}s...`);
await new Promise((r) => producer.on("close", r));
console.log("done");
