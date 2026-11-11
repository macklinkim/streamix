import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  me: vi.fn(async () => ({ user: { displayName: "viewer" } })),
  subscribers: [] as EventEmitter[],
  subscribe: vi.fn(async () => 1),
  unsubscribe: vi.fn(async () => 1),
}));

vi.mock("../auth.js", () => ({ verifyAccessToken: vi.fn(async () => "user-1") }));
vi.mock("../clients.js", () => ({
  chat: { send: vi.fn(), getRoomState: vi.fn(async () => ({})) },
  coreAuth: { me: mocks.me },
  coreChannel: {
    channelExists: vi.fn(async () => ({ exists: true })),
    getChatRole: vi.fn(async () => ({ role: 1, following: false })), // ChatRole.VIEWER
  },
}));
vi.mock("../redis.js", () => ({
  createSubscriber: () => {
    const sub = Object.assign(new EventEmitter(), {
      subscribe: mocks.subscribe,
      unsubscribe: mocks.unsubscribe,
      disconnect: vi.fn(),
    });
    mocks.subscribers.push(sub);
    return sub;
  },
}));

import { handleChatWs } from "./chat.js";

// The join handshake frame (carries the caller role since benchmark M3).
const READY = JSON.stringify({ type: "ready", role: "viewer" });
const isReady = (frame: string) => JSON.parse(frame).type === "ready";

class Socket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
  ping() {}
}

let channel = 0;
function connect() {
  const socket = new Socket();
  const id = `00000000-0000-0000-0000-${String(++channel).padStart(12, "0")}`;
  const task = handleChatWs(
    socket as unknown as WebSocket,
    new URL(`ws://localhost/chat?channelId=${id}`),
  );
  socket.emit("message", Buffer.from('{"type":"auth","token":"valid"}'));
  return { socket, task, id };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribers.length = 0;
});

describe("chat room lifecycle", () => {
  it("does not join a socket closed while loading user details", async () => {
    const me = deferred<{ user: { displayName: string } }>();
    mocks.me.mockImplementationOnce(() => me.promise);
    const { socket, task } = connect();
    await vi.waitFor(() => expect(mocks.me).toHaveBeenCalled());
    socket.close();
    me.resolve({ user: { displayName: "viewer" } });
    await task;
    expect(mocks.subscribers).toHaveLength(0);
    expect(socket.sent.some(isReady)).toBe(false);
  });

  it("cleans a socket closed during Redis subscribe", async () => {
    const subscribed = deferred<number>();
    mocks.subscribe.mockImplementationOnce(() => subscribed.promise);
    const { socket, task } = connect();
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalled());
    socket.close();
    subscribed.resolve(1);
    await task;
    expect(socket.sent.some(isReady)).toBe(false);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a new room subscribed while old unsubscribe is pending", async () => {
    const old = connect();
    await old.task;
    const unsubscribed = deferred<number>();
    mocks.unsubscribe.mockImplementationOnce(() => unsubscribed.promise);
    old.socket.close();
    await vi.waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalled());
    const next = new Socket();
    const task = handleChatWs(
      next as unknown as WebSocket,
      new URL(`ws://localhost/chat?channelId=${old.id}`),
    );
    next.emit("message", Buffer.from('{"type":"auth","token":"valid"}'));
    await task;
    expect(mocks.subscribers).toHaveLength(2);
    expect(next.sent).toContain(READY);
    mocks.subscribers[1]!.emit("message", "chat", '{"type":"chat"}');
    expect(next.sent).toContain('{"type":"chat"}');
    unsubscribed.resolve(1);
    next.close();
  });

  it("does not send ready to concurrent joins when subscribe fails", async () => {
    const subscribed = deferred<number>();
    mocks.subscribe.mockImplementationOnce(() => subscribed.promise);
    const first = connect();
    const second = new Socket();
    const task = handleChatWs(
      second as unknown as WebSocket,
      new URL(`ws://localhost/chat?channelId=${first.id}`),
    );
    second.emit("message", Buffer.from('{"type":"auth","token":"valid"}'));
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
    subscribed.reject(new Error("Redis down"));
    await Promise.all([first.task, task]);
    expect(first.socket.sent.some(isReady)).toBe(false);
    expect(second.sent.some(isReady)).toBe(false);
  });
});
