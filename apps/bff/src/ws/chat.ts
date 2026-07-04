import type { WebSocket } from "ws";
import { Redis } from "ioredis";
import { ConnectError } from "@connectrpc/connect";
import { WsCloseCode } from "@streamix/schemas";
import { env } from "../env.js";
import { chat, coreAuth } from "../clients.js";
import { verifyAccessToken } from "../auth.js";

const redis = new Redis(env.REDIS_URL);
const chatChannel = (id: string) => `chat:${id}`;
const viewersKey = (id: string) => `viewers:${id}`;

// One Redis subscription per room per BFF instance (ADR-4 refcount), shared by
// all sockets watching that room. Publish path is svc-chat.
type Room = { sub: Redis; sockets: Set<WebSocket> };
const rooms = new Map<string, Room>();

async function joinRoom(channelId: string, socket: WebSocket): Promise<void> {
  let room = rooms.get(channelId);
  if (!room) {
    const created: Room = { sub: new Redis(env.REDIS_URL), sockets: new Set() };
    rooms.set(channelId, created);
    created.sub.on("message", (_ch, payload) => {
      for (const s of created.sockets) if (s.readyState === 1) s.send(payload);
    });
    await created.sub.subscribe(chatChannel(channelId));
    room = created;
  }
  room.sockets.add(socket);
  await redis.incr(viewersKey(channelId));
}

async function leaveRoom(channelId: string, socket: WebSocket): Promise<void> {
  const room = rooms.get(channelId);
  if (!room) return;
  room.sockets.delete(socket);
  await redis.decr(viewersKey(channelId));
  if (room.sockets.size === 0) {
    await room.sub.unsubscribe().catch(() => {});
    room.sub.disconnect();
    rooms.delete(channelId);
  }
}

export async function handleChatWs(socket: WebSocket, url: URL): Promise<void> {
  const channelId = url.searchParams.get("channelId");
  if (!channelId) return socket.close(WsCloseCode.PROTOCOL_ERROR, "channelId required");

  const userId = await verifyAccessToken(url.searchParams.get("token"));
  if (!userId) return socket.close(WsCloseCode.UNAUTHENTICATED, "authentication required");

  let displayName = "익명";
  try {
    const me = await coreAuth.me({}, { headers: { "x-user-id": userId } });
    displayName = me.user?.displayName ?? "익명";
  } catch {
    /* fall back to default display name */
  }

  await joinRoom(channelId, socket);
  socket.on("close", () => void leaveRoom(channelId, socket));

  socket.on("message", async (data: Buffer) => {
    let text: string;
    try {
      const msg = JSON.parse(data.toString());
      if (msg?.type !== "send" || typeof msg.text !== "string") return;
      text = msg.text;
    } catch {
      return;
    }
    try {
      await chat.send(
        { channelId, text },
        { headers: { "x-user-id": userId, "x-display-name": encodeURIComponent(displayName) } },
      );
    } catch (e) {
      const code = e instanceof ConnectError ? e.code : "internal";
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: "error", code: String(code) }));
    }
  });
}
