import type { ServiceImpl, HandlerContext } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { AuthService } from "@streamix/proto";
import { coreAuth } from "../clients.js";
import { verifyAccessToken, bearer } from "../auth.js";

export async function requireUser(ctx: HandlerContext): Promise<string> {
  const userId = await verifyAccessToken(bearer(ctx.requestHeader.get("authorization")));
  if (!userId) throw new ConnectError("authentication required", Code.Unauthenticated);
  return userId;
}

// BFF exposes AuthService to the browser and forwards to svc-core over gRPC,
// injecting the verified user id on authed methods (docs/bff-service-comm.md).
export const authProxy: ServiceImpl<typeof AuthService> = {
  register: (req) => coreAuth.register(req),
  login: (req) => coreAuth.login(req),
  refresh: (req) => coreAuth.refresh(req),
  async me(req, ctx) {
    const userId = await requireUser(ctx);
    return coreAuth.me(req, { headers: { "x-user-id": userId } });
  },
};
