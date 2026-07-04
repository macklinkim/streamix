import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ChannelService } from "@streamix/proto";
import { env } from "./env.js";

// svc-media only talks to Core (validate key, live-state notify). Core is the
// single writer of live state (§5.2); media never writes Redis directly.
export const core = createClient(ChannelService, createGrpcTransport({ baseUrl: env.CORE_URL }));
