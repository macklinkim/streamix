// Smoke for browser-broadcast ingest: WS /ingest?key= -> ffmpeg -> RTMP -> HLS.
// Emulates MediaRecorder by piping a live webm (vp8/opus) over the WS in chunks.
// Also covers the new GetMyChannel / RotateStreamKey RPCs.
import { spawn } from "node:child_process";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import WebSocket from "ws";
import { AuthService, ChannelService } from "@streamix/proto";

const ff = ffmpegStatic as unknown as string;
const t = createGrpcTransport({ baseUrl: "http://localhost:50051" });
const auth = createClient(AuthService, t);
const channel = createClient(ChannelService, t);

const EMAIL = "ingest@streamix.test";
const PASSWORD = "ingestpassword123";
const SLUG = "ingest-smoke";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

await auth
  .register({ email: EMAIL, password: PASSWORD, displayName: "인제스트 스모크" })
  .catch((e) => {
    if (!(e instanceof ConnectError && e.code === Code.AlreadyExists)) throw e;
  });
const login = await auth.login({ email: EMAIL, password: PASSWORD });
const userHeader = { headers: { "x-user-id": login.user!.id } };

// getMyChannel: create on first run, returned on reruns.
let mine = (await channel.getMyChannel({}, userHeader)).channel;
if (!mine) {
  await channel.createChannel(
    { title: "인제스트 스모크 방송", slug: SLUG, category: "테스트" },
    userHeader,
  );
  mine = (await channel.getMyChannel({}, userHeader)).channel;
}
check("getMyChannel returns own channel", !!mine && mine.slug === SLUG);

// rotateStreamKey: always yields a usable plaintext key (old key invalidated).
const { streamKey } = await channel.rotateStreamKey({}, userHeader);
check("rotateStreamKey returns key", streamKey.startsWith("live_"));
const { valid } = await channel.validateStreamKey({ streamKey });
check("rotated key validates", valid);

// Bad key must be fast-rejected with 4403.
const badClose = await new Promise<number>((resolve) => {
  const ws = new WebSocket("ws://localhost:8090/ingest?key=live_bogus");
  ws.on("close", (code) => resolve(code));
});
check("bad key rejected", badClose === 4403, `close=${badClose}`);

// Live webm producer (stand-in for MediaRecorder chunks).
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

const ws = new WebSocket(`ws://localhost:8090/ingest?key=${streamKey}`);
await new Promise<void>((resolve, reject) => {
  ws.on("open", () => resolve());
  ws.on("error", reject);
});
producer.stdout.on("data", (chunk: Buffer) => {
  if (ws.readyState === ws.OPEN) ws.send(chunk);
});

// Wait for the pipeline to go live (key validation + SET NX + HLS packaging).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let live = false;
for (let i = 0; i < 30 && !live; i++) {
  await sleep(1000);
  live = (await channel.getChannel({ slug: SLUG })).channel!.isLive;
}
check("channel goes live via ws ingest", live);

let m3u8Status = 0;
let hasSegments = false;
if (live) {
  const { url } = await channel.getPlaybackUrl({ slug: SLUG });
  for (let i = 0; i < 20; i++) {
    const res = await fetch(url);
    m3u8Status = res.status;
    if (res.ok) {
      hasSegments = /\.ts/.test(await res.text());
      if (hasSegments) break;
    }
    await sleep(1000);
  }
}
check("signed m3u8 serves segments", m3u8Status === 200 && hasSegments, `status=${m3u8Status}`);

// Stop the browser side: recorder halts, WS closes -> ffmpeg EOF -> unpublish.
producer.kill("SIGKILL");
ws.close();
let offline = false;
for (let i = 0; i < 20 && !offline; i++) {
  await sleep(1000);
  offline = !(await channel.getChannel({ slug: SLUG })).channel!.isLive;
}
check("channel goes offline after ws close", offline);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
