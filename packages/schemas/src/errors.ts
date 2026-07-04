// Error contract (§ Phase 1). Single source of truth shared by BFF + services.
// Domain error -> Connect code (unary/RPC) and -> WS close code (chat channel).

/** Stable app-level error identifiers surfaced to clients in ErrorDetail.code. */
export const AppErrorCode = {
  INVALID_CREDENTIALS: "invalid_credentials",
  EMAIL_ALREADY_EXISTS: "email_already_exists",
  SLUG_TAKEN: "slug_taken",
  NOT_FOUND: "not_found",
  INVALID_STREAM_KEY: "invalid_stream_key",
  BANNED: "banned",
  SLOWMODE_ACTIVE: "slowmode_active",
  RATE_LIMITED: "rate_limited",
  VALIDATION: "validation",
  INTERNAL: "internal",
} as const;
export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

/** Connect/gRPC canonical code names (@connectrpc/connect `Code`). */
export const appErrorToConnectCode: Record<AppErrorCode, string> = {
  invalid_credentials: "unauthenticated",
  email_already_exists: "already_exists",
  slug_taken: "already_exists",
  not_found: "not_found",
  invalid_stream_key: "permission_denied",
  banned: "permission_denied",
  slowmode_active: "resource_exhausted",
  rate_limited: "resource_exhausted",
  validation: "invalid_argument",
  internal: "internal",
};

/** WebSocket close codes for the chat channel (ADR-4). App range 4000-4999. */
export const WsCloseCode = {
  NORMAL: 1000,
  SERVER_ERROR: 1011,
  PROTOCOL_ERROR: 4000,
  UNAUTHENTICATED: 4001,
  FORBIDDEN: 4003,
  ROOM_NOT_FOUND: 4004,
  RATE_LIMITED: 4008,
} as const;
export type WsCloseCode = (typeof WsCloseCode)[keyof typeof WsCloseCode];
