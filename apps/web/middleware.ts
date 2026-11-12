import { NextResponse, type NextRequest } from "next/server";

// Nonce-based CSP, rolled out REPORT-ONLY first (inbox/review.md V4-4/P2-3).
// Report-only never blocks — it surfaces what a strict script-src would reject
// so the enforced policy can be tuned before flipping it on. next.config.ts
// keeps the already-enforced frame-ancestors/object-src/base-uri policy; this
// adds the script/style/connect surface as report-only.
//
// connect-src is deliberately broad (https/wss) because the BFF, chat WS, and
// media origins are runtime env values not known at build time; tighten to the
// exact origins when enforcing.
const BFF = process.env.NEXT_PUBLIC_BFF_URL ?? "";

// Report sampling. Pages are statically prerendered, so the per-request nonce
// never reaches Next's scripts and every load reports the same violations
// (~15 POSTs). Same build => same reports, so new information only comes from a
// new deploy or an injected script. Sample once per browser per day, on the
// regularly visited entry pages only: a regression still surfaces within a day
// at a small fraction of the volume.
// ponytail: fixed 24h cookie per browser; upgrade = server-side dedup by
// directive+URL if reports ever need to be complete.
const REPORT_COOKIE = "streamix_csp_sampled";
const REPORT_PATHS = ["/", "/login", "/studio"];
const shouldReport = (req: NextRequest) =>
  !!BFF &&
  req.headers.get("sec-fetch-dest") === "document" && // not RSC/prefetch fetches
  !req.cookies.has(REPORT_COOKIE) &&
  (REPORT_PATHS.includes(req.nextUrl.pathname) || req.nextUrl.pathname.startsWith("/studio/"));

export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "media-src 'self' https:",
    "connect-src 'self' https: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ];
  // Collect violations at the BFF so the policy can be tuned before enforcing
  // (V4-4). report-uri isn't subject to connect-src (it's a browser beacon).
  const report = shouldReport(req);
  if (report) directives.push(`report-uri ${BFF}/csp-report`);
  const csp = directives.join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy-Report-Only", csp);
  if (report) {
    // The sampled response must not be cached: a later revalidation (304)
    // would reuse its stored headers, report-uri included, and report again.
    res.headers.set("Cache-Control", "no-store");
    res.cookies.set(REPORT_COOKIE, "1", {
      maxAge: 60 * 60 * 24,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
    });
  }
  return res;
}

export const config = {
  // Skip Next internals and static assets — only HTML documents need the policy.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
