import { test, expect } from "@playwright/test";

// Deterministic fixture created by apps/svc-media/scripts/e2e-seed.ts.
const EMAIL = "e2e@streamix.test";
const PASSWORD = "e2epassword123";
const SLUG = "e2e-live";

test("happy path: login -> live list -> watch -> chat", async ({ page }) => {
  // 1) login
  await page.goto("/login");
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  // 2) logged in, back on home; the live channel is listed
  await expect(page).toHaveURL("http://localhost:3000/");
  await expect(page.getByText("스튜디오")).toBeVisible();
  const card = page.locator(`a[href="/watch/${SLUG}"]`).first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // 3) open the watch page; the signed HLS playlist loads (playback authz + wiring,
  //    verified codec-agnostically so it passes on Chromium without H264)
  const playlist = page.waitForResponse(
    (r) => r.url().includes("/hls/") && r.url().includes("index.m3u8") && r.status() === 200,
    { timeout: 20_000 },
  );
  await card.click();
  await expect(page).toHaveURL(`http://localhost:3000/watch/${SLUG}`);
  await expect(page.locator("video")).toBeVisible();
  await playlist;

  // 4) chat roundtrip: send a message and see it echoed back via fanout
  const message = `e2e-hello-${Date.now()}`;
  const input = page.locator('input[placeholder="메시지 보내기"]');
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.fill(message);
  await input.press("Enter");
  await expect(page.getByText(message)).toBeVisible({ timeout: 10_000 });
});
