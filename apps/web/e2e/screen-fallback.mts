// D3 + D2-b: on a phone browser without screen capture, the 화면 source must be
// disabled with an RTMP fallback notice (never a silent no-op), and the studio's
// RTMP device card must render and copy on a mobile viewport.
//
// Mobile emulation still exposes getDisplayMedia (M0 S2), so the unsupported
// phone is reproduced by deleting the API before any page script runs. The
// desktop screen-source regression lives in camera-broadcast.mts SOURCE=screen.
//
// Run (from apps/svc-media or repo root):
//   pnpm exec tsx apps/web/e2e/screen-fallback.mts
// Env: WEB, EMAIL, PASSWORD
import { chromium, devices as playwrightDevices } from "@playwright/test";

const WEB = process.env.WEB ?? "http://localhost:3000";
const EMAIL = process.env.EMAIL ?? "e2e@streamix.test";
const PASSWORD = process.env.PASSWORD ?? "e2epassword123";

const browser = await chromium.launch({
  headless: false,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const context = await browser.newContext({
  ...playwrightDevices["Pixel 5"],
  permissions: ["clipboard-read", "clipboard-write"],
});
await context.addInitScript(() => {
  // @ts-expect-error - reproducing a browser that never shipped the API
  delete MediaDevices.prototype.getDisplayMedia;
});
const page = await context.newPage();

await page.goto(`${WEB}/login`);
await page.getByRole("textbox", { name: "이메일" }).fill(EMAIL);
await page.getByRole("textbox", { name: "비밀번호" }).fill(PASSWORD);
await page.getByRole("button", { name: "로그인" }).click();
await page.waitForURL(`${WEB}/`);
await page.goto(`${WEB}/studio`);

const results: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

// D3: screen source disabled + fallback notice instead of a dead button.
const screenBtn = page.getByRole("button", { name: "화면" });
await screenBtn.waitFor({ timeout: 15000 });
check("screen source disabled", await screenBtn.isDisabled());
check(
  "rtmp fallback notice shown",
  await page.getByText("이 브라우저는 화면 송출을 지원하지 않습니다").isVisible(),
);

// D2-b: the RTMP device card renders and copies on a 390px viewport. The full
// URL row only exists while this session holds a plaintext key, so rotate first.
await page.getByRole("button", { name: "스트림 키 재발급" }).click();
const fullUrlRow = page.getByText("전체 URL (한 줄 입력 장비용)");
await fullUrlRow.waitFor({ timeout: 15000 });
check("rtmp card renders on mobile viewport", await fullUrlRow.isVisible());

const box = await page.getByRole("heading", { name: /장비로 방송/ }).boundingBox();
check("card fits 390px viewport", !!box && box.x >= 0 && box.x + box.width <= 390);

await page.getByRole("button", { name: "복사" }).last().click();
const copied = await page.evaluate(() => navigator.clipboard.readText());
check("full rtmp url copied", /^rtmps?:\/\/.+\/live\/.+/.test(copied));

// Key stays out of client storage even after being revealed/copied (M2 invariant).
const leaked = await page.evaluate(() => {
  const hay = JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + document.cookie;
  return hay.includes("live_");
});
check("key not persisted to client storage", !leaked);

await browser.close();
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
