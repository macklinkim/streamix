import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { collectDefaultMetrics, register } from "prom-client";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { AuthService, ChannelService } from "@streamix/proto";
import { authProxy } from "./services/auth.proxy.js";
import { channelProxy } from "./services/channel.proxy.js";
import { authRoutes } from "./routes/auth.js";
import { twitchRoutes } from "./routes/twitch.js";
import { cspRoutes } from "./routes/csp.js";
import { handleChatWs } from "./ws/chat.js";
import { rateLimitInterceptor } from "./rate-limit.js";
import { env, corsOrigins } from "./env.js";

const app = Fastify({
  // Trust exactly one proxy hop (Fly's edge proxy) so req.ip is the address
  // Fly appended, not an attacker-controlled x-forwarded-for value that would
  // let rate limits be dodged (inbox/review.md P1-5).
  trustProxy: 1,
  logger: {
    // Credentials must never land in request logs (inbox/review.md P1-3):
    // Authorization bearer tokens, refresh cookies, and set-cookie values.
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
      censor: "[redacted]",
    },
  },
});

await app.register(cors, {
  origin: corsOrigins,
  credentials: true,
});
await app.register(websocket);
await app.register(authRoutes);
await app.register(twitchRoutes);
await app.register(cspRoutes);
await app.register(fastifyConnectPlugin, {
  interceptors: [rateLimitInterceptor],
  routes(router) {
    router.service(AuthService, authProxy);
    router.service(ChannelService, channelProxy);
  },
});

app.get("/health", async () => ({ status: "ok", service: "bff" }));

// Basic Prometheus metrics (MVP; full Grafana/Loki/OTel deferred, §1.2/§10).
// Not exposed unauthenticated on the public BFF (inbox/review.md P2-3): when
// METRICS_TOKEN is set the scraper must present it; without one, the endpoint
// only exists outside production (local dev convenience).
collectDefaultMetrics();
app.get("/metrics", async (req, reply) => {
  if (env.METRICS_TOKEN) {
    if (req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
      return reply.code(401).send();
    }
  } else if (process.env.NODE_ENV === "production") {
    return reply.code(404).send();
  }
  reply.header("Content-Type", register.contentType);
  return register.metrics();
});

app.get(
  "/ws",
  {
    websocket: true,
    // Origin gate runs BEFORE the WebSocket upgrade (inbox/review.md V4-2):
    // a hostile cross-origin flood is refused with a plain 403 and never costs
    // a socket. Non-browser callers (smoke scripts) send no Origin and still
    // need a valid token inside handleChatWs.
    preValidation: async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && !corsOrigins.includes(origin)) {
        await reply.code(403).send({ error: "origin not allowed" });
      }
    },
  },
  (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    void handleChatWs(socket, url);
  },
);

try {
  const address = await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`bff (connect + ws) listening on ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
