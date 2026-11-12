import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { ChatRole, ChatService, ModerationAction } from "@streamix/proto";
import { z } from "zod";
import { chat, coreChannel } from "../clients.js";
import { requireUser } from "./auth.proxy.js";

const uuid = z.string().uuid();
const moderationSchema = z.object({
  channelId: uuid,
  targetUserId: z.string(),
  action: z
    .nativeEnum(ModerationAction)
    .refine((action) => action !== ModerationAction.UNSPECIFIED),
  durationSeconds: z.number().int().min(0).max(86400),
  // Optional at the edge; required (uuid) only for message actions below.
  messageId: z.string().optional(),
});
const blockedTermsSchema = z.object({
  channelId: uuid,
  terms: z.array(z.string().max(50)).max(100),
});
const TARGETS_USER = new Set([ModerationAction.BAN, ModerationAction.UNBAN]);
const TARGETS_MESSAGE = new Set([ModerationAction.DELETE_MESSAGE, ModerationAction.PIN]);

const deny = (why: string) => new ConnectError(why, Code.PermissionDenied);
const roleOf = async (channelId: string, userId: string) =>
  (await coreChannel.getChatRole({ channelId, userId })).role;
const isPrivileged = (role: ChatRole) =>
  role === ChatRole.BROADCASTER || role === ChatRole.MODERATOR;

// Broadcaster or a moderator of this channel (benchmark G-09); role comes from
// svc-core on every call, so a removed moderator loses access immediately.
async function requireModerator(ctx: Parameters<typeof requireUser>[0], channelId: string) {
  const userId = await requireUser(ctx);
  const role = await roleOf(channelId, userId);
  if (!isPrivileged(role)) throw deny("moderator required");
  return { userId, role };
}

export const chatProxy = {
  async moderate(req, ctx) {
    const parsed = moderationSchema.safeParse(req);
    const needsUser = TARGETS_USER.has(req.action);
    const needsMessage = TARGETS_MESSAGE.has(req.action);
    if (
      !parsed.success ||
      (needsUser && !uuid.safeParse(req.targetUserId).success) ||
      (needsMessage && !uuid.safeParse(req.messageId).success)
    )
      throw new ConnectError("invalid moderation request", Code.InvalidArgument);
    const { userId, role } = await requireModerator(ctx, req.channelId);
    if (needsUser) {
      if (req.targetUserId === userId)
        throw new ConnectError("cannot target yourself", Code.InvalidArgument);
      // Nobody moderates the broadcaster; only the broadcaster moderates moderators.
      const target = await roleOf(req.channelId, req.targetUserId);
      if (target === ChatRole.BROADCASTER) throw deny("cannot target the broadcaster");
      if (target === ChatRole.MODERATOR && role !== ChatRole.BROADCASTER)
        throw deny("only the broadcaster can moderate moderators");
    }
    return chat.moderate(req, { headers: { "x-user-id": userId } });
  },
  async setBlockedTerms(req, ctx) {
    if (!blockedTermsSchema.safeParse(req).success)
      throw new ConnectError("invalid blocked terms", Code.InvalidArgument);
    const { userId } = await requireModerator(ctx, req.channelId);
    return chat.setBlockedTerms(req, { headers: { "x-user-id": userId } });
  },
  // Served to browsers over the chat WebSocket (state frame), not as an RPC.
  async getRoomState() {
    throw new ConnectError("use WebSocket chat", Code.PermissionDenied);
  },
  async send() {
    throw new ConnectError("use WebSocket chat", Code.PermissionDenied);
  },
  join() {
    throw new ConnectError("use WebSocket chat", Code.PermissionDenied);
  },
} satisfies ServiceImpl<typeof ChatService>;
