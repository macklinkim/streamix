import { randomUUID } from "node:crypto";
import type { ServiceImpl, HandlerContext } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { z } from "zod";
import { ChatService, ModerationAction, type ChatMessageSchema } from "@streamix/proto";
import { AppErrorCode } from "@streamix/schemas";
import { redis, createSubscriber, chatChannel } from "./deps.js";
import { appError } from "./errors.js";

const textSchema = z.string().min(1).max(500);
const BADGES = new Set(["broadcaster", "moderator"]);
// Recent messages stay addressable (reply / delete / pin) for this long.
const MESSAGE_TTL_SECONDS = 3600;
const REPLY_SNIPPET = 100;
const MAX_BLOCKED_TERMS = 100;

// Redis wire form (JSON-safe; Timestamp rebuilt on the way out). The BFF relays
// this verbatim to browsers; events carry a `type` field, messages do not.
type WireMsg = {
  id: string;
  channelId: string;
  userId: string;
  displayName: string;
  text: string;
  sentAtMs: number;
  badges: string[];
  replyToId?: string;
  replyToName?: string;
  replyToText?: string;
};

function toChatMsg(w: WireMsg): MessageInitShape<typeof ChatMessageSchema> {
  return {
    id: w.id,
    channelId: w.channelId,
    userId: w.userId,
    displayName: w.displayName,
    text: w.text,
    sentAt: { seconds: BigInt(Math.floor(w.sentAtMs / 1000)), nanos: (w.sentAtMs % 1000) * 1e6 },
    badges: w.badges ?? [],
    replyToId: w.replyToId ?? "",
    replyToName: w.replyToName ?? "",
    replyToText: w.replyToText ?? "",
  };
}

// The BFF resolves role/follow status from svc-core and passes them as internal
// headers (trusted: internal-token boundary, P2-1).
function caller(ctx: HandlerContext) {
  const userId = ctx.requestHeader.get("x-user-id");
  if (!userId) throw appError(AppErrorCode.INVALID_CREDENTIALS, "missing authenticated user");
  // HTTP headers must be ASCII, so display name is URL-encoded by the BFF/caller.
  const raw = ctx.requestHeader.get("x-display-name");
  const badges = (ctx.requestHeader.get("x-chat-badges") ?? "")
    .split(",")
    .filter((b) => BADGES.has(b));
  return {
    userId,
    displayName: raw ? decodeURIComponent(raw) : "익명",
    badges,
    privileged: badges.length > 0,
    follower: ctx.requestHeader.get("x-chat-follower") === "1",
  };
}

const banKey = (ch: string, u: string) => `ban:${ch}:${u}`;
const slowmodeKey = (ch: string) => `slowmode:${ch}`;
const slowmodeUserKey = (ch: string, u: string) => `sm:${ch}:${u}`;
const followersOnlyKey = (ch: string) => `fonly:${ch}`;
const blockedKey = (ch: string) => `blocked:${ch}`;
const pinKey = (ch: string) => `pin:${ch}`;
const messageKey = (ch: string, id: string) => `chatmsg:${ch}:${id}`;
// Per-broadcast chat count; svc-core resets it at stream start and persists it at
// stop (benchmark G-13). Keep the key name in sync with svc-core.
const chatCountKey = (ch: string) => `chatcount:${ch}`;

const publish = (ch: string, payload: object) =>
  redis.publish(chatChannel(ch), JSON.stringify(payload));

async function readMessage(ch: string, id: string): Promise<WireMsg | null> {
  if (!id) return null;
  const raw = await redis.get(messageKey(ch, id));
  return raw ? (JSON.parse(raw) as WireMsg) : null;
}

async function roomState(ch: string) {
  const [[slow, fonly, pin], terms] = await Promise.all([
    redis.mget(slowmodeKey(ch), followersOnlyKey(ch), pinKey(ch)),
    redis.smembers(blockedKey(ch)),
  ]);
  return {
    slowSeconds: Number(slow ?? 0),
    followersOnly: fonly === "1",
    pinned: pin ? (JSON.parse(pin) as WireMsg) : null,
    blockedTerms: terms.sort(),
  };
}

// Browsers get the policy state without blocked terms (moderators receive the
// list from the BFF on join; it is not broadcast).
async function publishState(ch: string): Promise<void> {
  const { blockedTerms: _omit, ...state } = await roomState(ch);
  await publish(ch, { type: "state", state });
}

