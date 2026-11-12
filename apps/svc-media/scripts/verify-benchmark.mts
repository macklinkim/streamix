// Backend verification for benchmark M2-M5 against the local stack
// (core :50051, chat :50052, BFF :8080, media :8090 + dockerised MediaMTX/PG/Redis).
// Run from apps/svc-media: pnpm exec tsx <this file>
import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import WebSocket from "ws";
import { AuthService } from "@streamix/proto";

const BFF = "http://localhost:8080";
const WEB = "http://localhost:3000";
const ff = ffmpegStatic as unknown as string;
const run = Date.now().toString(36);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v as T;
    await sleep(1000);
  }
  return undefined;
}

// Connect-JSON over the BFF, like the browser does.
async function rpc(svc: string, method: string, body: object, token?: string) {
  const r = await fetch(`${BFF}/${svc}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      origin: WEB,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, any>;
  return { status: r.status, json };
}
const ch = (m: string, b: object, t?: string) => rpc("channel.v1.ChannelService", m, b, t);
const chat = (m: string, b: object, t?: string) => rpc("chat.v1.ChatService", m, b, t);

// --- users: register via core, approve in DB, log in through the BFF ---
const core = createClient(AuthService, createGrpcTransport({ baseUrl: "http://localhost:50051" }));
const PASSWORD = "Verify!Pass-2026";
type U = { name: string; email: string; id: string; token: string };
async function makeUser(name: string): Promise<U> {
  const email = `${name}-${run}@verify.test`;
  await core.register({ email, password: PASSWORD, displayName: `${name}${run.slice(-3)}` });
  return { name, email, id: "", token: "" };
}
const owner = await makeUser("owner");
const mod = await makeUser("mod");
const viewer = await makeUser("viewer");
execFileSync("docker", [
  "exec",
  "streamix-postgres-1",
  "psql",
  "-U",
  "streamix",
  "-d",
  "streamix",
  "-c",
  `update users set approved_at = now() where email like '%-${run}@verify.test'`,
]);
for (const u of [owner, mod, viewer]) {
  const r = await fetch(`${BFF}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sx-web": "1", origin: WEB },
    body: JSON.stringify({ email: u.email, password: PASSWORD }),
  });
  const j = (await r.json()) as { accessToken: string; user: { id: string } };
  u.token = j.accessToken;
  u.id = j.user.id;
}
check("setup: 3 approved users logged in via BFF", !!(owner.token && mod.token && viewer.token));

// --- M2: channel, categories, search, follow ---
const slug = `verify-${run}`;
const bad = await ch("CreateChannel", { title: "x", slug: `${slug}-bad`, category: "테스트" }, owner.token);
check("G-03 category outside the fixed list is rejected", bad.status === 400, `status=${bad.status} code=${bad.json.code}`);
const created = await ch("CreateChannel", { title: `검증 방송 ${run}`, slug, category: "게임" }, owner.token);
const channelId: string = created.json.channel?.id;
const streamKey: string = created.json.streamKey;
check("CreateChannel with fixed category", created.status === 200 && !!streamKey, `status=${created.status}`);

const search = await ch("SearchChannels", { query: `검증 방송 ${run}` });
check("G-01 search finds the channel by title", search.json.channels?.some((c: any) => c.id === channelId));
const wild = await ch("SearchChannels", { query: "%" });
check(
  "G-01 LIKE wildcard is matched literally",
  !(wild.json.channels ?? []).some((c: any) => c.id === channelId),
);

await ch("FollowChannel", { channelId }, viewer.token);
let following = await ch("ListFollowing", {}, viewer.token);
check("G-02 follow appears in ListFollowing", following.json.channels?.some((c: any) => c.id === channelId));
await ch("UnfollowChannel", { channelId }, viewer.token);
following = await ch("ListFollowing", {}, viewer.token);
check("G-02 unfollow removes it", !(following.json.channels ?? []).some((c: any) => c.id === channelId));
const anonFollow = await ch("FollowChannel", { channelId });
check("G-02 follow requires login", anonFollow.status === 401, `status=${anonFollow.status}`);
const before = await ch("GetChannel", { slug });
check("G-04 lastLiveAt is 0 before any broadcast", !before.json.channel?.lastLiveAt);

