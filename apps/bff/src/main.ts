import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { AuthService, ChannelService } from "@streamix/proto";
import { authProxy } from "./services/auth.proxy.js";
import { channelProxy } from "./services/channel.proxy.js";
import { handleChatWs } from "./ws/chat.js";
import { env, corsOrigins } from "./env.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: corsOrigins,
  credentials: true,
});
await app.register(websocket);
await app.register(fastifyConnectPlugin, {
  routes(router) {
    router.service(AuthService, authProxy);
    router.service(ChannelService, channelProxy);
  },
});

app.get("/health", async () => ({ status: "ok", service: "bff" }));

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
