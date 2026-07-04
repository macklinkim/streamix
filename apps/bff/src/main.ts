import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { collectDefaultMetrics, register } from "prom-client";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { AuthService, ChannelService } from "@streamix/proto";
import { authProxy } from "./services/auth.proxy.js";
import { channelProxy } from "./services/channel.proxy.js";
import { handleChatWs } from "./ws/chat.js";
import { rateLimitInterceptor } from "./rate-limit.js";
import { env, corsOrigins } from "./env.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: corsOrigins,
  credentials: true,
});
await app.register(websocket);
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