export const chatService: ServiceImpl<typeof ChatService> = {
  async send(req, ctx) {
    const who = caller(ctx);
    const parsed = textSchema.safeParse(req.text);
    if (!parsed.success) throw appError(AppErrorCode.VALIDATION);
    const text = parsed.data;
    const ch = req.channelId;

    if (await redis.exists(banKey(ch, who.userId))) throw appError(AppErrorCode.BANNED);
    // Broadcaster and moderators are exempt from room restrictions (Twitch parity).
    if (!who.privileged) {
      const state = await roomState(ch);
      if (state.followersOnly && !who.follower) throw appError(AppErrorCode.FOLLOWERS_ONLY);
      const lower = text.toLowerCase();
      if (state.blockedTerms.some((t) => lower.includes(t)))
        throw appError(AppErrorCode.BLOCKED_TERM);
      if (state.slowSeconds > 0) {
        const set = await redis.set(
          slowmodeUserKey(ch, who.userId),
          "1",
          "EX",
          state.slowSeconds,
          "NX",
        );
        if (set !== "OK") throw appError(AppErrorCode.SLOWMODE_ACTIVE);
      }
    }

    // Reply context comes from our own copy of the parent, never from the client.
    const parent = await readMessage(ch, req.replyToId);
    const wire: WireMsg = {
      id: randomUUID(),
      channelId: ch,
      userId: who.userId,
      displayName: who.displayName,
      text,
      sentAtMs: Date.now(),
      badges: who.badges,
      ...(parent && {
        replyToId: parent.id,
        replyToName: parent.displayName,
        replyToText: parent.text.slice(0, REPLY_SNIPPET),
      }),
    };
    const payload = JSON.stringify(wire);
    await redis
      .multi()
      .set(messageKey(ch, wire.id), payload, "EX", MESSAGE_TTL_SECONDS)
      .incr(chatCountKey(ch))
      .exec();
    // Fan-out publish; every BFF instance subscribed to this room relays it (ADR-4).
    await redis.publish(chatChannel(ch), payload);
    return { message: toChatMsg(wire) };
  },

  async *join(req, ctx) {
    // Server-streaming example (§6.2). Production hot-path fanout is BFF's own
    // refcounted Redis subscription; this bridge makes fanout smoke-testable.
    const sub = createSubscriber();
    const queue: WireMsg[] = [];
    let wake: (() => void) | null = null;

    sub.on("message", (_ch, payload) => {
      const parsed = JSON.parse(payload);
      if (parsed.type) return; // room events (delete/state) are not messages
      queue.push(parsed as WireMsg);
      wake?.();
      wake = null;
    });
    await sub.subscribe(chatChannel(req.channelId));

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
    }
  },

  async moderate(req, ctx) {
    // Authorization (owner/moderator, target rules) is enforced at the BFF.
    caller(ctx);
    const ch = req.channelId;
    switch (req.action) {
      case ModerationAction.BAN: {
        const key = banKey(ch, req.targetUserId);
        if (req.durationSeconds > 0) await redis.set(key, "1", "EX", req.durationSeconds);
        else await redis.set(key, "1");
        // Clear the user's visible messages on every client.
        await publish(ch, { type: "clear_user", userId: req.targetUserId });
        break;
      }
      case ModerationAction.UNBAN:
        await redis.del(banKey(ch, req.targetUserId));
        break;
      case ModerationAction.SLOWMODE:
        if (req.durationSeconds > 0) await redis.set(slowmodeKey(ch), String(req.durationSeconds));
        else await redis.del(slowmodeKey(ch));
        await publishState(ch);
        break;
      case ModerationAction.FOLLOWERS_ONLY:
        if (req.durationSeconds > 0) await redis.set(followersOnlyKey(ch), "1");
        else await redis.del(followersOnlyKey(ch));
        await publishState(ch);
        break;
      case ModerationAction.DELETE_MESSAGE: {
        if (!req.messageId) throw appError(AppErrorCode.VALIDATION, "message_id required");
        await redis.del(messageKey(ch, req.messageId));
        await publish(ch, { type: "delete", id: req.messageId });
        const state = await roomState(ch);
        if (state.pinned?.id === req.messageId) {
          await redis.del(pinKey(ch));
          await publishState(ch);
        }
        break;
      }
      case ModerationAction.PIN: {
        const msg = await readMessage(ch, req.messageId);
        if (!msg) throw appError(AppErrorCode.NOT_FOUND, "message expired");
        await redis.set(pinKey(ch), JSON.stringify(msg));
        await publishState(ch);
        break;
      }
      case ModerationAction.UNPIN:
        await redis.del(pinKey(ch));
        await publishState(ch);
        break;
      default:
        throw appError(AppErrorCode.VALIDATION, "unknown moderation action");
    }
    return {};
  },

  async getRoomState(req) {
    const s = await roomState(req.channelId);
    return {
      state: {
        slowSeconds: s.slowSeconds,
        followersOnly: s.followersOnly,
        pinned: s.pinned ? toChatMsg(s.pinned) : undefined,
        blockedTerms: s.blockedTerms,
      },
    };
  },

  async setBlockedTerms(req, ctx) {
    caller(ctx);
    const terms = [
      ...new Set(req.terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
    ]
      .filter((t) => t.length <= 50)
      .slice(0, MAX_BLOCKED_TERMS);
    const key = blockedKey(req.channelId);
    const tx = redis.multi().del(key);
    if (terms.length) tx.sadd(key, ...terms);
    await tx.exec();
    return {};
  },
};