// --- live broadcast ---
const push = spawn(
  ff,
  [
    "-re",
    "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "24",
    "-c:a", "aac", "-t", "75",
    "-f", "flv", `rtmp://127.0.0.1:1935/live/${streamKey}`,
  ],
  { stdio: "ignore" },
);
const live = await until(async () => (await ch("GetChannel", { slug })).json.channel?.isLive, 30_000);
check("broadcast goes live", !!live);
const inGame = await ch("ListLive", { category: "게임" });
const inMusic = await ch("ListLive", { category: "음악" });
check(
  "G-03 ListLive category filter",
  inGame.json.channels?.some((c: any) => c.id === channelId) &&
    !(inMusic.json.channels ?? []).some((c: any) => c.id === channelId),
);

// --- M5 ABR: merged multivariant playlist ---
const pb = await ch("GetPlaybackUrl", { slug });
const liveUrl: string = pb.json.url;
const merged = await until(async () => {
  const r = await fetch(liveUrl);
  const t = await r.text();
  return r.status === 200 && t.includes("r480/") ? t : false;
}, 40_000);
check("G-05 index.m3u8 merges source + 480p", !!merged, merged ? `${(merged.match(/EXT-X-STREAM-INF/g) ?? []).length} variants` : "no r480 variant");
if (merged) {
  const r480 = merged.split("\n").find((l) => l.startsWith("r480/") && l.includes(".m3u8"));
  const vr = r480 ? await fetch(new URL(r480, liveUrl)) : undefined;
  const vtext = vr ? await vr.text() : "";
  check("G-05 480p media playlist is served through the proxy", vr?.status === 200, `status=${vr?.status}`);
  // Latest real segment (warm-up windows list `gap.*` placeholders, as in
  // captureThumbnail); report the first media line too, for diagnosis.
  const media = vtext.split("\n").filter((l) => l && !l.startsWith("#"));
  const seg = media.filter((l) => !l.startsWith("gap.")).at(-1);
  const sr = seg ? await fetch(new URL(seg, new URL(r480!, liveUrl))) : undefined;
  check(
    "G-05 480p segment downloads",
    sr?.status === 200,
    `status=${sr?.status} first=${media[0]?.split("?")[0]} picked=${seg?.split("?")[0]}`,
  );
  const groups = merged.match(/GROUP-ID="[^"]+"/g) ?? [];
  check("G-05 merged group ids are unique", new Set(groups).size === groups.length, groups.join(" "));
}
const forged = await fetch(`http://localhost:8090/hls/${channelId}/r480/index.m3u8?token=deadbeef&exp=9999999999`);
check("live rendition still needs a valid token", forged.status === 403, `status=${forged.status}`);
// Rendition publish path: the MediaMTX auth hook must demand the per-channel HMAC
// (dev INTERNAL_TOKEN default), so an outsider can't hijack the 480p level.
const authHook = async (password: string) =>
  (
    await fetch("http://localhost:8091/mtx/auth", {
      method: "POST",
      body: JSON.stringify({ action: "publish", path: `abr/${channelId}`, password }),
    })
  ).status;
const goodCred = createHmac("sha256", "dev-insecure-internal-token")
  .update(`abr.${channelId}`)
  .digest("hex");
const [badStatus, goodStatus] = [await authHook("guess"), await authHook(goodCred)];
check(
  "G-05 rendition publish requires the HMAC credential",
  badStatus === 401 && goodStatus === 200,
  `bad=${badStatus} good=${goodStatus}`,
);

// --- M4 G-21: playback presence ---
const v1 = crypto.randomUUID();
const v2 = crypto.randomUUID();
await ch("WatchHeartbeat", { channelId, viewerId: v1 });
await ch("WatchHeartbeat", { channelId, viewerId: v2 });
await ch("WatchHeartbeat", { channelId, viewerId: v1 }); // same tab again
const vc = (await ch("GetChannel", { slug })).json.channel?.viewerCount;
check("G-21 viewer count = distinct playing tabs", vc === 2, `viewerCount=${vc}`);

// --- M3 chat over the real WebSocket ---
type Sock = { ws: WebSocket; frames: any[]; role?: string };
async function join(u: U): Promise<Sock> {
  const ws = new WebSocket(`ws://localhost:8080/ws?channelId=${channelId}`, { origin: WEB });
  const s: Sock = { ws, frames: [] };
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const list = m.type === "batch" ? m.items : [m];
    for (const f of list) {
      if (f.type === "ready") s.role = f.role;
      s.frames.push(f);
    }
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "auth", token: u.token }));
  await until(async () => s.role, 10_000);
  return s;
}
const wait = (s: Sock, pred: (f: any) => boolean, ms = 6000) =>
  until(async () => s.frames.find(pred), ms);
const send = (s: Sock, text: string, replyToId = "") =>
  s.ws.send(JSON.stringify({ type: "send", text, replyToId }));

