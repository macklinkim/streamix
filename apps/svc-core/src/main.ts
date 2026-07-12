import { createServer } from "node:http2";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { AuthService, ChannelService } from "@streamix/proto";
import { INTERNAL_TOKEN_HEADER, internalTokenValid } from "@streamix/schemas/internal-auth";
import { authService, ensureAuthReady } from "./auth/auth.service.js";
import { channelService } from "./channel/channel.service.js";
import { env } from "./env.js";

// Internal-boundary auth (inbox/review.md P2-1): every caller (BFF, svc-media)
// must present the shared token. Enforced only in production so local smoke
// scripts and dev tooling keep working with the shared dev default.
const requireInternalToken = process.env.NODE_ENV === "production";
const internalAuth: Interceptor = (next) => (req) => {
  if (
    requireInternalToken &&
    !internalTokenValid(req.header.get(INTERNAL_TOKEN_HEADER), env.INTERNAL_TOKEN)
  )
    throw new ConnectError("internal authentication required", Code.Unauthenticated);
  return next(req);
};

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
const server = createServer(connectNodeAdapter({ routes, interceptors: [internalAuth] }));

server.listen(env.PORT, () => {
  console.log(`svc-core (connect h2c) listening on :${env.PORT}`);
});
