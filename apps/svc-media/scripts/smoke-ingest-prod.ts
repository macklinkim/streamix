// Prod smoke for browser-broadcast ingest, hitting the REAL domains through the
// same edges the browser uses: BFF Connect-JSON RPCs + media WSS /ingest.
// Usage: pnpm exec tsx scripts/smoke-ingest-prod.ts
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import WebSocket from "ws";

const BFF = process.env.BFF_URL ?? "https://streamix-bff.fly.dev";
const MEDIA_WS = process.env.MEDIA_WS_URL ?? "wss://streamix-svc-media.fly.dev";
const ff = ffmpegStatic as unknown as string;

const EMAIL = "ingest-prod@streamix.test";
const PASSWORD = "ingestprodpass123";
const SLUG = "ingest-prod-smoke";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

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

// Register (idempotent) + login through the BFF edge. Auth is REST-only there —
// the Connect AuthService is blocked at the edge (P1-3 hardening).
async function auth<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BFF}/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""}`);
  return json;
}

// Register is best-effort: the account usually exists already, and re-registering
// it currently surfaces as 502 rather than 409 (svc-media/scripts note: core maps
// the duplicate-email constraint to an internal error). Login below is the gate.
await auth("register", {
  email: EMAIL,
  password: PASSWORD,
  displayName: "프로드 인제스트 스모크",
}).catch(() => {});
const login = await auth<{ accessToken: string }>("login", {
  email: EMAIL,
  password: PASSWORD,
});
check("login via bff", !!login.accessToken);

// My channel (new RPC) + create-once + rotate key (new RPC).
let mine = (
  await rpc<{ channel?: { slug: string } }>(
    "channel.v1.ChannelService",
    "GetMyChannel",
    {},
    login.accessToken,
  )
).channel;
if (!mine) {
  await rpc(
    "channel.v1.ChannelService",
    "CreateChannel",
    { title: "프로드 인제스트 스모크", slug: SLUG, category: "테스트" },
    login.accessToken,
  );
  mine = { slug: SLUG };
}
check("getMyChannel via bff", !!mine);

const { streamKey } = await rpc<{ streamKey: string }>(
  "channel.v1.ChannelService",
  "RotateStreamKey",
  {},
  login.accessToken,
);
check("rotateStreamKey via bff", streamKey.startsWith("live_"));

// Bad key fast-reject over the public WSS edge.
const badClose = await new Promise<number>((resolve) => {
  const ws = new WebSocket(`${MEDIA_WS}/ingest?key=live_bogus`);
  ws.on("close", (code) => resolve(code));
  ws.on("error", () => resolve(-1));
});
check("bad key rejected over wss", badClose === 4403, `close=${badClose}`);

// A valid durable key must ALSO be refused here: browser ingest takes a token,
// and the durable key belongs to RTMP encoders only (P1-3).
const durableClose = await new Promise<number>((resolve) => {
  const ws = new WebSocket(`${MEDIA_WS}/ingest?key=${streamKey}`);
  ws.on("close", (code) => resolve(code));
  ws.on("error", () => resolve(-1));
});
check("durable key rejected on browser ws", durableClose === 4403, `close=${durableClose}`);

// Browser ingest credential (ADR-13): short-lived bit_ token, as the studio does.
const { token: ingestToken } = await rpc<{ token: string }>(
  "channel.v1.ChannelService",
  "IssueIngestToken",
  {},
  login.accessToken,
);
check("issueIngestToken via bff", ingestToken.startsWith("bit_"));

// Live webm producer -> WSS ingest (MediaRecorder stand-in).
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
  "60",
  "-f",
  "webm",
  "pipe:1",
]);
const ws = new WebSocket(`${MEDIA_WS}/ingest?key=${ingestToken}&codec=webm-vp8`);
await new Promise<void>((resolve, reject) => {
  ws.on("open", () => resolve());
  ws.on("error", reject);
});
producer.stdout.on("data", (chunk: Buffer) => {
  if (ws.readyState === ws.OPEN) ws.send(chunk);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let live = false;
for (let i = 0; i < 40 && !live; i++) {
  await sleep(1000);
  const res = await rpc<{ channel?: { isLive?: boolean } }>(
    "channel.v1.ChannelService",
    "GetChannel",
    { slug: mine.slug },
  );
  live = !!res.channel?.isLive;
}
check("prod channel goes live", live);

let m3u8Status = 0;
let hasSegments = false;
if (live) {
  const { url } = await rpc<{ url: string }>("channel.v1.ChannelService", "GetPlaybackUrl", {
    slug: mine.slug,
  });
  for (let i = 0; i < 20; i++) {
    const res = await fetch(url);
    m3u8Status = res.status;
    if (res.ok) {
      // MediaMTX LL-HLS (ADR-10): master playlist references a variant .m3u8;
      // media playlists carry fMP4 (.mp4/.m4s). Legacy .ts kept for safety.
      let text = await res.text();
      const variant = text
        .split("\n")
        .find((l) => !l.startsWith("#") && l.includes(".m3u8"))
        ?.trim();
      if (variant) {
        const base = url.split("/index.m3u8")[0];
        const vRes = await fetch(`${base}/${variant}`).catch(() => null);
        if (vRes?.ok) text = await vRes.text();
      }
      hasSegments = /\.(ts|mp4|m4s)/.test(text);
      if (hasSegments) break;
    }
    await sleep(1000);
  }
}
check("prod signed m3u8 serves segments", m3u8Status === 200 && hasSegments, `${m3u8Status}`);

producer.kill("SIGKILL");
ws.close();
let offline = false;
for (let i = 0; i < 30 && !offline; i++) {
  await sleep(1000);
  const res = await rpc<{ channel?: { isLive?: boolean } }>(
    "channel.v1.ChannelService",
    "GetChannel",
    { slug: mine.slug },
  );
  offline = !res.channel?.isLive;
}
check("prod channel goes offline", offline);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
