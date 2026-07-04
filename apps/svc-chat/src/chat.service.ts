import { randomUUID } from "node:crypto";
import type { ServiceImpl, HandlerContext } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { z } from "zod";
import { ChatService, ModerationAction, type ChatMessageSchema } from "@streamix/proto";
import { AppErrorCode } from "@streamix/schemas";
import { redis, createSubscriber, chatChannel } from "./deps.js";
import { appError } from "./errors.js";

const textSchema = z.string().min(1).max(500);

// Redis wire form (JSON-safe; Timestamp rebuilt on the way out).
type WireMsg = {
  id: string;
  channelId: string;
  userId: string;
  displayName: string;
  text: string;
  sentAtMs: number;
};

function toChatMsg(w: WireMsg): MessageInitShape<typeof ChatMessageSchema> {
  return {
    id: w.id,
    channelId: w.channelId,
    userId: w.userId,
    displayName: w.displayName,
    text: w.text,
    sentAt: { seconds: BigInt(Math.floor(w.sentAtMs / 1000)), nanos: (w.sentAtMs % 1000) * 1e6 },
  };
}

function caller(ctx: HandlerContext): { userId: string; displayName: string } {
  const userId = ctx.requestHeader.get("x-user-id");
  if (!userId) throw appError(AppErrorCode.INVALID_CREDENTIALS, "missing authenticated user");
  // HTTP headers must be ASCII, so display name is URL-encoded by the BFF/caller.
  const raw = ctx.requestHeader.get("x-display-name");
  return { userId, displayName: raw ? decodeURIComponent(raw) : "익명" };
}

const banKey = (ch: string, u: string) => `ban:${ch}:${u}`;
const slowmodeKey = (ch: string) => `slowmode:${ch}`;
const slowmodeUserKey = (ch: string, u: string) => `sm:${ch}:${u}`;
const viewersKey = (ch: string) => `viewers:${ch}`;

export const chatService: ServiceImpl<typeof ChatService> = {
  async send(req, ctx) {
    const { userId, displayName } = caller(ctx);
    const text = textSchema.parse(req.text);

    if (await redis.exists(banKey(req.channelId, userId))) {
      throw appError(AppErrorCode.BANNED, "you are banned in this channel");
    }
    const slow = Number((await redis.get(slowmodeKey(req.channelId))) ?? 0);
    if (slow > 0) {
      const set = await redis.set(slowmodeUserKey(req.channelId, userId), "1", "EX", slow, "NX");
      if (set !== "OK") throw appError(AppErrorCode.SLOWMODE_ACTIVE, `slow mode: ${slow}s`);
    }

    const wire: WireMsg = {
      id: randomUUID(),
      channelId: req.channelId,
      userId,
      displayName,
      text,
      sentAtMs: Date.now(),
    };
    // Fan-out publish; every BFF instance subscribed to this room relays it (ADR-4).
    await redis.publish(chatChannel(req.channelId), JSON.stringify(wire));
    return { message: toChatMsg(wire) };
  },

  async *join(req, ctx) {
    // Server-streaming example (§6.2). Production hot-path fanout is BFF's own
    // refcounted Redis subscription; this bridge makes fanout smoke-testable.
    const sub = createSubscriber();
    const queue: WireMsg[] = [];
    let wake: (() => void) | null = null;

    sub.on("message", (_ch, payload) => {
      queue.push(JSON.parse(payload) as WireMsg);
      wake?.();
      wake = null;
    });
    await sub.subscribe(chatChannel(req.channelId));
    await redis.incr(viewersKey(req.channelId));

    try {
      while (!ctx.signal.aborted) {
        while (queue.length) yield { message: toChatMsg(queue.shift()!) };
        if (ctx.signal.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
      }
    } finally {
      await sub.unsubscribe().catch(() => {});
      sub.disconnect();
      await redis.decr(viewersKey(req.channelId));
    }
  },

  async moderate(req, ctx) {
    // Authorization (channel owner/mod) is enforced at the BFF before this call.
    caller(ctx);
    const ch = req.channelId;
    switch (req.action) {
      case ModerationAction.BAN: {
        const key = banKey(ch, req.targetUserId);
        if (req.durationSeconds > 0) await redis.set(key, "1", "EX", req.durationSeconds);
        else await redis.set(key, "1");
        break;
      }
      case ModerationAction.UNBAN:
        await redis.del(banKey(ch, req.targetUserId));
        break;
      case ModerationAction.SLOWMODE:
        if (req.durationSeconds > 0) await redis.set(slowmodeKey(ch), String(req.durationSeconds));
        else await redis.del(slowmodeKey(ch));
        break;
      default:
        throw appError(AppErrorCode.VALIDATION, "unknown moderation action");
    }
    return {};
  },
};
