// End-to-end smoke through the BFF (browser path). Requires svc-core :50051,
// svc-chat :50052, bff :8080, Postgres + Redis all running.
import { createClient, ConnectError, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { WebSocket } from "ws";
import { AuthService, ChannelService } from "@streamix/proto";

const transport = createConnectTransport({ baseUrl: "http://localhost:8080", httpVersion: "1.1" });
const auth = createClient(AuthService, transport);
const channel = createClient(ChannelService, transport);

const stamp = Date.now();
const email = `bff_${stamp}@example.com`;
const slug = `bff-${stamp}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ok(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}

// --- HTTP Connect path (browser -> BFF -> svc-core) ---
await auth.register({ email, password: "hunter2password", displayName: "비에프에프" });
const login = await auth.login({ email, password: "hunter2password" });
ok("login via BFF", Boolean(login.accessToken));
const authHdr = { headers: { authorization: `Bearer ${login.accessToken}` } };

const meNoAuth = await auth.me({}).then(
  () => "no-error",
  (e) => (e as ConnectError).code,
);
ok("me without token rejected", meNoAuth === Code.Unauthenticated, String(meNoAuth));

const me = await auth.me({}, authHdr);
ok("me with token", me.user?.email === email);

const created = await channel.createChannel({ title: "BFF 방송", slug, category: "IRL" }, authHdr);
ok("createChannel via BFF (authed)", Boolean(created.channel?.id && created.streamKey));
const channelId = created.channel!.id;

const blocked = await channel.stopStream({ channelId }).then(
  () => "no-error",
  (e) => (e as ConnectError).code,
);
ok("internal RPC blocked at BFF", blocked === Code.PermissionDenied, String(blocked));

const got = await channel.getChannel({ slug });
ok("getChannel public via BFF", got.channel?.slug === slug);

// --- login rate limit (per-email brute-force guard, 5/30s) ---
const rlEmail = `rl_${stamp}@example.com`;
const codes: unknown[] = [];
for (let i = 0; i < 7; i++) {
  codes.push(
    await auth.login({ email: rlEmail, password: "nope" }).then(
      () => "ok",
      (e) => (e as ConnectError).code,
    ),
  );
}
ok(
  "login rate-limited after burst",
  codes.includes(Code.ResourceExhausted),
  `codes=${codes.join(",")}`,
);

// --- WS chat fanout (two browsers in one room via BFF) ---
const wsUrl = `ws://localhost:8080/ws?channelId=${channelId}&token=${login.accessToken}`;
const a = new WebSocket(wsUrl);
const b = new WebSocket(wsUrl);
const bGot: string[] = [];
const aErrors: string[] = [];
b.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.text) bGot.push(m.text);
});
a.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "error") aErrors.push(m.code);
});
await Promise.all([new Promise((r) => a.on("open", r)), new Promise((r) => b.on("open", r))]);
await sleep(200);
a.send(JSON.stringify({ type: "send", text: "여기 채팅 됩니다" }));
await sleep(400);
ok("WS fanout: B receives A's message", bGot.includes("여기 채팅 됩니다"), bGot.join("|"));

for (let i = 0; i < 8; i++) a.send(JSON.stringify({ type: "send", text: `flood-${i}` }));
await sleep(400);
ok("WS send flood guarded (5/3s)", aErrors.includes("rate_limited"), `errors=${aErrors.join(",")}`);

a.close();
b.close();
await sleep(100);
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(process.exitCode ?? 0);
