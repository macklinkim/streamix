// End-to-end smoke for svc-core. Run against a live service + Postgres/Redis:
//   pnpm --filter @streamix/svc-core build && node dist/main.js &   # or tsx src/main.ts
//   tsx scripts/smoke.ts
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AuthService, ChannelService } from "@streamix/proto";

const transport = createGrpcTransport({ baseUrl: "http://localhost:50051" });
const auth = createClient(AuthService, transport);
const channel = createClient(ChannelService, transport);

const stamp = Date.now();
const email = `smoke_${stamp}@example.com`;
const slug = `smoke-${stamp}`;

function ok(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const reg = await auth.register({ email, password: "hunter2password", displayName: "스모크유저" });
ok("register", Boolean(reg.user?.id), reg.user?.email);
const userId = reg.user!.id;

const login = await auth.login({ email, password: "hunter2password" });
ok("login returns tokens", Boolean(login.accessToken && login.refreshToken));

const badLogin = await auth.login({ email, password: "wrong" }).then(
  () => "no-error",
  (e) => String(e.code ?? e),
);
ok("login rejects wrong password", badLogin !== "no-error", badLogin);

const refreshed = await auth.refresh({ refreshToken: login.refreshToken });
ok("refresh issues new access token", Boolean(refreshed.accessToken));

const hdr = { headers: { "x-user-id": userId } };
const me = await auth.me({}, hdr);
ok("me (authed)", me.user?.id === userId);

const created = await channel.createChannel({ title: "스모크 방송", slug, category: "IRL" }, hdr);
ok("createChannel returns stream key", Boolean(created.streamKey && created.channel?.id));
const streamKey = created.streamKey;

const val = await channel.validateStreamKey({ streamKey });
ok("validateStreamKey (valid)", val.valid && val.channelId === created.channel!.id);

const bad = await channel.validateStreamKey({ streamKey: "live_bogus" });
ok("validateStreamKey (invalid)", bad.valid === false);

const start = await channel.startStream({ streamKey });
ok("startStream", start.channelId === created.channel!.id);

const dup = await channel.startStream({ streamKey }).then(
  () => "no-error",
  (e) => String(e.code ?? e),
);
ok("startStream blocks duplicate (SET NX)", dup !== "no-error", dup);

const liveCh = await channel.getChannel({ slug });
ok("getChannel shows is_live", liveCh.channel?.isLive === true);

const live = await channel.listLive({});
ok(
  "listLive includes channel",
  live.channels.some((c) => c.slug === slug),
);

await channel.stopStream({ channelId: created.channel!.id });
const stopped = await channel.getChannel({ slug });
ok("stopStream clears is_live", stopped.channel?.isLive === false);

console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
