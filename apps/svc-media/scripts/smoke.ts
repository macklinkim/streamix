// End-to-end media smoke: create channel via Core, push a synthetic RTMP stream
// with the bundled ffmpeg, verify HLS is produced and Core flips is_live.
// Requires svc-core :50051, svc-media (rtmp :1935 / http :8090), Postgres+Redis.
import { spawn } from "node:child_process";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import { AuthService, ChannelService } from "@streamix/proto";

const ffmpeg = ffmpegStatic as unknown as string;
const core = createGrpcTransport({ baseUrl: "http://localhost:50051" });
const auth = createClient(AuthService, core);
const channel = createClient(ChannelService, core);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ok(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const stamp = Date.now();
const reg = await auth.register({
  email: `media_${stamp}@example.com`,
  password: "hunter2pass",
  displayName: "미디어",
});
const hdr = { headers: { "x-user-id": reg.user!.id } };
const slug = `media-${stamp}`;
const created = await channel.createChannel({ title: "미디어 방송", slug, category: "IRL" }, hdr);
const { streamKey } = created;
const channelId = created.channel!.id;
ok("channel created", Boolean(streamKey && channelId));

// Push ~10s of synthetic A/V to the RTMP ingest.
const push = spawn(
  ffmpeg,
  [
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=15",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-g",
    "30",
    "-c:a",
    "aac",
    "-t",
    "10",
    "-f",
    "flv",
    `rtmp://127.0.0.1:1935/live/${streamKey}`,
  ],
  { stdio: "ignore" },
);

await sleep(5000); // let ingest establish + a few HLS segments write

const live = await channel.getChannel({ slug });
ok("Core shows is_live during stream", live.channel?.isLive === true);

// signed playback URL from Core -> 200 + #EXTM3U, and a cookie for segments
const playback = await channel.getPlaybackUrl({ slug });
const signed = await fetch(playback.url).catch(() => null);
const body = signed ? await signed.text() : "";
ok(
  "signed HLS playlist served (200)",
  signed?.status === 200 && body.includes("#EXTM3U"),
  `status=${signed?.status}`,
);
const cookie = signed?.headers.get("set-cookie")?.split(";")[0] ?? "";

// unsigned (token stripped) -> 403
const unsigned = await fetch(playback.url.split("?")[0]!).catch(() => null);
ok("unsigned HLS blocked (403)", unsigned?.status === 403, `status=${unsigned?.status}`);

// a segment authorized by the cookie -> 200
const seg = body
  .split("\n")
  .find((l) => l.trim().endsWith(".ts"))
  ?.trim();
const segUrl = `${playback.url.split("/index.m3u8")[0]}/${seg}`;
const segRes = await fetch(segUrl, cookie ? { headers: { cookie } } : {}).catch(() => null);
ok(
  "segment served via cookie (200)",
  segRes?.status === 200,
  `status=${segRes?.status} seg=${seg}`,
);

push.kill("SIGKILL");
await sleep(2500); // donePublish -> stopStream
const after = await channel.getChannel({ slug });
ok("is_live cleared after stream ends", after.channel?.isLive === false);

console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(process.exitCode ?? 0);
