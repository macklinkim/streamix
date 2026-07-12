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
export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = [
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
  ].join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy-Report-Only", csp);
  return res;
}

export const config = {
  // Skip Next internals and static assets — only HTML documents need the policy.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
