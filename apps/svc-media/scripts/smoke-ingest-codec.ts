// Codec-negotiation ingest smoke (ADR-9): drives /ingest?...&codec=<label> with
// an input matching that label, verifying the server's remux branch takes the
// stream live and serves HLS. Emulates MediaRecorder without a browser:
//   mp4-h264  -> fragmented MP4 (H.264 + AAC)  -> server: -c:v copy -c:a copy
//   webm-h264 -> Matroska (H.264 + Opus)       -> server: -c:v copy -c:a aac
// Pick codec via CODEC env (default mp4-h264).
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CODEC = process.env.CODEC ?? "mp4-h264";
const EMAIL = "ingest@streamix.test";
const PASSWORD = "ingestpassword123";
const SLUG = "ingest-smoke";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

// Producer args per negotiated codec (stand-in for MediaRecorder output).
function producerArgs(codec: string): string[] {
  const src = [
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
  ];
  const v = [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
  ];
  if (codec === "webm-h264") {
    // Chrome's "video/webm;codecs=h264" is really H.264 inside Matroska/EBML.
    return [...src, ...v, "-c:a", "libopus", "-t", "60", "-f", "matroska", "pipe:1"];
  }
  // mp4-h264: fragmented MP4 (moof/mdat), as MediaRecorder video/mp4 emits.
  return [
    ...src,
    ...v,
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-t",
    "60",
    "-f",
    "mp4",
    "pipe:1",
  ];
}

console.log(`=== codec=${CODEC} ===`);

await auth
  .register({ email: EMAIL, password: PASSWORD, displayName: "인제스트 스모크" })
  .catch((e) => {
    if (!(e instanceof ConnectError && e.code === Code.AlreadyExists)) throw e;
  });
const login = await auth.login({ email: EMAIL, password: PASSWORD });
const userHeader = { headers: { "x-user-id": login.user!.id } };

let mine = (await channel.getMyChannel({}, userHeader)).channel;
if (!mine) {
  await channel.createChannel(
    { title: "인제스트 스모크 방송", slug: SLUG, category: "테스트" },
    userHeader,
  );
  mine = (await channel.getMyChannel({}, userHeader)).channel;
}
const { streamKey } = await channel.rotateStreamKey({}, userHeader);

const producer = spawn(ff, producerArgs(CODEC));
producer.stderr.on("data", () => {}); // drain

const ws = new WebSocket(`ws://localhost:8090/ingest?key=${streamKey}&codec=${CODEC}`);
await new Promise<void>((resolve, reject) => {
  ws.on("open", () => resolve());
  ws.on("error", reject);
});
producer.stdout.on("data", (chunk: Buffer) => {
  if (ws.readyState === ws.OPEN) ws.send(chunk);
});

let live = false;
for (let i = 0; i < 30 && !live; i++) {
  await sleep(1000);
  live = (await channel.getChannel({ slug: SLUG })).channel!.isLive;
}
check(`channel goes live (codec=${CODEC})`, live);

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
check(
  `signed m3u8 serves segments (codec=${CODEC})`,
  m3u8Status === 200 && hasSegments,
  `status=${m3u8Status}`,
);

producer.kill("SIGKILL");
ws.close();
let offline = false;
for (let i = 0; i < 20 && !offline; i++) {
  await sleep(1000);
  offline = !(await channel.getChannel({ slug: SLUG })).channel!.isLive;
}
check(`channel goes offline after close (codec=${CODEC})`, offline);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
