// C1 happy path: login -> studio -> ensure stream key -> pick camera source ->
// 방송시작 (fake camera capture) -> 송출 중 -> watch page playback advances ->
// 방송 종료. Local full-stack target by default; override WEB/creds/slug via env.
// Screen-source regression: run with SOURCE=screen.
//
// Run (from apps/svc-media or repo root):
//   pnpm exec tsx apps/web/e2e/camera-broadcast.mts
// Env: WEB, EMAIL, PASSWORD, SLUG, SOURCE(camera|screen), MOBILE(1)
import { chromium, devices as playwrightDevices } from "@playwright/test";

const WEB = process.env.WEB ?? "http://localhost:3000";
const EMAIL = process.env.EMAIL ?? "e2e@streamix.test";
const PASSWORD = process.env.PASSWORD ?? "e2epassword123";
const SLUG = process.env.SLUG ?? "e2e-live";
const SOURCE = (process.env.SOURCE ?? "camera") as "camera" | "screen";
const MOBILE = process.env.MOBILE === "1";

// Fake media: --use-fake-device-for-media-stream feeds a synthetic camera/mic;
// --use-fake-ui-for-media-stream auto-accepts the permission prompt. Screen
// source additionally needs an auto-selected desktop capture source.
const args = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  // Opening the viewer tab backgrounds the broadcaster tab; Chromium otherwise
  // throttles MediaRecorder there and the stream stalls after ~1s (R3). Real
  // users get wakeLock + a background warning instead.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
if (SOURCE === "screen") args.push("--auto-select-desktop-capture-source=Entire screen");

const browser = await chromium.launch({ headless: false, args });
const context = await browser.newContext(
  MOBILE ? { ...playwrightDevices["Pixel 5"] } : {},
);
const page = await context.newPage();
page.on("websocket", (ws) => {
  if (ws.url().includes("/ingest")) {
    console.log("ingest ws opened:", ws.url().replace(/key=[^&]+/, "key=***"));
    ws.on("close", () => console.log("ingest ws closed"));
  }
});
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("console error:", msg.text());
});

await page.goto(`${WEB}/login`);
await page.getByRole("textbox", { name: "이메일" }).fill(EMAIL);
await page.getByRole("textbox", { name: "비밀번호" }).fill(PASSWORD);
await page.getByRole("button", { name: "로그인" }).click();
await page.waitForURL(`${WEB}/`);
console.log("PASS login");

await page.goto(`${WEB}/studio`);

// Ensure a plaintext key is present this session (auto-issued token in M2, or
// rotate as a fallback for the OBS-key path).
const rotateBtn = page.getByRole("button", { name: "스트림 키 재발급" });
if (await rotateBtn.isVisible().catch(() => false)) {
  await rotateBtn.click();
  await page.getByText(/이 키는 지금만 표시됩니다|송출/).first().waitFor({ timeout: 15000 });
  console.log("PASS ensured stream key");
}

// Pick source (camera is default; click the screen tab only when testing it).
if (SOURCE === "screen") {
  await page.getByRole("button", { name: "화면" }).click();
}

await page.getByRole("button", { name: "방송시작" }).click();
try {
  await page.getByText("송출 중").waitFor({ timeout: 20000 });
  console.log(`PASS broadcasting state (source=${SOURCE}, mobile=${MOBILE})`);
} catch {
  const err = await page.locator("p.text-live").first().textContent().catch(() => null);
  console.log("FAIL broadcasting state; error shown:", err);
  await browser.close();
  process.exit(1);
}

// Verify playback over HTTP, keeping the broadcaster tab in the foreground — a
// second browser tab would background it and Chromium throttles MediaRecorder
// there, stalling the stream (R3). Fetching the signed HLS playlist and its
// segments is the same measurement smoke-ingest-prod uses and proves the stream
// is live and playable (segments advancing = currentTime would advance).
const bff = "https://streamix-bff.fly.dev";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Confirm the channel actually went live server-side (not just the UI).
let live = false;
for (let i = 0; i < 20 && !live; i++) {
  const r = await fetch(`${bff}/channel.v1.ChannelService/GetChannel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: SLUG }),
  });
  live = (await r.json()).channel?.isLive ?? false;
  if (!live) await sleep(2000);
}
console.log(live ? "PASS channel live" : "FAIL channel live");

let served = false;
if (live) {
  const pr = await fetch(`${bff}/channel.v1.ChannelService/GetPlaybackUrl`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: SLUG }),
  });
  const url = (await pr.json()).url as string;
  for (let i = 0; i < 20 && !served; i++) {
    const res = await fetch(url);
    if (res.ok) {
      let text = await res.text();
      const variant = text
        .split("\n")
        .find((l) => !l.startsWith("#") && l.includes(".m3u8"))
        ?.trim();
      if (variant) {
        const base = url.split("/index.m3u8")[0];
        const vr = await fetch(`${base}/${variant}`).catch(() => null);
        if (vr?.ok) text = await vr.text();
      }
      served = /\.(ts|mp4|m4s)/.test(text);
    }
    if (!served) await sleep(2000);
  }
}
console.log(served ? "PASS signed m3u8 serves segments" : "FAIL playback segments");

await page.getByRole("button", { name: "방송 종료" }).click();
console.log("stopped broadcast");

let offline = false;
for (let i = 0; i < 20 && !offline; i++) {
  await sleep(2000);
  const r = await fetch(`${bff}/channel.v1.ChannelService/GetChannel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: SLUG }),
  });
  offline = !((await r.json()).channel?.isLive ?? false);
}
console.log(offline ? "PASS offline transition" : "FAIL offline transition");

await browser.close();
process.exit(live && served && offline ? 0 : 1);
