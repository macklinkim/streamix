import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

async function sign(userId: string, typ: "access" | "refresh", ttl: string): Promise<string> {
  return new SignJWT({ typ })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

export function signAccess(userId: string): Promise<string> {
  return sign(userId, "access", env.ACCESS_TTL);
}

export function signRefresh(userId: string): Promise<string> {
  return sign(userId, "refresh", env.REFRESH_TTL);
}

export async function verifyRefresh(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret);
  if (payload.typ !== "refresh" || typeof payload.sub !== "string") {
    throw new Error("not a refresh token");
  }
  return payload.sub;
}
