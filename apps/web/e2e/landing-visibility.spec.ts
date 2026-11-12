import { test, expect } from "@playwright/test";

test.use({ timezoneId: "Asia/Seoul" });

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/refresh", (route) => route.fulfill({ status: 401 }));
  await page.route("**/channel.v1.ChannelService/ListLive", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "http://localhost:3000" },
      body: JSON.stringify({ channels: [] }),
    }),
  );
});

test("first visit automatically saves a cookie until local midnight", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
  const cookie = (await context.cookies()).find((item) => item.name === "streamix_landing_seen");
  expect(cookie?.value).toBe("1");
  expect(cookie?.path).toBe("/");
  expect(cookie?.sameSite).toBe("Lax");
  const midnight = await page.evaluate(() => {
    const date = new Date();
    date.setHours(24, 0, 0, 0);
    return date.getTime() / 1000;
  });
  expect(cookie?.expires).toBe(midnight);

  await page.reload();
  await expect(page.getByRole("heading", { name: "지금 라이브" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/signup");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "지금 라이브" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("another tab shares the daily cookie", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("heading", { name: "지금 라이브" })).toBeVisible();
  await expect(other.getByRole("dialog")).toHaveCount(0);
});

test("an expired daily cookie allows the next visit to show the curtain", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "streamix_landing_seen",
      value: "1",
      domain: "localhost",
      path: "/",
      expires: Math.floor(Date.now() / 1000) - 1,
    },
  ]);
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("daily suppression works even when localStorage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("localStorage unavailable");
      },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "지금 라이브" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
