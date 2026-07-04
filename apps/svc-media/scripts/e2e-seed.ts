// Deterministic fixture for the happy-path E2E. Assumes a FRESH db (the runner
// resets it first) so createChannel returns the stream key. Keeps a synthetic
// stream running until killed. Fixed creds/slug match e2e/happy-path.spec.ts.
import { spawn } from "node:child_process";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import { AuthService, ChannelService } from "@streamix/proto";

const ff = ffmpegStatic as unknown as string;
const t = createGrpcTransport({ baseUrl: "http://localhost:50051" });
const auth = createClient(AuthService, t);
const channel = createClient(ChannelService, t);

const EMAIL = "e2e@streamix.test";
const PASSWORD = "e2epassword123";
const SLUG = "e2e-live";

await auth
  .register({ email: EMAIL, password: PASSWORD, displayName: "E2E 스트리머" })
  .catch((e) => {
    if (!(e instanceof ConnectError && e.code === Code.AlreadyExists)) throw e;
  });
const login = await auth.login({ email: EMAIL, password: PASSWORD });
const created = await channel.createChannel(
  { title: "E2E 라이브 방송", slug: SLUG, category: "테스트" },
  { headers: { "x-user-id": login.user!.id } },
);

spawn(
  ff,
  [
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
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-g",
    "48",
    "-c:a",
    "aac",
    "-t",
    "180",
    "-f",
    "flv",
    `rtmp://127.0.0.1:1935/live/${created.streamKey}`,
  ],
  { stdio: "ignore" },
);

console.log(`e2e fixture ready: ${SLUG}`);
await new Promise(() => {}); // keep the stream alive until killed
