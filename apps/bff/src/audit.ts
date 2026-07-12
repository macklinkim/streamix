import { createHash } from "node:crypto";
import { Counter } from "prom-client";

// Security audit log (inbox/review.md P2-4 / V2-4): a structured, greppable
// trail of account-security events for takeover investigation. Deliberately
// PII-light — emails are hashed (stable for correlation, not reversible in the
// log), passwords never appear. Emitted as single-line JSON to stdout so the
// platform log pipeline captures it; also counted for /metrics alerting.
export type AuditEvent =
  | "login_success"
  | "login_failure"
  | "register"
  | "logout"
  | "password_change"
  | "refresh_reuse" // replay of a used refresh sid -> family revoked (theft signal)
  | "refresh_expired";

const auditEvents = new Counter({
  name: "streamix_audit_events_total",
  help: "Security audit events, by type.",
  labelNames: ["event"] as const,
});

/** Non-reversible short email fingerprint for correlating events without storing the address. */
export function emailFingerprint(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export function audit(
  event: AuditEvent,
  fields: { ip?: string; userId?: string; emailFp?: string; reason?: string },
): void {
  auditEvents.inc({ event });
  console.log(JSON.stringify({ audit: true, event, ts: new Date().toISOString(), ...fields }));
}
