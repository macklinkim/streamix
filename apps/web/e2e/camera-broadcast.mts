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

// Watch as a viewer from a second tab.
const viewer = await context.newPage();
viewer.on("response", (res) => {
  if (res.url().includes(".m3u8")) console.log("m3u8:", res.status());
});
await viewer.goto(`${WEB}/watch/${SLUG}`);
let advancing = false;
for (let i = 0; i < 24 && !advancing; i++) {
  advancing = await viewer.evaluate(async () => {
    const v = document.querySelector("video");
    if (!v) return false;
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, 5000));
    return v.currentTime > t0;
  });
  const state = await viewer.evaluate(() => {
    const v = document.querySelector("video");
    return v ? `t=${v.currentTime.toFixed(1)} rs=${v.readyState}` : "no-video";
  });
  console.log(`viewer[${i}] ${state}`);
}
console.log(advancing ? "PASS viewer playback advancing" : "FAIL viewer playback");

await page.getByRole("button", { name: "방송 종료" }).click();
console.log("stopped broadcast");

// Offline transition: viewer flips back to offline within the poll window.
const offline = await viewer
  .getByText(/오프라인|방송 준비|현재 방송/)
  .first()
  .isVisible({ timeout: 20000 })
  .catch(() => false);
console.log(offline ? "PASS offline transition" : "WARN offline transition not observed");

await browser.close();
process.exit(advancing ? 0 : 1);
