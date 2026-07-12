import { createServer } from "node:http2";
import type { ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { AuthService, ChannelService } from "@streamix/proto";
import { authService, ensureAuthReady } from "./auth/auth.service.js";
import { channelService } from "./channel/channel.service.js";
import { env } from "./env.js";

function routes(router: ConnectRouter) {
  router.service(AuthService, authService);
  router.service(ChannelService, channelService);
}

// Argon2 warm-up (timing-equalizer hash) must succeed before serving (V7-5).
try {
  await ensureAuthReady();
} catch (e) {
  console.error("[svc-core] fatal: argon2 init failed", e);
  process.exit(1);
}

// h2c (plaintext HTTP/2) is fine on the internal network; gRPC-wire compatible.
const server = createServer(connectNodeAdapter({ routes }));

server.listen(env.PORT, () => {
  console.log(`svc-core (connect h2c) listening on :${env.PORT}`);
});
