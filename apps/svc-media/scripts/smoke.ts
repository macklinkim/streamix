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
  password: "hunter2password",
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

// signed playback URL from Core -> 200 + #EXTM3U; segment URIs carry the token
const playback = await channel.getPlaybackUrl({ slug });
const signed = await fetch(playback.url).catch(() => null);
const body = signed ? await signed.text() : "";
ok(
  "signed HLS playlist served (200)",
  signed?.status === 200 && body.includes("#EXTM3U"),
  `status=${signed?.status}`,
);

// unsigned (token stripped) -> 403
const unsigned = await fetch(playback.url.split("?")[0]!).catch(() => null);
ok("unsigned HLS blocked (403)", unsigned?.status === 403, `status=${unsigned?.status}`);

// the rewritten playlist's segment URI already carries ?token -> 200.
// MediaMTX (ADR-10) serves a master playlist + fMP4 (.mp4/.m4s); legacy .ts kept.
const base = playback.url.split("/index.m3u8")[0];
// Real media only: skip LL-HLS "gap.mp4" placeholders (they 404 by design);
// fall back to an #EXT-X-PART URI when no full segment is in the window yet.
const segLine = (text: string) => {
  const full = text
    .split("\n")
    .find(
      (l) => !l.startsWith("#") && !l.startsWith("gap.") && /\.(ts|mp4|m4s)(\?|$)/.test(l.trim()),
    )
    ?.trim();
  if (full) return full;
  return text.match(/#EXT-X-PART:.*URI="([^"]+)"/)?.[1];
};
// LL-HLS parts rotate quickly; refetch the playlist and retry so the smoke
// doesn't fail on a segment that expired between the two requests.
async function fetchFreshSegment(): Promise<{ seg?: string; status?: number }> {
  for (let i = 0; i < 5; i++) {
    const pl = await fetch(playback.url).catch(() => null);
    let text = pl ? await pl.text() : "";
    const variant = text
      .split("\n")
      .find((l) => !l.startsWith("#") && l.includes(".m3u8"))
      ?.trim();
    if (variant && !segLine(text)) {
      const vRes = await fetch(`${base}/${variant}`).catch(() => null);
      text = vRes ? await vRes.text() : "";
    }
    const candidate = segLine(text);
    if (process.env.SMOKE_DEBUG) console.log(`--- attempt ${i} playlist ---\n${text}`);
    if (candidate) {
      const r = await fetch(`${base}/${candidate}`).catch(() => null);
      if (r?.status === 200) return { seg: candidate, status: 200 };
      if (i === 4) return { seg: candidate, status: r?.status };
    }
    await sleep(1000);
  }
  return {};
}
const { seg, status: segStatus } = await fetchFreshSegment();
const segRes = { status: segStatus };
ok("token-signed segment served (200)", segRes?.status === 200, `status=${segRes?.status}`);

// same segment without the token -> 403
const segNoTok = seg?.split("?")[0];
const segBad = await fetch(`${base}/${segNoTok}`).catch(() => null);
ok("unsigned segment blocked (403)", segBad?.status === 403, `status=${segBad?.status}`);

// thumbnail captured (first frame grabbed ~4s after publish) + served publicly
await sleep(3000);
const thumb = await fetch(`http://127.0.0.1:8090/thumb/${channelId}.jpg`).catch(() => null);
ok(
  "thumbnail captured & served (200 jpeg)",
  thumb?.status === 200 && thumb.headers.get("content-type") === "image/jpeg",
  `status=${thumb?.status}`,
);

push.kill("SIGKILL");
await sleep(2500); // donePublish -> stopStream
const after = await channel.getChannel({ slug });
ok("is_live cleared after stream ends", after.channel?.isLive === false);

// retention: HLS dir + thumbnail reaped after the ~8s grace
await sleep(9000);
const reaped = await fetch(`http://127.0.0.1:8090/thumb/${channelId}.jpg`).catch(() => null);
ok("retention reaped thumbnail (404)", reaped?.status === 404, `status=${reaped?.status}`);

console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(process.exitCode ?? 0);