const so = await join(owner);
let sv = await join(viewer);
check("chat role: owner=broadcaster, viewer=viewer", so.role === "broadcaster" && sv.role === "viewer", `${so.role}/${sv.role}`);
const stateFrame = so.frames.find((f) => f.type === "state");
const viewerState = sv.frames.find((f) => f.type === "state");
check(
  "G-10 join state frame; blocked terms only for moderators",
  !!stateFrame && Array.isArray(stateFrame.state.blockedTerms) && viewerState && !("blockedTerms" in viewerState.state),
);

await ch("AddModerator", { userId: mod.id }, owner.token);
const sm = await join(mod);
check("G-09 appointed moderator joins with role moderator", sm.role === "moderator", sm.role);
const mods = await ch("ListModerators", {}, owner.token);
check("G-09 ListModerators", mods.json.moderators?.some((m: any) => m.userId === mod.id));

send(so, `공지 ${run}`);
const ownerMsg = await wait(sv, (f) => f.text === `공지 ${run}`);
check("G-08 broadcaster badge on message", ownerMsg?.badges?.includes("broadcaster"), JSON.stringify(ownerMsg?.badges));
send(sm, `모드 ${run}`);
const modMsg = await wait(sv, (f) => f.text === `모드 ${run}`);
check("G-08 moderator badge on message", modMsg?.badges?.includes("moderator"));

send(sv, `답장 ${run}`, ownerMsg?.id);
const reply = await wait(so, (f) => f.text === `답장 ${run}`);
check(
  "G-07 reply context resolved server-side",
  reply?.replyToId === ownerMsg?.id && reply?.replyToText === `공지 ${run}` && !!reply?.replyToName,
);

const terms = await chat("SetBlockedTerms", { channelId, terms: ["BadWord"] }, owner.token);
check("G-20 broadcaster sets blocked terms", terms.status === 200, `status=${terms.status}`);
send(sv, "this has badword inside");
const blocked = await wait(sv, (f) => f.type === "error");
check("G-20 viewer message with a blocked term is rejected", blocked?.code === "blocked_term", blocked?.code);
send(sm, `mod badword ${run}`);
check("G-20 moderators are exempt", !!(await wait(so, (f) => f.text === `mod badword ${run}`)));
const viewerTerms = await chat("SetBlockedTerms", { channelId, terms: [] }, viewer.token);
check("G-20 viewer cannot change blocked terms", viewerTerms.status === 403, `status=${viewerTerms.status}`);

sv.frames.length = 0;
await chat("Moderate", { channelId, action: "MODERATION_ACTION_FOLLOWERS_ONLY", durationSeconds: 1 }, mod.token);
const fonly = await wait(sv, (f) => f.type === "state" && f.state.followersOnly === true);
check("G-10 followers-only change is broadcast to viewers", !!fonly);
send(sv, `nonfollower ${run}`);
const fo = await wait(sv, (f) => f.type === "error");
check("G-10 non-follower is blocked in followers-only", fo?.code === "followers_only", fo?.code);
sv.frames.length = 0;
await ch("FollowChannel", { channelId }, viewer.token);
send(sv, `follower ${run}`);
check("G-10 following mid-session unlocks chat without reconnect", !!(await wait(so, (f) => f.text === `follower ${run}`)));
await chat("Moderate", { channelId, action: "MODERATION_ACTION_FOLLOWERS_ONLY", durationSeconds: 0 }, owner.token);

sv.frames.length = 0;
await chat("Moderate", { channelId, action: "MODERATION_ACTION_SLOWMODE", durationSeconds: 10 }, owner.token);
await wait(sv, (f) => f.type === "state" && f.state.slowSeconds === 10);
send(sv, `slow1 ${run}`);
await wait(so, (f) => f.text === `slow1 ${run}`);
send(sv, `slow2 ${run}`);
const slow = await wait(sv, (f) => f.type === "error");
check("slowmode still applies to viewers", slow?.code === "slowmode_active", slow?.code);
await chat("Moderate", { channelId, action: "MODERATION_ACTION_SLOWMODE", durationSeconds: 0 }, owner.token);

sv.frames.length = 0;
await chat("Moderate", { channelId, action: "MODERATION_ACTION_PIN", messageId: ownerMsg?.id }, mod.token);
const pinned = await wait(sv, (f) => f.type === "state" && f.state.pinned?.id === ownerMsg?.id);
check("G-19 pin is broadcast", !!pinned);
await chat("Moderate", { channelId, action: "MODERATION_ACTION_DELETE_MESSAGE", messageId: ownerMsg?.id }, mod.token);
const del = await wait(sv, (f) => f.type === "delete" && f.id === ownerMsg?.id);
const unpinned = await wait(sv, (f) => f.type === "state" && f.state.pinned === null);
check("G-09 delete broadcasts; deleting the pinned message unpins it", !!del && !!unpinned);

