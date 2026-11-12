import { createHmac, randomUUID } from "node:crypto";
import type { ServiceImpl, HandlerContext } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { and, desc, eq, gt, ilike, isNotNull, max, or } from "drizzle-orm";
import { z } from "zod";
import { ChannelService, ChatRole, type ChannelSchema } from "@streamix/proto";
import { AppErrorCode, categorySchema } from "@streamix/schemas";
import { channelModerators, channels, follows, streams, users } from "@streamix/db";
import { db, redis } from "../deps.js";
import { env } from "../env.js";
import { appError, isUniqueViolation } from "../errors.js";
import {
  generateStreamKey,
  hashStreamKey,
  generateIngestToken,
  INGEST_TOKEN_PREFIX,
} from "./stream-key.js";

// Browser ingest tokens live in Redis (ADR-13); 15m covers a go-live session,
// and the web re-issues on reconnect.
const INGEST_TOKEN_TTL_SECONDS = 900;
function ingestTokenKey(token: string): string {
  return `ingest:${token}`;
}

// Resolve a WS ?key= to a channelId. A "bit_" browser token is looked up in
// Redis; anything else is a durable stream key matched by hash. Shared by
// ValidateStreamKey and StartStream so both go-live paths accept both forms.
async function resolveChannelId(streamKey: string): Promise<string | null> {
  if (streamKey.startsWith(INGEST_TOKEN_PREFIX)) {
    try {
      return (await redis.get(ingestTokenKey(streamKey))) || null;
    } catch {
      return null; // Redis down -> token unverifiable; fail closed
    }
  }
  const [c] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.streamKeyHash, hashStreamKey(streamKey)))
    .limit(1);
  return c?.id ?? null;
}

const slugSchema = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-z0-9-]+$/, "slug must be kebab-case");
const titleSchema = z.string().min(1).max(140);
const uuidSchema = z.string().uuid();
const SEARCH_LIMIT = 20;

// Bad input -> VALIDATION (400), not an unmapped ZodError (Internal).
function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw appError(AppErrorCode.VALIDATION, r.error.issues[0]?.message);
  return r.data;
}

const channelCols = {
  id: channels.id,
  ownerUserId: channels.ownerUserId,
  slug: channels.slug,
  title: channels.title,
  category: channels.category,
};

// Stable sort: live channels first, original order otherwise.
const liveFirst = <T extends { isLive?: boolean }>(list: T[]) =>
  [...list].sort((a, b) => Number(Boolean(b.isLive)) - Number(Boolean(a.isLive)));

type ChannelRow = {
  id: string;
  ownerUserId: string;
  slug: string;
  title: string;
  category: string | null;
};

function liveKey(channelId: string): string {
  return `live:${channelId}`;
}
// Playback presence (benchmark G-21): ZSET member = viewer id, score = last beat ms.
const WATCH_WINDOW_MS = 60_000;
const watchKey = (channelId: string) => `watching:${channelId}`;
// Per-broadcast counters, reset at start and persisted at stop (benchmark G-13).
// chatcount is incremented by svc-chat; keep the key name in sync there.
const peakKey = (channelId: string) => `peak:${channelId}`;
const chatCountKey = (channelId: string) => `chatcount:${channelId}`;

// Record a beat, drop stale viewers, count, and raise the broadcast peak — one
// atomic step so concurrent beats can't lose a peak.
const WATCH_BEAT_LUA = `
local now = tonumber(ARGV[1])
redis.call('ZADD', KEYS[1], now, ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
local c = redis.call('ZCARD', KEYS[1])
local p = tonumber(redis.call('GET', KEYS[2]) or '0')
if c > p then redis.call('SET', KEYS[2], c, 'EX', 86400) end
return c`;

const toUnix = (d: Date | null) => (d ? BigInt(Math.floor(d.getTime() / 1000)) : 0n);

// Replays: long enough tokens to watch a recording end to end without refresh.
const VOD_TOKEN_TTL_SECONDS = 4 * 3600;
const vodCutoff = () => new Date(Date.now() - env.VOD_RETENTION_DAYS * 86_400_000);
const durationSeconds = (start: Date, end: Date | null) =>
  end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000)) : 0;

