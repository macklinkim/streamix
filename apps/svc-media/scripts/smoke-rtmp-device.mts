// D2-a: an RTMP device (GoPro etc.) publishing to the durable stream key takes
// the channel live and the signed HLS URL serves segments — the fallback path
// the studio's RTMP card points phones at. ffmpeg stands in for the device; the
// push pattern is perf-g2g-stage.mts's (M0 S3).
//
// Run (from apps/svc-media):
//   pnpm exec tsx scripts/smoke-rtmp-device.mts
// Env: BFF_URL, RTMP_URL, SECONDS
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

const ff = ffmpegStatic as unknown as string;
const BFF = process.env.BFF_URL ?? "https://streamix-bff.fly.dev";
const RTMP = process.env.RTMP_URL ?? "rtmp://37.16.16.21:1935/live";
const SECONDS = Number(process.env.SECONDS ?? 40);
const SLUG = "ingest-prod-smoke";
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

// Auth is REST-only at the BFF edge; the Connect AuthService is blocked there.
const loginRes = await fetch(`${BFF}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "ingest-prod@streamix.test", password: "ingestprodpass123" }),
});
if (!loginRes.ok) throw new Error(`login: ${loginRes.status} ${await loginRes.text()}`);
const login = (await loginRes.json()) as { accessToken: string };
const { streamKey } = await rpc<{ streamKey: string }>(
  "channel.v1.ChannelService",
  "RotateStreamKey",
  {},
  login.accessToken,
);
console.log("PASS durable key issued");

// The card hands devices this exact one-line URL, so publish to that literally.
const fullUrl = `${RTMP}/${streamKey}`;
const producer = spawn(ff, [
  "-re",
  "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
  "-f", "lavfi", "-i", "sine=frequency=440",
  "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "60",
  "-c:a", "aac",
  "-t", String(SECONDS),
  "-f", "flv", fullUrl,
]);
producer.stderr.on("data", () => {});

let live = false;
for (let i = 0; i < 40 && !live; i++) {
  await sleep(1000);
  const r = await rpc<{ channel?: { isLive?: boolean } }>(
    "channel.v1.ChannelService",
    "GetChannel",
    { slug: SLUG },
  );
  live = !!r.channel?.isLive;
}
console.log(live ? "PASS channel live via rtmp" : "FAIL channel live via rtmp");

let served = false;
if (live) {
  const { url } = await rpc<{ url: string }>("channel.v1.ChannelService", "GetPlaybackUrl", {
    slug: SLUG,
  });
  for (let i = 0; i < 20 && !served; i++) {
    const res = await fetch(url);
    if (res.ok) {
      let text = await res.text();
      const variant = text
        .split("\n")
        .find((l) => !l.startsWith("#") && l.includes(".m3u8"))
        ?.trim();
      if (variant) {
        const vr = await fetch(`${url.split("/index.m3u8")[0]}/${variant}`).catch(() => null);
        if (vr?.ok) text = await vr.text();
      }
      served = /\.(ts|mp4|m4s)/.test(text);
    }
    if (!served) await sleep(2000);
  }
}
console.log(served ? "PASS signed m3u8 serves segments" : "FAIL playback segments");

producer.kill("SIGKILL");
let offline = false;
for (let i = 0; i < 20 && !offline; i++) {
  await sleep(2000);
  const r = await rpc<{ channel?: { isLive?: boolean } }>(
    "channel.v1.ChannelService",
    "GetChannel",
    { slug: SLUG },
  );
  offline = !(r.channel?.isLive ?? false);
}
console.log(offline ? "PASS offline transition" : "FAIL offline transition");

process.exit(live && served && offline ? 0 : 1);
