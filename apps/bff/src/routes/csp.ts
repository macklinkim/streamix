import type { FastifyInstance } from "fastify";
import { Counter } from "prom-client";

// CSP violation report sink (inbox/review.md V4-4). The web ships a report-only
// nonce CSP; browsers POST violations here so the policy can be tuned before it
// is enforced. Reports are counted (by directive) for /metrics and a bounded
// sample is logged — a hostile page could otherwise flood the log.
const cspViolations = new Counter({
  name: "streamix_csp_violations_total",
  help: "CSP violation reports received, by effective directive.",
  labelNames: ["directive"] as const,
});

const LOG_PER_MIN = 50;
let logWindowStart = 0;
let loggedThisWindow = 0;
const DIRECTIVES = new Set([
  "base-uri",
  "child-src",
  "connect-src",
  "default-src",
  "font-src",
  "form-action",
  "frame-ancestors",
  "frame-src",
  "img-src",
  "manifest-src",
  "media-src",
  "navigate-to",
  "object-src",
  "report-to",
  "report-uri",
  "require-trusted-types-for",
  "sandbox",
  "script-src",
  "script-src-attr",
  "script-src-elem",
  "style-src",
  "style-src-attr",
  "style-src-elem",
  "trusted-types",
  "upgrade-insecure-requests",
  "worker-src",
]);

function safeUri(value: unknown): string {
  if (typeof value !== "string") return "[invalid]";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[invalid]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 256);
  } catch {
    return "[invalid]";
  }
}

type CspReportBody = {
  "csp-report"?: Record<string, unknown>;
  body?: Record<string, unknown>; // Reporting API (report-to) shape
};

export async function cspRoutes(app: FastifyInstance): Promise<void> {
  // Browsers send application/csp-report or application/reports+json, which the
  // default JSON parser rejects — accept both as JSON.
  app.addContentTypeParser(
    ["application/csp-report", "application/reports+json"],
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, {}); // malformed report: swallow, never 500 a beacon
      }
    },
  );

  app.post("/csp-report", async (req, reply) => {
    const b = (req.body ?? {}) as CspReportBody;
    const report = b["csp-report"] ?? b.body;
    const r = report && typeof report === "object" && !Array.isArray(report) ? report : {};
    const raw = r["effective-directive"] ?? r["violated-directive"];
    const name = typeof raw === "string" ? (raw.split(" ")[0] ?? "") : "";
    const directive = DIRECTIVES.has(name) ? name : "other";
    cspViolations.inc({ directive });

    const now = Date.now();
    if (now - logWindowStart > 60_000) {
      logWindowStart = now;
      loggedThisWindow = 0;
    }
    if (loggedThisWindow < LOG_PER_MIN) {
      loggedThisWindow += 1;
      req.log.warn({
        cspViolation: {
          directive,
          blockedUri: safeUri(r["blocked-uri"]),
          documentUri: safeUri(r["document-uri"]),
        },
      });
    }
    return reply.code(204).send();
  });
}