async function toChannelMsg(
  row: ChannelRow,
  fallbackLive = false,
): Promise<MessageInitShape<typeof ChannelSchema>> {
  // Redis is the liveness truth; on outage degrade to the caller's fallback
  // (ListLive passes the Postgres status; §10 Redis SPOF fallback).
  let isLive = fallbackLive;
  let viewers = 0;
  try {
    const [exists, v] = await Promise.all([
      redis.exists(liveKey(row.id)),
      redis.zcount(watchKey(row.id), Date.now() - WATCH_WINDOW_MS, "+inf"),
    ]);
    isLive = exists === 1;
    viewers = isLive ? v : 0;
  } catch {
    /* Redis unavailable -> keep fallbackLive, viewers 0 */
  }
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    title: row.title,
    category: row.category ?? "",
    isLive,
    viewerCount: viewers,
    // Media serves this once captured; the client falls back if it 404s.
    thumbnailUrl: isLive ? `${env.MEDIA_PUBLIC_URL}/thumb/${row.id}.jpg` : "",
  };
}

// Channel owned by the caller; owner-scoped RPCs never take a channel id.
async function ownedChannelId(ownerUserId: string): Promise<string> {
  const [c] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.ownerUserId, ownerUserId))
    .limit(1);
  if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
  return c.id;
}

function requireUserId(ctx: HandlerContext): string {
  const id = ctx.requestHeader.get("x-user-id");
  if (!id) throw appError(AppErrorCode.INVALID_CREDENTIALS, "missing authenticated user");
  return id;
}

