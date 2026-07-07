import type { ServiceImpl, HandlerContext } from "@connectrpc/connect";
import { eq } from "drizzle-orm";
import { AuthService } from "@streamix/proto";
import { AppErrorCode, emailSchema, passwordSchema } from "@streamix/schemas";
import { users } from "@streamix/db";
import { db } from "../deps.js";
import { appError, isUniqueViolation } from "../errors.js";
import { toUserMsg } from "../mappers.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signAccess, signRefresh, verifyRefresh } from "./jwt.js";

/** BFF sets x-user-id after verifying the access JWT (docs/bff-service-comm.md). */
function requireUserId(ctx: HandlerContext): string {
  const id = ctx.requestHeader.get("x-user-id");
  if (!id) throw appError(AppErrorCode.INVALID_CREDENTIALS, "missing authenticated user");
  return id;
}

export const authService: ServiceImpl<typeof AuthService> = {
  async register(req) {
    const email = emailSchema.parse(req.email);
    passwordSchema.parse(req.password);
    const passwordHash = await hashPassword(req.password);
    try {
      const [u] = await db
        .insert(users)
        .values({ email, passwordHash, displayName: req.displayName })
        .returning();
      return { user: toUserMsg(u!) };
    } catch (e) {
      if (isUniqueViolation(e)) throw appError(AppErrorCode.EMAIL_ALREADY_EXISTS);
      throw e;
    }
  },

  async login(req) {
    const [u] = await db.select().from(users).where(eq(users.email, req.email)).limit(1);
    // OAuth-only accounts have no password hash — password login is unavailable.
    if (!u || !u.passwordHash || !(await verifyPassword(u.passwordHash, req.password))) {
      throw appError(AppErrorCode.INVALID_CREDENTIALS);
    }
    return {
      accessToken: await signAccess(u.id),
      refreshToken: await signRefresh(u.id),
      user: toUserMsg(u),
    };
  },

  async refresh(req) {
    let userId: string;
    try {
      userId = await verifyRefresh(req.refreshToken);
    } catch {
      throw appError(AppErrorCode.INVALID_CREDENTIALS, "invalid refresh token");
    }
    return { accessToken: await signAccess(userId), refreshToken: await signRefresh(userId) };
  },

  async me(_req, ctx) {
    const userId = requireUserId(ctx);
    const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw appError(AppErrorCode.NOT_FOUND, "user not found");
    return { user: toUserMsg(u) };
  },

  // Internal-only: called by the BFF after a Twitch OAuth exchange. Matches on
  // provider_id (stable across logins) and creates a password-less account on
  // first sight. Blocked from the browser at the BFF edge.
  async upsertOauthUser(req) {
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.providerId, req.providerId))
      .limit(1);
    if (existing) return { user: toUserMsg(existing) };

    const displayName = req.displayName || "twitch_user";
    const fallbackEmail = `${req.providerId.replace(/:/g, "_")}@twitch.streamix.local`;
    const email = req.email || fallbackEmail;
    try {
      const [u] = await db
        .insert(users)
        .values({ email, displayName, providerId: req.providerId })
        .returning();
      return { user: toUserMsg(u!) };
    } catch (e) {
      // A local account already owns this email — keep the OAuth account distinct.
      if (isUniqueViolation(e)) {
        const [u] = await db
          .insert(users)
          .values({ email: fallbackEmail, displayName, providerId: req.providerId })
          .returning();
        return { user: toUserMsg(u!) };
      }
      throw e;
    }
  },
};
