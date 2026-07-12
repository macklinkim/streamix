import { createHmac } from "node:crypto";
import type { ServiceImpl, HandlerContext } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ChannelService, type ChannelSchema } from "@streamix/proto";
import { AppErrorCode } from "@streamix/schemas";
import { channels, streams } from "@streamix/db";
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
function viewersKey(channelId: string): string {
  return `viewers:${channelId}`;
}

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
      redis.get(viewersKey(row.id)),
    ]);
    isLive = exists === 1;
    viewers = v ? Number(v) : 0;
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
          category: req.category || null,
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
    return { channel: await toChannelMsg(c) };
  },

  async listLive() {
    const rows = await db
      .select({
        id: channels.id,
        ownerUserId: channels.ownerUserId,
        slug: channels.slug,
        title: channels.title,
        category: channels.category,
      })
      .from(streams)
      .innerJoin(channels, eq(streams.channelId, channels.id))
      .where(eq(streams.status, "live"));

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
    if (req.category) set.category = req.category.slice(0, 50);
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
    const acquired = await redis.set(liveKey(channelId), "1", "EX", env.LIVE_TTL_SECONDS, "NX");
    if (acquired !== "OK") {
      throw new ConnectError("channel already live", Code.AlreadyExists);
    }
    await db.insert(streams).values({ channelId, status: "live" });
    return { channelId };
  },

  async stopStream(req) {
    await db
      .update(streams)
      .set({ status: "ended", endedAt: new Date() })
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
