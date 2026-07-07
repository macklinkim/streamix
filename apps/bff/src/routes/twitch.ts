import type { FastifyInstance } from "fastify";
import { coreAuth } from "../clients.js";
import { createSession } from "../session.js";
import { refreshCookie } from "../cookies.js";
import { env } from "../env.js";

// Twitch OAuth2 authorization-code flow. The BFF is the confidential client:
// it holds the secret, exchanges the code server-side, upserts the user via
// svc-core, then hands the browser the same rotating-refresh cookie every other
// login uses (so AuthHydrator silently mints an access token on return).

const STATE_COOKIE = "sx_oauth_state";
const AUTHORIZE = "https://id.twitch.tv/oauth2/authorize";
const TOKEN = "https://id.twitch.tv/oauth2/token";
const USERS = "https://api.twitch.tv/helix/users";

function stateCookie(value: string, maxAge: number): string {
  const parts = [
    `${STATE_COOKIE}=${value}`,
    "Path=/auth/twitch",
    "HttpOnly",
    "SameSite=Lax", // sent on Twitch's top-level redirect back to the callback
    `Max-Age=${maxAge}`,
  ];
  if (env.COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function readState(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === STATE_COOKIE) return v.join("=") || null;
  }
  return null;
}

export async function twitchRoutes(app: FastifyInstance): Promise<void> {
  const configured = Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);

  app.get("/auth/twitch", async (_req, reply) => {
    if (!configured) return reply.code(503).send({ error: "twitch login not configured" });
    const state = crypto.randomUUID();
    reply.header("set-cookie", stateCookie(state, 600));
    const url =
      `${AUTHORIZE}?client_id=${encodeURIComponent(env.TWITCH_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(env.TWITCH_REDIRECT_URI)}` +
      `&response_type=code&scope=${encodeURIComponent("user:read:email")}` +
      `&state=${state}`;
    return reply.redirect(url);
  });

  app.get("/auth/twitch/callback", async (req, reply) => {
    if (!configured) return reply.code(503).send({ error: "twitch login not configured" });
    const q = req.query as { code?: string; state?: string; error?: string };
    const expected = readState(req.headers.cookie);
    reply.header("set-cookie", stateCookie("", 0)); // clear state either way

    if (q.error || !q.code || !q.state || !expected || q.state !== expected) {
      return reply.redirect(`${env.WEB_URL}/?oauth=failed`);
    }

    try {
      // 1. code -> Twitch access token
      const tokenRes = await fetch(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.TWITCH_CLIENT_ID,
          client_secret: env.TWITCH_CLIENT_SECRET,
          code: q.code,
          grant_type: "authorization_code",
          redirect_uri: env.TWITCH_REDIRECT_URI,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) throw new Error("no access_token");

      // 2. fetch the Twitch user
      const userRes = await fetch(USERS, {
        headers: { authorization: `Bearer ${access_token}`, "client-id": env.TWITCH_CLIENT_ID },
      });
      if (!userRes.ok) throw new Error(`users ${userRes.status}`);
      const data = (await userRes.json()) as {
        data?: { id: string; login: string; display_name: string; email?: string }[];
      };
      const tw = data.data?.[0];
      if (!tw) throw new Error("no twitch user");

      // 3. upsert in svc-core + issue our own session
      const { user } = await coreAuth.upsertOauthUser({
        providerId: `twitch:${tw.id}`,
        email: tw.email ?? "",
        displayName: tw.display_name || tw.login,
      });
      // The refresh session is the credential; the browser mints an access token
      // via the silent /auth/refresh right after it lands back on the web app.
      const sid = await createSession(user!.id);
      if (sid) reply.header("set-cookie", refreshCookie(sid));
      return reply.redirect(env.WEB_URL);
    } catch {
      return reply.redirect(`${env.WEB_URL}/?oauth=failed`);
    }
  });
}
