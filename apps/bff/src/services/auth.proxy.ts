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
//
// Credential-issuing RPCs (register/login/refresh) are NOT exposed: the Connect
// Login/Refresh path returns stateless 30d refresh JWTs that bypass the cookie
// session model entirely (rotation, reuse detection, server-side revocation).
// Browsers must use the REST /auth/* routes instead (inbox/review.md P0-1).
const browserAuthOnly = () =>
  Promise.reject(
    new ConnectError("use /auth/register, /auth/login, /auth/refresh", Code.PermissionDenied),
  );

export const authProxy: ServiceImpl<typeof AuthService> = {
  register: browserAuthOnly,
  login: browserAuthOnly,
  refresh: browserAuthOnly,
  async me(req, ctx) {
    const userId = await requireUser(ctx);
    return coreAuth.me(req, { headers: { "x-user-id": userId } });
  },
  // Internal-only (BFF OAuth callback -> core). Never from the browser.
  upsertOauthUser() {
    throw new ConnectError("internal RPC, not exposed to browser", Code.PermissionDenied);
  },
};
