import type { WebSocket } from "ws";
import type { Redis } from "ioredis";
import { ConnectError } from "@connectrpc/connect";
import { WsCloseCode } from "@streamix/schemas";
import { redis, createSubscriber } from "../redis.js";
import { chat, coreAuth, coreChannel } from "../clients.js";
import { verifyAccessToken } from "../auth.js";

// Per-connection flood guard (§8 Phase 2). Independent of channel slowmode.
const SEND_BURST = 5;
const SEND_WINDOW_MS = 3000;

// Connection resource guards (inbox/review.md P2-2): a valid token must not be
// enough to exhaust sockets / Redis subscriptions / room maps.
const MAX_SOCKETS_PER_USER = 10;
const MAX_TOTAL_SOCKETS = 2000; // per BFF instance, incl. sockets awaiting auth (V4-3)
const MAX_ROOMS = 500; // per BFF instance; join-existing stays allowed at the cap (V4-1)
const ROOM_CREATES_PER_MIN = 5; // per user; separate from the socket ceiling (V4-1)
const HEARTBEAT_MS = 30_000; // ping interval; a socket missing one pong is dead
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const userSocketCounts = new Map<string, number>();
let totalSockets = 0;

// Channel-existence cache (V4-1/V7-6): a room is only created for channel ids
// core confirms exist. Positive AND negative results are cached briefly so a
// hot room doesn't hammer core and a random-UUID flood doesn't either.
const EXISTS_TTL_MS = 60_000;
const NOT_EXISTS_TTL_MS = 30_000;
const existsCache = new Map<string, { exists: boolean; until: number }>();

async function channelExists(channelId: string): Promise<boolean> {
  const now = Date.now();
  const hit = existsCache.get(channelId);
  if (hit && now < hit.until) return hit.exists;
  if (existsCache.size > 10_000) existsCache.clear(); // bound memory
  try {
    const res = await coreChannel.channelExists({ channelId });
    existsCache.set(channelId, {
      exists: res.exists,
      until: now + (res.exists ? EXISTS_TTL_MS : NOT_EXISTS_TTL_MS),
    });
    return res.exists;
  } catch {
    // Core outage: fail open for JOIN only (room caps still bound resources);
    // chat.Send would fail anyway. Availability-first degradation (§10).
    return true;
  }
}

