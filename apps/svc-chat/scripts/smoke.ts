// End-to-end smoke for svc-chat. Requires Redis + a running svc-chat on :50052.
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Redis } from "ioredis";
import { ChatService, ModerationAction } from "@streamix/proto";

const transport = createGrpcTransport({ baseUrl: "http://localhost:50052" });
const chat = createClient(ChatService, transport);
const redis = new Redis("redis://localhost:6379");

const channelId = `room_${Date.now()}`;
const A = { headers: { "x-user-id": "userA", "x-display-name": encodeURIComponent("앨리스") } };
const B = { headers: { "x-user-id": "userB", "x-display-name": encodeURIComponent("밥") } };
const MOD = { headers: { "x-user-id": "owner", "x-display-name": encodeURIComponent("방장") } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ok(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}
const err = (p: Promise<unknown>) =>
  p.then(
    () => "no-error",
    (e) => String(e.code ?? e),
  );

const received: string[] = [];
const ac = new AbortController();
const consumer = (async () => {
  try {
    for await (const res of chat.join({ channelId }, { signal: ac.signal })) {
      if (res.message) received.push(res.message.text);
    }
  } catch {
    /* aborted on teardown */
  }
})();

await sleep(400); // let the Redis subscription establish before publishing

await chat.send({ channelId, text: "안녕하세요" }, A);
await chat.send({ channelId, text: "반가워요" }, B);
await sleep(300);
ok(
  "fanout delivers messages",
  received.includes("안녕하세요") && received.includes("반가워요"),
  received.join("|"),
);

const viewers = await redis.get(`viewers:${channelId}`);
ok("join increments viewers", Number(viewers) >= 1, `viewers=${viewers}`);

await chat.moderate(
  { channelId, action: ModerationAction.SLOWMODE, durationSeconds: 5, targetUserId: "" },
  MOD,
);
await chat.send({ channelId, text: "1" }, A);
ok(
  "slowmode blocks rapid 2nd send",
  (await err(chat.send({ channelId, text: "2" }, A))) !== "no-error",
);
await chat.moderate(
  { channelId, action: ModerationAction.SLOWMODE, durationSeconds: 0, targetUserId: "" },
  MOD,
);

await chat.moderate(
  { channelId, action: ModerationAction.BAN, targetUserId: "userB", durationSeconds: 0 },
  MOD,
);
ok("ban blocks send", (await err(chat.send({ channelId, text: "x" }, B))) !== "no-error");
await chat.moderate(
  { channelId, action: ModerationAction.UNBAN, targetUserId: "userB", durationSeconds: 0 },
  MOD,
);
ok("unban restores send", (await err(chat.send({ channelId, text: "다시" }, B))) === "no-error");

ac.abort();
await consumer;
await redis.quit();
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
