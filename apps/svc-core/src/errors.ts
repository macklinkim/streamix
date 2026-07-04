import { Code, ConnectError } from "@connectrpc/connect";
import { AppErrorCode, appErrorToConnectCode } from "@streamix/schemas";

const connectCodeByName: Record<string, Code> = {
  unauthenticated: Code.Unauthenticated,
  already_exists: Code.AlreadyExists,
  not_found: Code.NotFound,
  permission_denied: Code.PermissionDenied,
  resource_exhausted: Code.ResourceExhausted,
  invalid_argument: Code.InvalidArgument,
  internal: Code.Internal,
};

/** Throw a Connect error mapped from the shared error contract (docs/error-contract.md). */
export function appError(app: AppErrorCode, message?: string): ConnectError {
  const name = appErrorToConnectCode[app];
  return new ConnectError(message ?? app, connectCodeByName[name] ?? Code.Unknown);
}

/** Postgres unique-violation code. */
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "23505"
  );
}
