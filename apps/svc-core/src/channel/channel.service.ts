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

async function toChannelMsg(row: ChannelRow): Promise<MessageInitShape<typeof ChannelSchema>> {
  const [isLive, viewers] = await Promise.all([
    redis.exists(liveKey(row.id)),
    redis.get(viewersKey(row.id)),
  ]);
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    slug: row.slug,
    title: row.title,
    category: row.category ?? "",
    isLive: isLive === 1,
    viewerCount: viewers ? Number(viewers) : 0,
    // Media serves this once captured; the client falls back if it 404s.
    thumbnailUrl: isLive === 1 ? `${env.MEDIA_PUBLIC_URL}/thumb/${row.id}.jpg` : "",
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
    const list = await Promise.all(rows.map(toChannelMsg));
    return { channels: list, pageInfo: { total: list.length, page: 1, pageSize: list.length } };
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
    // Refresh TTL so Core doesn't reap a healthy stream (§5.2 zombie guard).
    await redis.expire(liveKey(req.channelId), env.LIVE_TTL_SECONDS);
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