// Per-user new-room creation window (V4-1): bounds random-UUID room churn on
// top of the existence check (covers the core-outage fail-open above).
const roomCreateWindows = new Map<string, { count: number; resetAt: number }>();
function roomCreateAllowed(userId: string): boolean {
  const now = Date.now();
  const w = roomCreateWindows.get(userId);
  if (!w || now >= w.resetAt) {
    if (roomCreateWindows.size > 10_000) roomCreateWindows.clear(); // bound memory
    roomCreateWindows.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  w.count += 1;
  return w.count <= ROOM_CREATES_PER_MIN;
}

// Fan-out backpressure + micro-batching (M4, ADR-11). Chat favors recency over
// completeness: a socket whose kernel/app buffer is backed up past the limit is
// skipped (message dropped) rather than blocking the room; the connection stays.
const BUFFERED_LIMIT = 1 << 20; // 1MB per-socket bufferedAmount ceiling
const BATCH_WINDOW_MS = 50; // coalescing window for bursty inbound
const DROP_LOG_INTERVAL_MS = 60_000;

const chatChannel = (id: string) => `chat:${id}`;
const viewersKey = (id: string) => `viewers:${id}`;

// One Redis subscription per room per BFF instance (ADR-4 refcount), shared by
// all sockets watching that room. Publish path is svc-chat.
// queue/timer implement per-room micro-batching; drops counts backpressure skips.
type Room = {
  sub: Redis;
  sockets: Set<WebSocket>;
  queue: string[];
  timer: ReturnType<typeof setTimeout> | null;
  drops: number;
};
const rooms = new Map<string, Room>();

// Fan-out one frame to every live socket, skipping backed-up ones (drop = recency).
function fanout(room: Room, frame: string): void {
  for (const s of room.sockets) {
    if (s.readyState !== 1) continue;
    if (s.bufferedAmount > BUFFERED_LIMIT) {
      room.drops++;
      continue;
    }
    s.send(frame);
  }
}

// Flush the room queue: single message keeps the legacy wire form (back-compat);
// 2+ coalesce into {type:"batch", items:[...]}. Clears any pending timer.
function flush(room: Room): void {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  const batch = room.queue;
  if (batch.length === 0) return;
  room.queue = [];
  const frame =
    batch.length === 1
      ? batch[0]!
      : JSON.stringify({ type: "batch", items: batch.map((p) => JSON.parse(p)) });
  fanout(room, frame);
}

// (a) An isolated message (queue length 1, no window open) flushes immediately —
// zero added latency under low load. (b) Anything arriving during the open 50ms
// window coalesces and ships as one batch when the timer fires.
function enqueue(room: Room, payload: string): void {
  room.queue.push(payload);
  if (room.queue.length === 1 && room.timer === null) {
    flush(room);
    room.timer = setTimeout(() => flush(room), BATCH_WINDOW_MS);
  }
}

// Single shared reporter: log rooms that dropped in the last window, then reset.
setInterval(() => {
  for (const [id, room] of rooms) {
    if (room.drops > 0) {
      console.warn(`[chat] room=${id} backpressure_drops=${room.drops} window=60s`);
      room.drops = 0;
    }
  }
}, DROP_LOG_INTERVAL_MS).unref();

async function joinRoom(channelId: string, socket: WebSocket): Promise<void> {
  let room = rooms.get(channelId);
  if (!room) {
    const created: Room = {
      sub: createSubscriber(),
      sockets: new Set(),
      queue: [],
      timer: null,
      drops: 0,
    };
    rooms.set(channelId, created);
    created.sub.on("message", (_ch, payload) => enqueue(created, payload));
    try {
      await created.sub.subscribe(chatChannel(channelId));
    } catch (e) {
      // Redis down: don't leave a broken room behind; caller marks unavailable.
      rooms.delete(channelId);
      created.sub.disconnect();
      throw e;
    }
    room = created;
  }
  room.sockets.add(socket);
  await redis.incr(viewersKey(channelId)).catch(() => {}); // viewer count is best-effort
}

async function leaveRoom(channelId: string, socket: WebSocket): Promise<void> {
  const room = rooms.get(channelId);
  if (!room) return;
  room.sockets.delete(socket);
  await redis.decr(viewersKey(channelId)).catch(() => {});
  if (room.sockets.size === 0) {
    if (room.timer) clearTimeout(room.timer);
    await room.sub.unsubscribe().catch(() => {});
    room.sub.disconnect();
    rooms.delete(channelId);
  }
}

export async function handleChatWs(socket: WebSocket, url: URL): Promise<void> {
  const channelId = url.searchParams.get("channelId");
  if (!channelId) return socket.close(WsCloseCode.PROTOCOL_ERROR, "channelId required");
  // Channel ids are UUIDs; anything else would still allocate a room + Redis
  // subscription per arbitrary string (P2-2 resource abuse).
  if (!UUID_RE.test(channelId))
    return socket.close(WsCloseCode.PROTOCOL_ERROR, "invalid channelId");

  // Instance ceiling is claimed BEFORE token verification (V4-3): sockets
  // parked in the async JWT/Redis check would otherwise not count, letting a
  // flood of pending connections blow past the cap.
  if (totalSockets >= MAX_TOTAL_SOCKETS) return socket.close(4429, "server at capacity");
  totalSockets += 1;
  let counted = true;
  const releaseTotal = () => {
    if (counted) {
      counted = false;
      totalSockets -= 1;
    }
  };
  socket.once("close", releaseTotal);

  const userId = await verifyAccessToken(url.searchParams.get("token"));
  if (!userId) return socket.close(WsCloseCode.UNAUTHENTICATED, "authentication required");

  // Per-user socket ceiling (P2-2). Decrement is registered immediately so any
  // later rejection path (room caps below) can't leak the count.
  const userCount = userSocketCounts.get(userId) ?? 0;
  if (userCount >= MAX_SOCKETS_PER_USER) return socket.close(4429, "too many connections");
  userSocketCounts.set(userId, userCount + 1);
  socket.once("close", () => {
    const n = (userSocketCounts.get(userId) ?? 1) - 1;
    if (n <= 0) userSocketCounts.delete(userId);
    else userSocketCounts.set(userId, n);
  });

  // Room guards (V4-1): cap instance-wide room count for NEW rooms, bound
  // per-user room-creation rate, and require the channel to actually exist.
  if (!rooms.has(channelId)) {
    if (rooms.size >= MAX_ROOMS) return socket.close(4429, "room capacity");
    if (!roomCreateAllowed(userId)) return socket.close(4429, "room creation rate");
    if (!(await channelExists(channelId)))
      return socket.close(WsCloseCode.ROOM_NOT_FOUND, "channel not found");
  }

  // Idle reaping: ws core answers pings automatically, so a live client always
  // pongs; one missed round = dead connection holding a room slot.
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  socket.on("close", () => {
    clearInterval(heartbeat);
  });

  let displayName = "익명";
  try {
    const me = await coreAuth.me({}, { headers: { "x-user-id": userId } });
    displayName = me.user?.displayName ?? "익명";
  } catch {
    /* fall back to default display name */
  }

  try {
    await joinRoom(channelId, socket);
  } catch {
    // Chat depends on Redis pub/sub; on outage close cleanly (unavailable), no crash.
    return socket.close(WsCloseCode.SERVER_ERROR, "chat unavailable");
  }
  socket.on("close", () => void leaveRoom(channelId, socket));

  let sendTimes: number[] = [];
  socket.on("message", async (data: Buffer) => {
    let text: string;
    try {
      const msg = JSON.parse(data.toString());
      if (msg?.type !== "send" || typeof msg.text !== "string") return;
      text = msg.text;
    } catch {
      return;
    }

    const now = Date.now();
    sendTimes = sendTimes.filter((t) => now - t < SEND_WINDOW_MS);
    if (sendTimes.length >= SEND_BURST) {
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: "error", code: "rate_limited" }));
      return;
    }
    sendTimes.push(now);

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
