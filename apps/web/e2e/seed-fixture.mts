// Creates/repairs the broadcast E2E fixture (account + channel) on a target, so
// the scripts have real credentials instead of a dead default.
//
// Run (from apps/svc-media):
//   BFF_URL=… EMAIL=… PASSWORD=… SLUG=… pnpm exec tsx ../web/e2e/seed-fixture.mts
// Required env: BFF_URL, EMAIL, PASSWORD, SLUG.
// Exit: 0 fixture ready · 1 fixture unusable · 2 misconfigured.
import { ConfigError, reportError, requiredEnv } from "./lib.mts";

async function main() {
  const BFF = requiredEnv("BFF_URL");
  const EMAIL = requiredEnv("EMAIL");
  const PASSWORD = requiredEnv("PASSWORD");
  const SLUG = requiredEnv("SLUG");

  // Best-effort: an existing account answers 502 here rather than 409 — the
  // unique-violation mapping is broken by the drizzle 0.45 error wrapping (see
  // 작업계획서-모바일방송.md §11). Login below is the gate.
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
    throw new ConfigError(`login failed at ${BFF} (${loginRes.status}) — fixture unusable`);
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
      throw new ConfigError(`account owns channel "${mine.channel.slug}", not "${SLUG}"`);
    }
    console.log(`channel ready: ${mine.channel.slug}`);
  } else {
    const res = await rpc("CreateChannel", { title: "E2E 방송", slug: SLUG, category: "테스트" });
    if (!res.ok) {
      console.error(`FAIL createChannel: ${res.status}`);
      process.exitCode = 1;
      return;
    }
    console.log(`channel created: ${SLUG}`);
  }
  console.log("fixture OK");
}

try {
  await main();
} catch (e) {
  reportError(e);
}
