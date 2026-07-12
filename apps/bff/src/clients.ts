import { createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AuthService, ChannelService, ChatService } from "@streamix/proto";
import { INTERNAL_TOKEN_HEADER } from "@streamix/schemas/internal-auth";
import { env } from "./env.js";

// Attach the shared internal token to every internal gRPC call (P2-1). Core and
// chat verify it (production-enforced).
const attachInternalToken: Interceptor = (next) => (req) => {
  req.header.set(INTERNAL_TOKEN_HEADER, env.INTERNAL_TOKEN);
  return next(req);
};

const coreTransport = createGrpcTransport({
  baseUrl: env.CORE_URL,
  interceptors: [attachInternalToken],
});
const chatTransport = createGrpcTransport({
  baseUrl: env.CHAT_URL,
  interceptors: [attachInternalToken],
});

export const coreAuth = createClient(AuthService, coreTransport);
export const coreChannel = createClient(ChannelService, coreTransport);
export const chat = createClient(ChatService, chatTransport);
