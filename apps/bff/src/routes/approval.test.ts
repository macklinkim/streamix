import Fastify from "fastify";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  login: vi.fn(),
  upsertOauthUser: vi.fn(),
}));

vi.mock("../clients.js", () => ({
  coreAuth: { login: mocks.login, upsertOauthUser: mocks.upsertOauthUser },
}));
vi.mock("../rate-limit.js", () => ({ overLimitAuth: vi.fn(async () => false) }));
vi.mock("../audit.js", () => ({ audit: vi.fn(), emailFingerprint: vi.fn(() => "fingerprint") }));
vi.mock("../session.js", () => ({ createSession: mocks.createSession }));
vi.mock("../token.js", () => ({ mintAccess: vi.fn() }));
vi.mock("../auth.js", () => ({ bearer: vi.fn(), verifyAccessToken: vi.fn() }));
vi.mock("../cookies.js", () => ({
  refreshCookie: vi.fn(() => "sx_rt=session"),
  clearCookie: vi.fn(),
  readRefreshCookie: vi.fn(),
}));
vi.mock("../env.js", () => ({
  env: {
    RATE_LIMIT_AUTH_MAX: 10,
    RATE_LIMIT_AUTH_WINDOW: 60,
    TWITCH_CLIENT_ID: "client",
    TWITCH_CLIENT_SECRET: "secret",
    TWITCH_REDIRECT_URI: "http://localhost/auth/twitch/callback",
    WEB_URL: "http://localhost:3000",
    COOKIE_SECURE: false,
  },
}));

import { authRoutes } from "./auth.js";
import { twitchRoutes } from "./twitch.js";

describe("pending accounts", () => {
  it("returns a distinct 403 without creating a password session", async () => {
    mocks.login.mockRejectedValueOnce(new ConnectError("approval pending", Code.PermissionDenied));
    const app = Fastify();
    await app.register(authRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "pending@example.com", password: "correct horse battery" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "approval pending" });
    expect(mocks.createSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not issue a Twitch session before approval", async () => {
    mocks.createSession.mockClear();
    mocks.upsertOauthUser.mockResolvedValueOnce({ user: { id: "pending-user", approved: false } });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "twitch-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "123", login: "new", display_name: "New" }] }), {
          status: 200,
        }),
      );
    const app = Fastify();
    await app.register(twitchRoutes);
    const start = await app.inject({ method: "GET", url: "/auth/twitch" });
    const state = new URL(start.headers.location!).searchParams.get("state")!;
    const response = await app.inject({
      method: "GET",
      url: `/auth/twitch/callback?code=test&state=${state}`,
      headers: { cookie: `sx_oauth_state=${state}` },
    });
    expect(response.headers.location).toBe("http://localhost:3000/?oauth=pending");
    expect(mocks.createSession).not.toHaveBeenCalled();
    fetchMock.mockRestore();
    await app.close();
  });
});

describe("Twitch login persistence", () => {
  it.each([false, true])(
    "uses the automatic-login choice from OAuth state: %s",
    async (rememberMe) => {
      mocks.createSession.mockClear();
      mocks.createSession.mockResolvedValueOnce({ sid: "session", family: "family" });
      mocks.upsertOauthUser.mockResolvedValueOnce({
        user: { id: "approved-user", approved: true },
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "twitch-token" }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: [{ id: "123", login: "existing", display_name: "Existing" }] }),
            { status: 200 },
          ),
        );
      const app = Fastify();
      await app.register(twitchRoutes);
      const start = await app.inject({
        method: "GET",
        url: `/auth/twitch?rememberMe=${rememberMe ? "1" : "0"}`,
      });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const response = await app.inject({
        method: "GET",
        url: `/auth/twitch/callback?code=test&state=${state}`,
        headers: { cookie: `sx_oauth_state=${state}` },
      });
      expect(response.headers.location).toBe("http://localhost:3000");
      expect(mocks.createSession).toHaveBeenCalledWith("approved-user", rememberMe);
      fetchMock.mockRestore();
      await app.close();
    },
  );
});
