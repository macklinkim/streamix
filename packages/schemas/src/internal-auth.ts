// Internal service-to-service authentication (inbox/review.md P2-1). Internal
// gRPC previously trusted the x-user-id header alone, so any workload on the Fly
// private network could impersonate a user. A shared secret in x-internal-token
// gives the internal boundary its own credential. This module is a subpath
// export (not in the barrel) so the browser bundle never pulls node:crypto.
import { timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** Constant-time compare of a presented internal token against the expected one. */
export function internalTokenValid(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
