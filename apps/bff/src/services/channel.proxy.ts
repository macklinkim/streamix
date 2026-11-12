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
  async getMyChannel(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.getMyChannel(req, { headers: { "x-user-id": userId } });
  },
  async rotateStreamKey(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.rotateStreamKey(req, { headers: { "x-user-id": userId } });
  },
  async issueIngestToken(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.issueIngestToken(req, { headers: { "x-user-id": userId } });
  },
  async updateChannel(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.updateChannel(req, { headers: { "x-user-id": userId } });
  },
  async followChannel(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.followChannel(req, { headers: { "x-user-id": userId } });
  },
  async unfollowChannel(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.unfollowChannel(req, { headers: { "x-user-id": userId } });
  },
  async listFollowing(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.listFollowing(req, { headers: { "x-user-id": userId } });
  },
  async addModerator(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.addModerator(req, { headers: { "x-user-id": userId } });
  },
  async removeModerator(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.removeModerator(req, { headers: { "x-user-id": userId } });
  },
  async listModerators(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.listModerators(req, { headers: { "x-user-id": userId } });
  },
  async listMyStreams(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.listMyStreams(req, { headers: { "x-user-id": userId } });
  },
  async listRecentFollowers(req, ctx) {
    const userId = await requireUser(ctx);
    return coreChannel.listRecentFollowers(req, { headers: { "x-user-id": userId } });
  },
  // Public: anonymous viewers count too (benchmark G-21).
  watchHeartbeat: (req) => coreChannel.watchHeartbeat(req),
  // Public replays (benchmark G-15); the URL is signed and short-lived.
  listVideos: (req) => coreChannel.listVideos(req),
  getVodUrl: (req) => coreChannel.getVodUrl(req),
  searchChannels: (req) => coreChannel.searchChannels(req),
  getChannel: (req) => coreChannel.getChannel(req),
  listLive: (req) => coreChannel.listLive(req),
  getPlaybackUrl: (req) => coreChannel.getPlaybackUrl(req),

  validateStreamKey: internalOnly,
  startStream: internalOnly,
  stopStream: internalOnly,
  heartbeat: internalOnly,
  channelExists: internalOnly,
  getChatRole: internalOnly,
  markVodReady: internalOnly,
};