export const channelService: ServiceImpl<typeof ChannelService> = {
  async createChannel(req, ctx) {
    const ownerUserId = requireUserId(ctx);
    const slug = slugSchema.parse(req.slug);
    const title = titleSchema.parse(req.title);
    const streamKey = generateStreamKey();
    try {
      const [c] = await db
        .insert(channels)
        .values({
          ownerUserId,
          slug,
          title,
          category: req.category ? validated(categorySchema, req.category) : null,
          streamKeyHash: hashStreamKey(streamKey),
          streamKeyPrefix: streamKey.slice(0, 13),
          streamKeyIssuedAt: new Date(),
        })
        .returning();
      return { channel: await toChannelMsg(c!), streamKey };
    } catch (e) {
      if (isUniqueViolation(e)) throw appError(AppErrorCode.SLUG_TAKEN);
      throw e;
    }
  },

  async getChannel(req) {
    const [c] = await db.select().from(channels).where(eq(channels.slug, req.slug)).limit(1);
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    const [last] = await db
      .select({ at: max(streams.startedAt) })
      .from(streams)
      .where(eq(streams.channelId, c.id));
    const lastLiveAt = last?.at ? BigInt(Math.floor(last.at.getTime() / 1000)) : 0n;
    return { channel: { ...(await toChannelMsg(c)), lastLiveAt } };
  },

  async listLive(req) {
    const isLiveRow = eq(streams.status, "live");
    const rows = await db
      .select(channelCols)
      .from(streams)
      .innerJoin(channels, eq(streams.channelId, channels.id))
      .where(req.category ? and(isLiveRow, eq(channels.category, req.category)) : isLiveRow);

    // Dedup by channel (a zombie 'live' row + a fresh one can coexist), then keep
    // only channels whose Redis live key is still alive (TTL is the truth, §5.2)
    // so streams killed without donePublish don't linger in the list.
    const byId = new Map(rows.map((r) => [r.id, r]));
    // fallbackLive=true: if Redis is down, trust Postgres status='live' (§10).
    const mapped = await Promise.all([...byId.values()].map((r) => toChannelMsg(r, true)));
    const live = mapped.filter((c) => c.isLive);
    return { channels: live, pageInfo: { total: live.length, page: 1, pageSize: live.length } };
  },

  async getMyChannel(_req, ctx) {
    const ownerUserId = requireUserId(ctx);
    const [c] = await db
      .select()
      .from(channels)
      .where(eq(channels.ownerUserId, ownerUserId))
      .limit(1);
    // No channel yet is a normal state, not an error: channel stays unset.
    if (!c) return {};
    return {
      channel: await toChannelMsg(c),
      streamKeyPrefix: c.streamKeyPrefix ?? "",
      streamKeyIssuedAt: c.streamKeyIssuedAt
        ? BigInt(Math.floor(c.streamKeyIssuedAt.getTime() / 1000))
        : 0n,
    };
  },

  async rotateStreamKey(_req, ctx) {
    const ownerUserId = requireUserId(ctx);
    const streamKey = generateStreamKey();
    const [c] = await db
      .update(channels)
      .set({
        streamKeyHash: hashStreamKey(streamKey),
        streamKeyPrefix: streamKey.slice(0, 13),
        streamKeyIssuedAt: new Date(),
      })
      .where(eq(channels.ownerUserId, ownerUserId))
      .returning({ id: channels.id });
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    return { streamKey };
  },

  async issueIngestToken(_req, ctx) {
    const ownerUserId = requireUserId(ctx);
    const [c] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.ownerUserId, ownerUserId))
      .limit(1);
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    const token = generateIngestToken();
    await redis.set(ingestTokenKey(token), c.id, "EX", INGEST_TOKEN_TTL_SECONDS);
    return {
      token,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + INGEST_TOKEN_TTL_SECONDS),
    };
  },

  async updateChannel(req, ctx) {
    const ownerUserId = requireUserId(ctx);
    // Empty title/category = "leave unchanged" (title is required, never cleared).
    const set: { title?: string; category?: string } = {};
    if (req.title) set.title = titleSchema.parse(req.title);
    if (req.category) set.category = validated(categorySchema, req.category);
    if (Object.keys(set).length === 0) {
      const [c] = await db
        .select()
        .from(channels)
        .where(eq(channels.ownerUserId, ownerUserId))
        .limit(1);
      if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
      return { channel: await toChannelMsg(c) };
    }
    const [c] = await db
      .update(channels)
      .set(set)
      .where(eq(channels.ownerUserId, ownerUserId))
      .returning();
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    return { channel: await toChannelMsg(c) };
  },

  async validateStreamKey(req) {
    const channelId = await resolveChannelId(req.streamKey);
    return { valid: Boolean(channelId), channelId: channelId ?? "" };
  },

  async startStream(req) {
    const channelId = await resolveChannelId(req.streamKey);
    if (!channelId) throw appError(AppErrorCode.INVALID_STREAM_KEY);

    // Core is the single writer of live state (§5.2). SET NX blocks a second encoder.
    const claim = randomUUID();
    const acquired = await redis.set(liveKey(channelId), claim, "EX", env.LIVE_TTL_SECONDS, "NX");
    if (acquired !== "OK") {
      throw new ConnectError("channel already live", Code.AlreadyExists);
    }
    let streamId: string;
    try {
      const [row] = await db
        .insert(streams)
        .values({ channelId, status: "live" })
        .returning({ id: streams.id });
      streamId = row!.id;
    } catch (error) {
      await redis
        .eval(
          'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
          1,
          liveKey(channelId),
          claim,
        )
        .catch(() => {});
      throw error;
    }
    // Fresh counters for this broadcast, outside the claim-rollback block: a
    // failure here only costs summary accuracy and must not fail the go-live.
    try {
      await redis.del(peakKey(channelId), chatCountKey(channelId));
    } catch {
      /* best effort */
    }
    return { channelId, streamId };
  },

  async stopStream(req) {
    const [peak, chats] = await redis
      .mget(peakKey(req.channelId), chatCountKey(req.channelId))
      .catch(() => [null, null]);
    await db
      .update(streams)
      .set({
        status: "ended",
        endedAt: new Date(),
        peakViewers: Number(peak ?? 0),
        chatMessages: Number(chats ?? 0),
      })
      .where(and(eq(streams.channelId, req.channelId), eq(streams.status, "live")));
    await redis.del(liveKey(req.channelId));
    return {};
  },

  async heartbeat(req) {
    // Refresh TTL (§5.2 zombie guard). SET (not EXPIRE) also re-registers the
    // key if it was lost — e.g. after a Redis restart — so the stream recovers.
    await redis.set(liveKey(req.channelId), "1", "EX", env.LIVE_TTL_SECONDS);
    return {};
  },

  async searchChannels(req) {
    const q = req.query.trim().slice(0, 50);
    if (!q) return { channels: [] };
    // Escape LIKE wildcards so user input matches literally.
    const pattern = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    // ponytail: sequential ILIKE scan over channels; fine at hundreds of rows,
    // add a pg_trgm GIN index when search latency shows up.
    const rows = await db
      .select(channelCols)
      .from(channels)
      .where(
        or(
          ilike(channels.slug, pattern),
          ilike(channels.title, pattern),
          ilike(channels.category, pattern),
        ),
      )
      .limit(SEARCH_LIMIT);
    return { channels: liveFirst(await Promise.all(rows.map((r) => toChannelMsg(r)))) };
  },

  async followChannel(req, ctx) {
    const followerUserId = requireUserId(ctx);
    const channelId = validated(uuidSchema, req.channelId);
    const [c] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    await db.insert(follows).values({ followerUserId, channelId }).onConflictDoNothing();
    return {};
  },

  async unfollowChannel(req, ctx) {
    const followerUserId = requireUserId(ctx);
    const channelId = validated(uuidSchema, req.channelId);
    await db
      .delete(follows)
      .where(and(eq(follows.followerUserId, followerUserId), eq(follows.channelId, channelId)));
    return {};
  },

  async listFollowing(_req, ctx) {
    const followerUserId = requireUserId(ctx);
    const rows = await db
      .select(channelCols)
      .from(follows)
      .innerJoin(channels, eq(follows.channelId, channels.id))
      .where(eq(follows.followerUserId, followerUserId))
      .orderBy(desc(follows.createdAt));
    return { channels: liveFirst(await Promise.all(rows.map((r) => toChannelMsg(r)))) };
  },

  async addModerator(req, ctx) {
    const ownerUserId = requireUserId(ctx);
    const userId = validated(uuidSchema, req.userId);
    if (userId === ownerUserId)
      throw appError(AppErrorCode.VALIDATION, "owner is already broadcaster");
    const channelId = await ownedChannelId(ownerUserId);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw appError(AppErrorCode.NOT_FOUND, "user not found");
    await db.insert(channelModerators).values({ channelId, userId }).onConflictDoNothing();
    return {};
  },

  async removeModerator(req, ctx) {
    const ownerUserId = requireUserId(ctx);
    const userId = validated(uuidSchema, req.userId);
    const channelId = await ownedChannelId(ownerUserId);
    await db
      .delete(channelModerators)
      .where(and(eq(channelModerators.channelId, channelId), eq(channelModerators.userId, userId)));
    return {};
  },

  async listModerators(_req, ctx) {
    const channelId = await ownedChannelId(requireUserId(ctx));
    const rows = await db
      .select({ userId: users.id, displayName: users.displayName })
      .from(channelModerators)
      .innerJoin(users, eq(channelModerators.userId, users.id))
      .where(eq(channelModerators.channelId, channelId))
      .orderBy(desc(channelModerators.createdAt));
    return { moderators: rows };
  },

  async watchHeartbeat(req) {
    const channelId = validated(uuidSchema, req.channelId);
    const viewerId = validated(uuidSchema, req.viewerId);
    // Only live channels collect presence; offline beats are ignored, not errors.
    // ponytail: unauthenticated beats can inflate the count, bounded only by the
    // BFF per-IP RPC rate limit; upgrade = sign viewer ids into the playback URL.
    if ((await redis.exists(liveKey(channelId))) !== 1) return {};
    await redis.eval(
      WATCH_BEAT_LUA,
      2,
      watchKey(channelId),
      peakKey(channelId),
      Date.now(),
      viewerId,
      WATCH_WINDOW_MS,
    );
    return {};
  },

  async listMyStreams(_req, ctx) {
    const channelId = await ownedChannelId(requireUserId(ctx));
    const rows = await db
      .select()
      .from(streams)
      .where(eq(streams.channelId, channelId))
      .orderBy(desc(streams.startedAt))
      .limit(10);
    // A live broadcast has not persisted its counters yet: read them from Redis.
    const [peak, chats] = rows.some((r) => r.status === "live")
      ? await redis.mget(peakKey(channelId), chatCountKey(channelId)).catch(() => [null, null])
      : [null, null];
    return {
      streams: rows.map((r) => {
        const live = r.status === "live";
        return {
          id: r.id,
          startedAt: toUnix(r.startedAt),
          endedAt: toUnix(r.endedAt),
          peakViewers: live ? Number(peak ?? 0) : r.peakViewers,
          chatMessages: live ? Number(chats ?? 0) : r.chatMessages,
          live,
        };
      }),
    };
  },

  // Internal-only (svc-media recorder): the recording is complete and playable.
  async markVodReady(req) {
    const streamId = validated(uuidSchema, req.streamId);
    await db.update(streams).set({ vodReadyAt: new Date() }).where(eq(streams.id, streamId));
    return {};
  },

  async listVideos(req) {
    const [c] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.slug, req.slug))
      .limit(1);
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    const rows = await db
      .select()
      .from(streams)
      .where(
        and(
          eq(streams.channelId, c.id),
          isNotNull(streams.vodReadyAt),
          gt(streams.startedAt, vodCutoff()),
        ),
      )
      .orderBy(desc(streams.startedAt))
      .limit(20);
    return {
      videos: rows.map((r) => ({
        streamId: r.id,
        startedAt: toUnix(r.startedAt),
        durationSeconds: durationSeconds(r.startedAt, r.endedAt),
        peakViewers: r.peakViewers,
      })),
    };
  },

  async getVodUrl(req) {
    const streamId = validated(uuidSchema, req.streamId);
    const [r] = await db
      .select({
        startedAt: streams.startedAt,
        endedAt: streams.endedAt,
        vodReadyAt: streams.vodReadyAt,
        slug: channels.slug,
        title: channels.title,
      })
      .from(streams)
      .innerJoin(channels, eq(streams.channelId, channels.id))
      .where(eq(streams.id, streamId))
      .limit(1);
    // Outside the window the files are (being) deleted by svc-media.
    if (!r?.vodReadyAt || r.startedAt <= vodCutoff())
      throw appError(AppErrorCode.NOT_FOUND, "video not found");
    const exp = Math.floor(Date.now() / 1000) + VOD_TOKEN_TTL_SECONDS;
    // "vod." prefix: a replay token can never authorize live HLS and vice versa.
    const token = createHmac("sha256", env.PLAYBACK_SECRET)
      .update(`vod.${streamId}.${exp}`)
      .digest("hex");
    return {
      url: `${env.MEDIA_PUBLIC_URL}/vod/${streamId}/index.m3u8?token=${token}&exp=${exp}`,
      expiresAt: BigInt(exp),
      channelSlug: r.slug,
      channelTitle: r.title,
      startedAt: toUnix(r.startedAt),
      durationSeconds: durationSeconds(r.startedAt, r.endedAt),
    };
  },

  async listRecentFollowers(_req, ctx) {
    const channelId = await ownedChannelId(requireUserId(ctx));
    const rows = await db
      .select({ displayName: users.displayName, createdAt: follows.createdAt })
      .from(follows)
      .innerJoin(users, eq(follows.followerUserId, users.id))
      .where(eq(follows.channelId, channelId))
      .orderBy(desc(follows.createdAt))
      .limit(20);
    return {
      followers: rows.map((r) => ({ displayName: r.displayName, followedAt: toUnix(r.createdAt) })),
    };
  },

  // Internal-only (BFF chat): role drives badges and moderation authz; following
  // drives followers-only chat.
  async getChatRole(req) {
    const [c] = await db
      .select({ ownerUserId: channels.ownerUserId })
      .from(channels)
      .where(eq(channels.id, req.channelId))
      .limit(1);
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    const [[mod], [follow]] = await Promise.all([
      db
        .select({ userId: channelModerators.userId })
        .from(channelModerators)
        .where(
          and(
            eq(channelModerators.channelId, req.channelId),
            eq(channelModerators.userId, req.userId),
          ),
        )
        .limit(1),
      db
        .select({ userId: follows.followerUserId })
        .from(follows)
        .where(and(eq(follows.channelId, req.channelId), eq(follows.followerUserId, req.userId)))
        .limit(1),
    ]);
    const role =
      c.ownerUserId === req.userId
        ? ChatRole.BROADCASTER
        : mod
          ? ChatRole.MODERATOR
          : ChatRole.VIEWER;
    return { role, following: Boolean(follow) };
  },

  // Internal-only (BFF chat room gate, inbox/review.md V4-1): existence by id
  // so arbitrary valid-format UUIDs can't allocate chat rooms/subscriptions.
  async channelExists(req) {
    const [c] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, req.channelId))
      .limit(1);
    return { exists: Boolean(c) };
  },

  async getPlaybackUrl(req) {
    // Signed short-lived HLS URL (§5.2 data-plane playback authz). svc-media
    // verifies the HMAC before serving; keyed by channelId, not the stream key.
    const [c] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.slug, req.slug))
      .limit(1);
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");

    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = createHmac("sha256", env.PLAYBACK_SECRET).update(`${c.id}.${exp}`).digest("hex");
    return {
      url: `${env.MEDIA_PUBLIC_URL}/hls/${c.id}/index.m3u8?token=${token}&exp=${exp}`,
      expiresAt: BigInt(exp),
    };
  },
};