const banOwner = await chat("Moderate", { channelId, action: "MODERATION_ACTION_BAN", targetUserId: owner.id, durationSeconds: 60 }, mod.token);
check("moderator cannot ban the broadcaster", banOwner.status === 403, `status=${banOwner.status}`);
const viewerMod = await chat("Moderate", { channelId, action: "MODERATION_ACTION_SLOWMODE", durationSeconds: 5 }, viewer.token);
check("viewer cannot moderate", viewerMod.status === 403, `status=${viewerMod.status}`);
sv.frames.length = 0;
const ban = await chat("Moderate", { channelId, action: "MODERATION_ACTION_BAN", targetUserId: viewer.id, durationSeconds: 60 }, mod.token);
const cleared = await wait(so, (f) => f.type === "clear_user" && f.userId === viewer.id);
check("G-09 moderator ban clears the user's messages", ban.status === 200 && !!cleared, `status=${ban.status}`);
send(sv, `banned ${run}`);
const banned = await wait(sv, (f) => f.type === "error");
check("banned viewer cannot send", banned?.code === "banned", banned?.code);
await chat("Moderate", { channelId, action: "MODERATION_ACTION_UNBAN", targetUserId: viewer.id }, mod.token);

const feed = await ch("ListRecentFollowers", {}, owner.token);
check("G-14 activity feed lists the new follower", feed.json.followers?.some((f: any) => f.displayName === `viewer${run.slice(-3)}`));
const liveSummary = await ch("ListMyStreams", {}, owner.token);
const cur = liveSummary.json.streams?.[0];
check("G-13 live summary reads running counters", cur?.live === true && (cur?.peakViewers ?? 0) >= 2, JSON.stringify(cur));

for (const s of [so, sv, sm]) s.ws.close();

// --- end of broadcast: summary + replay ---
await new Promise((r) => push.once("exit", r));
const offline = await until(async () => !(await ch("GetChannel", { slug })).json.channel?.isLive, 30_000);
check("broadcast goes offline", !!offline);
const ended = await until(async () => {
  const s = (await ch("ListMyStreams", {}, owner.token)).json.streams?.[0];
  return s && !s.live ? s : false;
}, 20_000);
check(
  "G-13 ended stream persisted peak viewers and chat count",
  !!ended && ended.peakViewers >= 2 && (ended.chatMessages ?? 0) >= 6,
  JSON.stringify(ended),
);
const lastLive = (await ch("GetChannel", { slug })).json.channel?.lastLiveAt;
check("G-04 lastLiveAt set after broadcast", Number(lastLive) > 0, String(lastLive));

const video = await until(async () => (await ch("ListVideos", { slug })).json.videos?.[0], 40_000);
check("G-15 replay listed after the broadcast", !!video, JSON.stringify(video));
if (video) {
  const vod = await ch("GetVodUrl", { streamId: video.streamId });
  const pl = await fetch(vod.json.url);
  const text = await pl.text();
  check("G-15 replay playlist is a closed VOD", pl.status === 200 && text.includes("#EXT-X-ENDLIST"), `status=${pl.status}`);
  const seg = text.split("\n").find((l) => l && !l.startsWith("#"));
  const sr = seg ? await fetch(new URL(seg, vod.json.url)) : undefined;
  const bytes = sr ? (await sr.arrayBuffer()).byteLength : 0;
  check("G-15 replay segment downloads", sr?.status === 200 && bytes > 1000, `status=${sr?.status} bytes=${bytes}`);
  const u = new URL(vod.json.url);
  u.searchParams.set("token", "0".repeat(64));
  check("G-15 forged replay token is rejected", (await fetch(u)).status === 403);
  const liveTok = new URL(liveUrl);
  const cross = `http://localhost:8090/vod/${video.streamId}/index.m3u8?token=${liveTok.searchParams.get("token")}&exp=${liveTok.searchParams.get("exp")}`;
  check("G-15 a live token cannot open a replay", (await fetch(cross)).status === 403);
  const trav = await fetch(`http://localhost:8090/vod/${video.streamId}/..%2F..%2Fpackage.json?${u.searchParams}`);
  check("G-15 replay file whitelist blocks traversal", trav.status === 404, `status=${trav.status}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exitCode = failed.length ? 1 : 0;
