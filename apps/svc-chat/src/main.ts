import { createServer } from "node:http2";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ChatService } from "@streamix/proto";
import { INTERNAL_TOKEN_HEADER, internalTokenValid } from "@streamix/schemas/internal-auth";
import { chatService } from "./chat.service.js";
import { env } from "./env.js";

// Internal-boundary auth (inbox/review.md P2-1). Enforced only in production.
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
  router.service(ChatService, chatService);
}

const server = createServer(connectNodeAdapter({ routes, interceptors: [internalAuth] }));

server.listen(env.PORT, () => {
  console.log(`svc-chat (connect h2c) listening on :${env.PORT}`);
});
