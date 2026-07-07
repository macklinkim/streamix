// M2 smoke (C2): browser ingest token (ADR-13).
//   - issueIngestToken returns a "bit_" token + future expiry
//   - the token validates and go-lives through WS /ingest (same as OBS key)
//   - a forged/expired token is rejected 4403 (same null-lookup branch)
//   - rotating the OBS stream key does NOT invalidate an issued ingest token,
//     and issuing a token does NOT change the OBS key (independence, R5)
// Lives beside smoke-ingest.ts (needs ffmpeg-static + ws + core:50051 + media:8090).
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

const EMAIL = "ingest-token@streamix.test";
const PASSWORD = "ingesttokenpass123";
const SLUG = "ingest-token-smoke";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await auth.register({ email: EMAIL, password: PASSWORD, displayName: "토큰 스모크" }).catch((e) => {
  if (!(e instanceof ConnectError && e.code === Code.AlreadyExists)) throw e;
});
const login = await auth.login({ email: EMAIL, password: PASSWORD });
const userHeader = { headers: { "x-user-id": login.user!.id } };

let mine = (await channel.getMyChannel({}, userHeader)).channel;
if (!mine) {
  await channel.createChannel(
    { title: "토큰 스모크 방송", slug: SLUG, category: "테스트" },
    userHeader,
  );
  mine = (await channel.getMyChannel({}, userHeader)).channel;
}
check("channel exists", !!mine && mine.slug === SLUG);

// Snapshot the OBS key prefix to assert issuing a token never touches it.
const beforePrefix = (await channel.getMyChannel({}, userHeader)).streamKeyPrefix;

// Issue token.
const issued = await channel.issueIngestToken({}, userHeader);
check("issues bit_ token", issued.token.startsWith("bit_"));
check("token expiry in the future", Number(issued.expiresAt) > Math.floor(Date.now() / 1000));

const afterPrefix = (await channel.getMyChannel({}, userHeader)).streamKeyPrefix;
check(
  "issuing token leaves OBS key unchanged",
  beforePrefix === afterPrefix,
  `${beforePrefix} vs ${afterPrefix}`,
);

// Token validates and resolves to the owning channel.
const v = await channel.validateStreamKey({ streamKey: issued.token });
check("token validates to channel", v.valid && v.channelId === mine!.id);

// Forged token = invalid (same branch as an expired one).
const forged = await channel.validateStreamKey({ streamKey: "bit_deadbeef" });
check("forged token invalid", !forged.valid);

// Forged token fast-rejected at the WS ingest edge with 4403.
const badClose = await new Promise<number>((resolve) => {
  const ws = new WebSocket("ws://localhost:8090/ingest?key=bit_deadbeef");
  ws.on("close", (code) => resolve(code));
});
check("forged token WS rejected", badClose === 4403, `close=${badClose}`);

// Rotating the OBS key must NOT invalidate the already-issued ingest token.
await channel.rotateStreamKey({}, userHeader);
const stillValid = await channel.validateStreamKey({ streamKey: issued.token });
check("token survives OBS key rotation", stillValid.valid && stillValid.channelId === mine!.id);

// Go-live through the token, exactly like the browser broadcast path.
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
const ws = new WebSocket(`ws://localhost:8090/ingest?key=${issued.token}&codec=webm-vp8`);
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
check("go-live via ingest token", live);

producer.kill("SIGKILL");
ws.close();
let offline = false;
for (let i = 0; i < 20 && !offline; i++) {
  await sleep(1000);
  offline = !(await channel.getChannel({ slug: SLUG })).channel!.isLive;
}
check("offline after ws close", offline);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
