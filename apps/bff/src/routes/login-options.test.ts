import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  createSession: vi.fn(),
  rotateSession: vi.fn(),
  revokeSession: vi.fn(),
}));
vi.mock("../clients.js", () => ({ coreAuth: { login: mocks.login } }));
vi.mock("../rate-limit.js", () => ({ overLimitAuth: vi.fn(async () => false) }));
vi.mock("../audit.js", () => ({ audit: vi.fn(), emailFingerprint: vi.fn(() => "fingerprint") }));
vi.mock("../session.js", () => ({
  createSession: mocks.createSession,
  rotateSession: mocks.rotateSession,
  revokeSession: mocks.revokeSession,
  revokeUser: vi.fn(),
}));
vi.mock("../token.js", () => ({
  mintAccess: vi.fn(async () => ({ token: "access" })),
  denylistJti: vi.fn(),
}));
vi.mock("../auth.js", () => ({
  tokenMeta: vi.fn(async () => null),
  bearer: vi.fn(),
  verifyAccessToken: vi.fn(),
}));
import { authRoutes } from "./auth.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.login.mockResolvedValue({
    user: { id: "user", email: "user@example.com", displayName: "User", isAdmin: false },
  });
  mocks.createSession.mockResolvedValue({ sid: "session", family: "family" });
});

describe("login choices", () => {
  it.each([false, true, undefined])("respects rememberMe=%s on login", async (rememberMe) => {
    const app = Fastify();
    await app.register(authRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "user@example.com", password: "correct horse battery", rememberMe },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.createSession).toHaveBeenCalledWith("user", rememberMe === true);
    expect(String(response.headers["set-cookie"]).includes("Max-Age=")).toBe(rememberMe === true);
    await app.close();
  });

  it.each([false, true])("preserves rememberMe=%s when refreshing", async (rememberMe) => {
    mocks.rotateSession.mockResolvedValue({
      status: "ok",
      userId: "user",
      sid: "next",
      family: "family",
      rememberMe,
    });
    const app = Fastify();
    await app.register(authRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: "sx_rt=session", "x-sx-web": "1" },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers["set-cookie"]).includes("Max-Age=")).toBe(rememberMe);
    await app.close();
  });

  it("rejects string booleans instead of enabling automatic login", async () => {
    const app = Fastify();
    await app.register(authRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "user@example.com",
        password: "correct horse battery",
        rememberMe: "false",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("revokes and clears the session at logout", async () => {
    const app = Fastify();
    await app.register(authRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: "sx_rt=session", "x-sx-web": "1" },
    });
    expect(response.statusCode).toBe(204);
    expect(mocks.revokeSession).toHaveBeenCalledWith("session");
    expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
    await app.close();
  });
});
