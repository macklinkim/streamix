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
import { generateStreamKey, hashStreamKey } from "./stream-key.js";

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
    return c ? { channel: await toChannelMsg(c) } : {};
  },

  async rotateStreamKey(_req, ctx) {
    const ownerUserId = requireUserId(ctx);
    const streamKey = generateStreamKey();
    const [c] = await db
      .update(channels)
      .set({ streamKeyHash: hashStreamKey(streamKey) })
      .where(eq(channels.ownerUserId, ownerUserId))
      .returning({ id: channels.id });
    if (!c) throw appError(AppErrorCode.NOT_FOUND, "channel not found");
    return { streamKey };
  },

  async validateStreamKey(req) {
    const [c] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.streamKeyHash, hashStreamKey(req.streamKey)))
      .limit(1);
    return { valid: Boolean(c), channelId: c?.id ?? "" };
  },

  async startStream(req) {
    const [c] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.streamKeyHash, hashStreamKey(req.streamKey)))
      .limit(1);
    if (!c) throw appError(AppErrorCode.INVALID_STREAM_KEY);

    // Core is the single writer of live state (§5.2). SET NX blocks a second encoder.
    const acquired = await redis.set(liveKey(c.id), "1", "EX", env.LIVE_TTL_SECONDS, "NX");
    if (acquired !== "OK") {
      throw new ConnectError("channel already live", Code.AlreadyExists);
    }
    await db.insert(streams).values({ channelId: c.id, status: "live" });
    return { channelId: c.id };
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
