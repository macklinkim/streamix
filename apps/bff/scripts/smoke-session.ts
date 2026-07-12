// Session-hardening smoke: exercises the cookie-based /auth/* routes end to end.
// Requires svc-core :50051, bff :8080, Postgres + Redis running.
//
// Covers: HttpOnly refresh cookie + flags, refresh-token rotation, concurrent
// refresh (single successor via the idempotent grace window), reuse detection
// past the grace (family revoke incl. access tokens), logout revocation,
// access-token denylist by jti, the CSRF header guard, and the public Connect
// credential-RPC block (inbox/review.md P0-1/P0-2/V1-1).
//
// The grace window defaults to 3s (REFRESH_GRACE_MS); this script reads the
// same env var so a shorter test grace keeps the run fast. Run the bff with a
// matching value if you override it.
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "@streamix/proto";

const BASE = "http://localhost:8080";
const transport = createConnectTransport({ baseUrl: BASE, httpVersion: "1.1" });
const auth = createClient(AuthService, transport);

const stamp = Date.now();
const email = `sess_${stamp}@example.com`;
const password = "hunter2pass";
const GRACE_MS = Number(process.env.REFRESH_GRACE_MS ?? 3000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function ok(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const JSON_H = { "content-type": "application/json", "x-sx-web": "1" };
// Pull the sx_rt value out of a Set-Cookie header (the sid, before attributes).
function sidFrom(setCookie: string | undefined): string | null {
  if (!setCookie) return null;
  const m = /sx_rt=([^;]*)/.exec(setCookie);
  return m ? m[1] : null;
}

async function post(
  path: string,
  opts: { cookie?: string; bearer?: string; body?: unknown; csrf?: boolean },
) {
  const headers: Record<string, string> = {};
  if (opts.body) headers["content-type"] = "application/json";
  if (opts.csrf !== false) headers["x-sx-web"] = "1";
  if (opts.cookie) headers["cookie"] = `sx_rt=${opts.cookie}`;
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.()[0] ?? res.headers.get("set-cookie") ?? undefined;
  const json = await res.json().catch(() => null);
  return { status: res.status, setCookie, sid: sidFrom(setCookie), json };
}

// --- register + login ---
const reg = await fetch(`${BASE}/auth/register`, {
  method: "POST",
  headers: JSON_H,
  body: JSON.stringify({ email, password, displayName: "세션" }),
});
ok("register", reg.status === 201, `status=${reg.status}`);

const login = await post("/auth/login", { body: { email, password } });
ok("login returns access token", login.status === 200 && Boolean(login.json?.accessToken));
ok("login sets a refresh cookie", Boolean(login.sid));
ok(
  "cookie is HttpOnly + Path=/auth + SameSite",
  /HttpOnly/i.test(login.setCookie ?? "") &&
    /Path=\/auth/i.test(login.setCookie ?? "") &&
    /SameSite=/i.test(login.setCookie ?? ""),
  login.setCookie,
);

const access1: string = login.json.accessToken;
const sid1 = login.sid!;

// --- access token works on an authed RPC ---
const me = await auth.me({}, { headers: { authorization: `Bearer ${access1}` } });
ok("me with access token", me.user?.email === email);

// --- CSRF guard: refresh without the marker header is rejected ---
const noCsrf = await post("/auth/refresh", { cookie: sid1, csrf: false });
ok("refresh without CSRF header rejected", noCsrf.status === 403, `status=${noCsrf.status}`);

// --- rotation: refresh issues a NEW sid + new access token ---
const r1 = await post("/auth/refresh", { cookie: sid1 });
ok("refresh ok", r1.status === 200 && Boolean(r1.json?.accessToken));
ok("refresh rotates the sid", Boolean(r1.sid) && r1.sid !== sid1, `${sid1} -> ${r1.sid}`);
const sid2 = r1.sid!;

// --- grace window: replaying the just-used sid returns the SAME successor ---
// (concurrent-refresh race protection; must not kill the family)
const graceReplay = await post("/auth/refresh", { cookie: sid1 });
ok(
  "grace replay returns same successor",
  graceReplay.status === 200 && graceReplay.sid === sid2,
  `status=${graceReplay.status} sid=${graceReplay.sid}`,
);

// --- concurrent refresh: 20 parallel rotations land on ONE successor ---
const burst = await Promise.all(
  Array.from({ length: 20 }, () => post("/auth/refresh", { cookie: sid2 })),
);
const burstOk = burst.filter((b) => b.status === 200);
const successors = new Set(burstOk.map((b) => b.sid));
ok(
  "concurrent refresh: all ok, single successor",
  burstOk.length === 20 && successors.size === 1,
  `ok=${burstOk.length} successors=${successors.size}`,
);
const sid3 = [...successors][0]!;

// --- reuse detection: replaying an old sid PAST the grace revokes the family ---
await sleep(GRACE_MS + 500);
const reuse = await post("/auth/refresh", { cookie: sid2 });
ok("reused (old) sid rejected past grace", reuse.status === 401, `status=${reuse.status}`);
ok("reuse flagged as reuse", reuse.json?.error === "reuse", String(reuse.json?.error));
// After a detected reuse, even the current sid3 is dead (family revoked).
const afterReuse = await post("/auth/refresh", { cookie: sid3 });
ok(
  "family revoked after reuse (sid3 dead)",
  afterReuse.status === 401,
  `status=${afterReuse.status}`,
);
// Family revoke also kills access tokens minted under the family (P1-1).
const meAfterReuse = await auth.me({}, { headers: { authorization: `Bearer ${access1}` } }).then(
  () => "no-error",
  (e) => (e as ConnectError).code,
);
ok(
  "access token dead after family revoke",
  meAfterReuse === Code.Unauthenticated,
  String(meAfterReuse),
);

// --- public Connect credential RPCs are blocked (P0-1) ---
for (const [label, call] of [
  ["login", () => auth.login({ email, password })],
  ["register", () => auth.register({ email: `x${email}`, password, displayName: "x" })],
  ["refresh", () => auth.refresh({ refreshToken: "x" })],
] as const) {
  const code = await call().then(
    () => "no-error",
    (e) => (e as ConnectError).code,
  );
  ok(`connect ${label} blocked`, code === Code.PermissionDenied, String(code));
}

// --- logout revocation + access denylist ---
const login2 = await post("/auth/login", { body: { email, password } });
const access2: string = login2.json.accessToken;
const sid4 = login2.sid!;
const logout = await post("/auth/logout", { cookie: sid4, bearer: access2 });
ok("logout 204", logout.status === 204, `status=${logout.status}`);
ok(
  "logout clears cookie",
  /sx_rt=;/.test(logout.setCookie ?? "") || /Max-Age=0/.test(logout.setCookie ?? ""),
  logout.setCookie,
);

const refreshAfterLogout = await post("/auth/refresh", { cookie: sid4 });
ok(
  "refresh after logout rejected",
  refreshAfterLogout.status === 401,
  `status=${refreshAfterLogout.status}`,
);

// The access token from the logged-out session is denylisted immediately.
const meAfterLogout = await auth.me({}, { headers: { authorization: `Bearer ${access2}` } }).then(
  () => "no-error",
  (e) => (e as ConnectError).code,
);
ok(
  "access token denylisted after logout",
  meAfterLogout === Code.Unauthenticated,
  String(meAfterLogout),
);

console.log(failures ? `\nSMOKE FAILED (${failures})` : "\nSMOKE OK");
process.exit(failures ? 1 : 0);
