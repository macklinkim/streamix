// Seed a live channel and keep a synthetic stream running, printing slug/token/
// channelId as JSON so a browser test can drive the watch page. Kill to stop.
import { spawn } from "node:child_process";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import { AuthService, ChannelService } from "@streamix/proto";

const ff = ffmpegStatic as unknown as string;
const t = createGrpcTransport({ baseUrl: "http://localhost:50051" });
const auth = createClient(AuthService, t);
const channel = createClient(ChannelService, t);

const stamp = Date.now();
const email = `demo_${stamp}@example.com`;
const reg = await auth.register({ email, password: "hunter2password", displayName: "데모방송" });
const login = await auth.login({ email, password: "hunter2password" });
const slug = `demo-${stamp}`;
const created = await channel.createChannel(
  { title: "데모 라이브 · 테스트 송출", slug, category: "IRL" },
  { headers: { "x-user-id": reg.user!.id } },
);

spawn(
  ff,
  [
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
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
    "60",
    "-c:a",
    "aac",
    "-t",
    "300",
    "-f",
    "flv",
    `rtmp://127.0.0.1:1935/live/${created.streamKey}`,
  ],
  { stdio: "ignore" },
);

console.log(JSON.stringify({ slug, token: login.accessToken, channelId: created.channel!.id }));
await new Promise(() => {}); // keep the stream alive until killed
