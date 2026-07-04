import { Code, ConnectError } from "@connectrpc/connect";
import { AppErrorCode, appErrorToConnectCode } from "@streamix/schemas";

// NOTE: mirrors apps/svc-core/src/errors.ts. Extract to a shared @streamix/rpc
// package if a third service needs it (svc-media, Phase 3).
const connectCodeByName: Record<string, Code> = {
  unauthenticated: Code.Unauthenticated,
  already_exists: Code.AlreadyExists,
  not_found: Code.NotFound,
  permission_denied: Code.PermissionDenied,
  resource_exhausted: Code.ResourceExhausted,
  invalid_argument: Code.InvalidArgument,
  internal: Code.Internal,
};

export function appError(app: AppErrorCode, message?: string): ConnectError {
  const name = appErrorToConnectCode[app];
  return new ConnectError(message ?? app, connectCodeByName[name] ?? Code.Unknown);
}
