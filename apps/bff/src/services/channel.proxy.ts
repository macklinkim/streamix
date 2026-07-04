import type { ServiceImpl } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { ChannelService } from "@streamix/proto";
import { coreChannel } from "../clients.js";
import { requireUser } from "./auth.proxy.js";

const internalOnly = () => {
  throw new ConnectError("internal RPC, not exposed to browser", Code.PermissionDenied);
};

// Browser-facing methods forward to svc-core; media<->core internal methods
// (validateStreamKey/start/stop/heartbeat) are blocked at the edge.
export const channelProxy: ServiceImpl<typeof ChannelService> = {
  async createChannel(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.createChannel(req, { headers: { "x-user-id": userId } });
  },
  getChannel: (req) => coreChannel.getChannel(req),
  listLive: (req) => coreChannel.listLive(req),
  getPlaybackUrl: (req) => coreChannel.getPlaybackUrl(req),

  validateStreamKey: internalOnly,
  startStream: internalOnly,
  stopStream: internalOnly,
  heartbeat: internalOnly,
};
