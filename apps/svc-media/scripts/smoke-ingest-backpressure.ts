// Ingest backpressure smoke (M4-3, G5): pre-buffers a webm clip, then blasts it
// into the transcode path FASTER than ffmpeg can drain it, so unflushed bytes
// cross INGEST_BUFFER_LIMIT_MB and the server drops the connection with 4009.
// Run against a low-limit server for speed, e.g.:
//   INGEST_BUFFER_LIMIT_MB=4 pnpm --filter @streamix/svc-media dev
// Generation is decoupled from sending: we collect the whole clip first, then
// send with no pacing, so the send rate isn't gated by the encoder.
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
let mine = (await channel.getMyChannel({}, userHeader)).channel;
if (!mine) {
  await channel.createChannel(
    { title: "인제스트 스모크 방송", slug: SLUG, category: "테스트" },
    userHeader,
  );
  mine = (await channel.getMyChannel({}, userHeader)).channel;
}
const { streamKey } = await channel.rotateStreamKey({}, userHeader);

// Build a high-bitrate webm clip fully into memory first.
const producer = spawn(ff, [
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=1280x720:rate=30",
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
  "8000k",
  "-c:a",
  "libopus",
  "-t",
  "60",
  "-f",
  "webm",
  "pipe:1",
]);
producer.stderr.on("data", () => {});
const parts: Buffer[] = [];
producer.stdout.on("data", (c: Buffer) => parts.push(c));
await new Promise<void>((resolve) => producer.on("close", () => resolve()));
const clip = Buffer.concat(parts);
console.log(`buffered clip: ${(clip.length / 1024 / 1024).toFixed(1)} MB`);

const ws = new WebSocket(`ws://localhost:8090/ingest?key=${streamKey}`);
const closeCode = await new Promise<number>((resolve, reject) => {
  const timer = setTimeout(() => resolve(-1), 30000); // no close => fail
  ws.on("open", () => {
    // Blast in 64KB frames with no pacing; far outpaces server-side transcode.
    for (let off = 0; off < clip.length; off += 65536) {
      ws.send(clip.subarray(off, off + 65536));
    }
  });
  ws.on("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
  ws.on("error", reject);
});
check("connection dropped with 4009 on backpressure", closeCode === 4009, `close=${closeCode}`);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
