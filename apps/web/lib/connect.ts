import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AuthService, ChannelService } from "@streamix/proto";

// Browser -> BFF over the Connect protocol (ADR-1). BFF forwards to internal gRPC.
export const bffUrl = process.env.NEXT_PUBLIC_BFF_URL ?? "http://localhost:8080";
export const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

const transport = createConnectTransport({ baseUrl: bffUrl });
export const authClient = createClient(AuthService, transport);
export const channelClient = createClient(ChannelService, transport);
