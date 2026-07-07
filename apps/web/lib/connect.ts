import { createClient, Code, ConnectError } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { AuthService, ChannelService } from "@streamix/proto";
import { bffUrl, wsUrl } from "./api-base";
import { apiRefresh } from "./session";
import { useAuth } from "./auth-store";

// Re-exported so existing importers (chat.tsx) keep working.
export { bffUrl, wsUrl };

// On an expired access token, transparently mint a new one from the refresh
// cookie and retry once. If refresh fails, the session is over.
const refreshInterceptor: Interceptor = (next) => async (req) => {
  try {
    return await next(req);
  } catch (e) {
    if (e instanceof ConnectError && e.code === Code.Unauthenticated) {
      const token = await apiRefresh();
      if (token) {
        useAuth.getState().setToken(token);
        req.header.set("authorization", `Bearer ${token}`);
        return await next(req);
      }
      useAuth.getState().clear();
    }
    throw e;
  }
};

// Browser -> BFF over the Connect protocol (ADR-1). BFF forwards to internal gRPC.
const transport = createConnectTransport({ baseUrl: bffUrl, interceptors: [refreshInterceptor] });
export const authClient = createClient(AuthService, transport);
export const channelClient = createClient(ChannelService, transport);
