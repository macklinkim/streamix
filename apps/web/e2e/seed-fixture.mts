// Creates/repairs the broadcast E2E fixture (account + channel) on a target, so
// the scripts have real credentials instead of a dead default.
//
// Run (from apps/svc-media):
//   BFF_URL=http://localhost:8080 EMAIL=… PASSWORD=… SLUG=… pnpm exec tsx ../web/e2e/seed-fixture.mts
import { requiredEnv } from "./lib.mts";

const BFF = requiredEnv("BFF_URL");
const EMAIL = requiredEnv("EMAIL");
const PASSWORD = requiredEnv("PASSWORD");
const SLUG = requiredEnv("SLUG");

// Best-effort: an existing account currently answers 502 here, not 409 (cause
// unconfirmed — see the mobile plan's deferred register). Login below is the gate.
const reg = await fetch(`${BFF}/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "E2E fixture" }),
});
console.log(`register: ${reg.status}`);

const loginRes = await fetch(`${BFF}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginRes.ok) {
  console.error(`FAIL login as ${EMAIL}: ${loginRes.status} — fixture unusable`);
  process.exit(1);
}
const { accessToken } = (await loginRes.json()) as { accessToken: string };

const rpc = (m: string, body: unknown) =>
  fetch(`${BFF}/channel.v1.ChannelService/${m}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });

const mine = (await (await rpc("GetMyChannel", {})).json()) as { channel?: { slug: string } };
if (mine.channel) {
  if (mine.channel.slug !== SLUG) {
    console.error(`FAIL account owns channel "${mine.channel.slug}", not "${SLUG}"`);
    process.exit(1);
  }
  console.log(`channel ready: ${mine.channel.slug}`);
} else {
  const res = await rpc("CreateChannel", { title: "E2E 방송", slug: SLUG, category: "테스트" });
  if (!res.ok) {
    console.error(`FAIL createChannel: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`channel created: ${SLUG}`);
}
console.log("fixture OK");
