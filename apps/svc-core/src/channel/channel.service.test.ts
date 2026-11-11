import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  claim: "" as string,
  insertFails: true,
  value: null as string | null,
}));

vi.mock("../deps.js", () => ({
  redis: {
    get: vi.fn(async () => "channel-1"),
    set: vi.fn(async (_key: string, value: string, _ex: string, _ttl: number, nx: string) => {
      if (nx === "NX" && state.value) return null;
      state.value = value;
      state.claim = value;
      return "OK";
    }),
    del: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, _count: number, _key: string, claim: string) => {
      if (state.value === claim) state.value = null;
      return 1;
    }),
  },
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => {
          if (state.insertFails) throw new Error("insert failed");
          return [{ id: "stream-1" }];
        }),
      })),
    })),
  },
}));
vi.mock("../env.js", () => ({ env: { LIVE_TTL_SECONDS: 90 } }));

import { channelService } from "./channel.service.js";

const start = () => channelService.startStream({ streamKey: "bit_test" } as never, {} as never);

beforeEach(() => {
  state.claim = "";
  state.insertFails = true;
  state.value = null;
});

describe("startStream failed claim cleanup", () => {
  it("releases its claim after DB failure so a retry can start", async () => {
    await expect(start()).rejects.toThrow("insert failed");
    expect(state.value).toBeNull();
    state.insertFails = false;
    await expect(start()).resolves.toEqual({ channelId: "channel-1", streamId: "stream-1" });
    expect(state.value).toBeTruthy();
  });

  it("does not remove a newer claim that replaced its own", async () => {
    const { db } = await import("../deps.js");
    vi.mocked(db.insert).mockImplementationOnce(
      () =>
        ({
          values: () => ({
            returning: async () => {
              state.value = "new-owner";
              throw new Error("insert failed");
            },
          }),
        }) as never,
    );
    await expect(start()).rejects.toThrow("insert failed");
    expect(state.value).toBe("new-owner");
  });
});
