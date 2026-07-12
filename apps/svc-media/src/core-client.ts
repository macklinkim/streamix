import { createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ChannelService } from "@streamix/proto";
import { INTERNAL_TOKEN_HEADER } from "@streamix/schemas/internal-auth";
import { env } from "./env.js";

// Attach the shared internal token to Core calls (P2-1), verified core-side.
const attachInternalToken: Interceptor = (next) => (req) => {
  req.header.set(INTERNAL_TOKEN_HEADER, env.INTERNAL_TOKEN);
  return next(req);
};

// svc-media only talks to Core (validate key, live-state notify). Core is the
// single writer of live state (§5.2); media never writes Redis directly.
export const core = createClient(
  ChannelService,
  createGrpcTransport({ baseUrl: env.CORE_URL, interceptors: [attachInternalToken] }),
);
