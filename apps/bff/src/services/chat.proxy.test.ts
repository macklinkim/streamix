import { beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { ChatRole, ModerationAction } from "@streamix/proto";

vi.mock("./auth.proxy.js", () => ({ requireUser: vi.fn(async () => "owner") }));
vi.mock("../clients.js", () => ({
  coreChannel: { getChatRole: vi.fn() },
  chat: { moderate: vi.fn(async () => ({})), setBlockedTerms: vi.fn(async () => ({})) },
}));

import { requireUser } from "./auth.proxy.js";
import { coreChannel, chat } from "../clients.js";
import { chatProxy } from "./chat.proxy.js";

const channelId = "00000000-0000-4000-8000-000000000001";
const viewerId = "00000000-0000-4000-8000-000000000002";
const modId = "00000000-0000-4000-8000-000000000003";
const otherModId = "00000000-0000-4000-8000-000000000004";
const ownerId = "00000000-0000-4000-8000-000000000005";
const messageId = "00000000-0000-4000-8000-000000000009";
const roles: Record<string, ChatRole> = {
  [ownerId]: ChatRole.BROADCASTER,
  [modId]: ChatRole.MODERATOR,
  [otherModId]: ChatRole.MODERATOR,
};
const request = (over: Record<string, unknown> = {}) => ({
  channelId,
  targetUserId: viewerId,
  action: ModerationAction.BAN,
  durationSeconds: 600,
  messageId: "",
  ...over,
});
const context = {} as never;
const as = (userId: string) => vi.mocked(requireUser).mockResolvedValue(userId);

beforeEach(() => {
  vi.clearAllMocks();
  as(ownerId);
  vi.mocked(coreChannel.getChatRole).mockImplementation(
    async (req: { userId: string }) => ({ role: roles[req.userId] ?? ChatRole.VIEWER }) as never,
  );
});

describe("chat moderation authorization", () => {
  it.each([ModerationAction.BAN, ModerationAction.UNBAN, ModerationAction.SLOWMODE])(
    "broadcaster action %s is forwarded with the verified identity",
    async (action) => {
      await chatProxy.moderate(request({ action }) as never, context);
      expect(chat.moderate).toHaveBeenCalledWith(expect.objectContaining({ channelId, action }), {
        headers: { "x-user-id": ownerId },
      });
    },
  );

  it("a moderator can time out a viewer", async () => {
    as(modId);
    await chatProxy.moderate(request() as never, context);
    expect(chat.moderate).toHaveBeenCalledTimes(1);
  });

  it("a viewer cannot moderate", async () => {
    as(viewerId);
    await expect(
      chatProxy.moderate(request({ targetUserId: modId }) as never, context),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(chat.moderate).not.toHaveBeenCalled();
  });

  it("nobody can target the broadcaster", async () => {
    as(modId);
    await expect(
      chatProxy.moderate(request({ targetUserId: ownerId }) as never, context),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(chat.moderate).not.toHaveBeenCalled();
  });

  it("only the broadcaster can target a moderator", async () => {
    as(modId);
    await expect(
      chatProxy.moderate(request({ targetUserId: otherModId }) as never, context),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    as(ownerId);
    await chatProxy.moderate(request({ targetUserId: otherModId }) as never, context);
    expect(chat.moderate).toHaveBeenCalledTimes(1);
  });

  it("a moderator can delete and pin messages", async () => {
    as(modId);
    for (const action of [ModerationAction.DELETE_MESSAGE, ModerationAction.PIN]) {
      await chatProxy.moderate(request({ action, targetUserId: "", messageId }) as never, context);
    }
    expect(chat.moderate).toHaveBeenCalledTimes(2);
  });

  it("rejects an unauthenticated caller before any role lookup", async () => {
    vi.mocked(requireUser).mockRejectedValue(
      new ConnectError("login required", Code.Unauthenticated),
    );
    await expect(chatProxy.moderate(request() as never, context)).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    expect(coreChannel.getChatRole).not.toHaveBeenCalled();
    expect(chat.moderate).not.toHaveBeenCalled();
  });

  it.each([
    { action: ModerationAction.UNSPECIFIED },
    { targetUserId: "invalid" },
    { durationSeconds: -1 },
    { durationSeconds: 86401 },
    { channelId: "invalid" },
    { action: ModerationAction.DELETE_MESSAGE, messageId: "" },
    { action: ModerationAction.PIN, messageId: "not-a-uuid" },
  ])("rejects invalid input %o", async (input) => {
    await expect(chatProxy.moderate(request(input) as never, context)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(chat.moderate).not.toHaveBeenCalled();
  });

  it("rejects self moderation", async () => {
    as(modId);
    await expect(
      chatProxy.moderate(request({ targetUserId: modId }) as never, context),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(chat.moderate).not.toHaveBeenCalled();
  });

  it("blocked terms need a moderator", async () => {
    as(viewerId);
    await expect(
      chatProxy.setBlockedTerms({ channelId, terms: ["spam"] } as never, context),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    as(modId);
    await chatProxy.setBlockedTerms({ channelId, terms: ["spam"] } as never, context);
    expect(chat.setBlockedTerms).toHaveBeenCalledTimes(1);
  });

  it("keeps send, join and room state on the WebSocket transport", async () => {
    await expect(chatProxy.send({} as never, context)).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    await expect(chatProxy.getRoomState({} as never, context)).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    expect(() => chatProxy.join()).toThrow("use WebSocket chat");
  });
});
