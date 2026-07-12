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
await app.register(fastifyConnectPlugin, {
  interceptors: [rateLimitInterceptor],
  routes(router) {
    router.service(AuthService, authProxy);
    router.service(ChannelService, channelProxy);
  },
});

app.get("/health", async () => ({ status: "ok", service: "bff" }));

// Basic Prometheus metrics (MVP; full Grafana/Loki/OTel deferred, §1.2/§10).
collectDefaultMetrics();
app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", register.contentType);
  return register.metrics();
});

app.get("/ws", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  void handleChatWs(socket, url);
});

try {
  const address = await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`bff (connect + ws) listening on ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
