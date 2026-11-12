import { beforeEach, describe, expect, it, vi } from "vitest";
import { Code } from "@connectrpc/connect";

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserted: null as Record<string, unknown> | null,
}));

vi.mock("../deps.js", () => {
  const select = () => {
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: async () => state.rows.shift() ?? [],
    };
    return query;
  };
  return {
    db: {
      select,
      insert: () => ({
        values: (input: Record<string, unknown>) => ({
          returning: async () => {
            state.inserted = input;
            return [
              { id: "new-user", ...input, approvedAt: null, isAdmin: false, createdAt: new Date() },
            ];
          },
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: "pending-user" }] }) }),
      }),
    },
  };
});
vi.mock("./password.js", () => ({
  hashPassword: vi.fn(async () => "hashed"),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock("./jwt.js", () => ({
  signAccess: vi.fn(async () => "access"),
  signRefresh: vi.fn(async () => "refresh"),
  verifyRefresh: vi.fn(async () => "pending-user"),
}));

import { authService } from "./auth.service.js";

const context = { requestHeader: new Headers({ "x-user-id": "admin-user" }) } as never;
const pendingId = "00000000-0000-4000-8000-000000000001";
const user = (approved: boolean) => ({
  id: pendingId,
  email: "person@example.com",
  displayName: "Person",
  passwordHash: "hashed",
  approvedAt: approved ? new Date() : null,
  isAdmin: false,
  createdAt: new Date(),
});

beforeEach(() => {
  state.rows = [];
  state.inserted = null;
});

describe("registration approval", () => {
  it("registers a new user without approval or admin rights", async () => {
    const result = await authService.register(
      {
        email: "person@example.com",
        password: "Example!42",
        displayName: "Person",
      } as never,
      context,
    );
    expect(state.inserted).not.toHaveProperty("approvedAt");
    expect(state.inserted).not.toHaveProperty("isAdmin");
    expect(result.user?.approved).toBe(false);
    expect(result.user?.isAdmin).toBe(false);
  });

  it("rejects a pending user after valid password verification", async () => {
    state.rows.push([user(false)]);
    await expect(
      authService.login({ email: "person@example.com", password: "Example!42" } as never, context),
    ).rejects.toMatchObject({ code: Code.PermissionDenied, rawMessage: "approval pending" });
  });

  it("allows approved users to log in", async () => {
    state.rows.push([user(true)]);
    await expect(
      authService.login({ email: "person@example.com", password: "Example!42" } as never, context),
    ).resolves.toMatchObject({ accessToken: "access" });
  });

  it("blocks pending users from refreshing old credentials", async () => {
    state.rows.push([{ approvedAt: null }]);
    await expect(
      authService.refresh({ refreshToken: "old" } as never, context),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it("denies pending-list access to non-admin users", async () => {
    state.rows.push([{ isAdmin: false }]);
    await expect(authService.listPendingUsers({}, context)).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    state.rows.push([{ isAdmin: false }]);
    await expect(
      authService.approveUser({ userId: pendingId } as never, context),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it("lets an admin list and approve pending users", async () => {
    state.rows.push([{ isAdmin: true }], [user(false)]);
    const result = await authService.listPendingUsers({}, context);
    expect(result.users).toHaveLength(1);
    state.rows.push([{ isAdmin: true }]);
    await expect(authService.approveUser({ userId: pendingId } as never, context)).resolves.toEqual(
      {},
    );
  });
});
