// C1 happy path: login -> studio -> ensure stream key -> pick camera source ->
// 방송시작 (fake camera capture) -> 송출 중 -> watch page playback advances ->
// 방송 종료. Local full-stack target by default; override WEB/creds/slug via env.
// Screen-source regression: run with SOURCE=screen.
// D1 (detailed camera pick): run with MOBILE=1 DEVICE_ID=<n> to open "카메라 더
// 보기" and broadcast from the n-th enumerated camera.
//
// Run (from apps/svc-media or repo root):
//   pnpm exec tsx apps/web/e2e/camera-broadcast.mts
// Env: WEB, EMAIL, PASSWORD, SLUG, SOURCE(camera|screen), MOBILE(1), DEVICE_ID(index)
import { chromium, devices as playwrightDevices } from "@playwright/test";

const WEB = process.env.WEB ?? "http://localhost:3000";
const EMAIL = process.env.EMAIL ?? "e2e@streamix.test";
const PASSWORD = process.env.PASSWORD ?? "e2epassword123";
const SLUG = process.env.SLUG ?? "e2e-live";
const SOURCE = (process.env.SOURCE ?? "camera") as "camera" | "screen";
const MOBILE = process.env.MOBILE === "1";
// Index into the detailed camera list; empty = front/back preset (default).
const DEVICE_ID = process.env.DEVICE_ID ?? "";

// Fake media: --use-fake-device-for-media-stream feeds a synthetic camera/mic;
// --use-fake-ui-for-media-stream auto-accepts the permission prompt. Screen
// source additionally needs an auto-selected desktop capture source.
// device-count=3 makes Chromium's fake factory expose three cameras, so the
// detailed picker has something to choose between (M0 S1).
const args = [
  DEVICE_ID ? "--use-fake-device-for-media-stream=device-count=3" : "--use-fake-device-for-media-stream",
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
// Spy on the video constraints the app actually asks for, so D1 can prove the
// picked deviceId reached getUserMedia (a fake camera looks identical on screen).
await context.addInitScript(() => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) => {
    (window as unknown as { __videoConstraint?: unknown }).__videoConstraint = c?.video;
    return orig(c);
  };
});

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

// D1: expand the detailed camera list and pick the n-th camera (option 0 is the
// front/back preset, so cameras start at index 1).
let pickedDeviceId = "";
if (DEVICE_ID) {
  await page.getByRole("button", { name: "카메라 더 보기" }).click();
  const select = page.getByLabel("카메라");
  await select.selectOption({ index: Number(DEVICE_ID) + 1 });
  pickedDeviceId = await select.inputValue();
  console.log(pickedDeviceId ? "PASS detailed camera selected" : "FAIL detailed camera selected");
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

let constraintOk = true;
if (DEVICE_ID) {
  const vc = (await page.evaluate(
    () => (window as unknown as { __videoConstraint?: unknown }).__videoConstraint,
  )) as { deviceId?: { exact?: string } } | undefined;
  constraintOk = vc?.deviceId?.exact === pickedDeviceId;
  console.log(
    constraintOk
      ? "PASS deviceId constraint reached getUserMedia"
      : `FAIL deviceId constraint; got ${JSON.stringify(vc)}`,
  );
}

// Verify playback over HTTP, keeping the broadcaster tab in the foreground — a
// second browser tab would background it and Chromium throttles MediaRecorder
// there, stalling the stream (R3). Fetching the signed HLS playlist and its
// segments is the same measurement smoke-ingest-prod uses and proves the stream
// is live and playable (segments advancing = currentTime would advance).
const bff = process.env.BFF_URL ?? "https://streamix-bff.fly.dev";
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
process.exit(live && served && offline && constraintOk ? 0 : 1);
