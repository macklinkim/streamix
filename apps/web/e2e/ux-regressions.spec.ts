import { test, expect, type Page } from "@playwright/test";

const hideLanding = (page: Page) =>
  page.addInitScript(() => {
    document.cookie = "streamix_landing_seen=1; Path=/; SameSite=Lax";
  });

const cors = {
  "access-control-allow-origin": "http://localhost:3000",
  "access-control-allow-credentials": "true",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-sx-web",
};

async function mockSignedIn(page: Page, isAdmin = false) {
  await page.route("**/auth/refresh", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "test-token" }),
    }),
  );
  await page.route("**/user.v1.AuthService/Me", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "test-user", email: "test@example.com", displayName: "Test", isAdmin },
      }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/refresh", (route) =>
    route.fulfill({ status: 401, headers: { "access-control-allow-origin": "*" } }),
  );
});

test("live-list failure has a retry action instead of an empty page", async ({ page }) => {
  await hideLanding(page);
  await page.route("**/channel.v1.ChannelService/ListLive", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ code: "unavailable", message: "unavailable" }),
    }),
  );
  await page.goto("/");
  await expect(page.getByText("방송 목록을 불러오지 못했습니다.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
  await expect(page.getByText("지금은 라이브 방송이 없어요")).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
});

test("empty live list gives viewers a next action without broadcaster instructions", async ({
  page,
}) => {
  await hideLanding(page);
  await page.route("**/channel.v1.ChannelService/ListLive", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ channels: [] }),
    }),
  );
  await page.goto("/");
  await expect(page.getByText("지금은 라이브 방송이 없어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "지금 다시 확인" })).toBeVisible();
  await expect(page.getByText("OBS로 송출하면")).toHaveCount(0);
});

test("channel failure is not mislabeled as not found", async ({ page }) => {
  await hideLanding(page);
  await page.route("**/channel.v1.ChannelService/GetChannel", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ code: "unavailable", message: "unavailable" }),
    }),
  );
  await page.goto("/watch/example");
  await expect(page.getByText("채널을 불러오지 못했습니다.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("채널을 찾을 수 없습니다.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
});

test("playback URL is refreshed before its five-minute expiry", async ({ page }) => {
  await hideLanding(page);
  await page.clock.install();
  await page.route("**/channel.v1.ChannelService/GetChannel", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        channel: { id: "test-channel", slug: "example", title: "Example", isLive: true },
      }),
    }),
  );
  let playbackCalls = 0;
  await page.route("**/channel.v1.ChannelService/GetPlaybackUrl", (route) => {
    playbackCalls++;
    return route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        url: "https://streamix-svc-media.fly.dev/hls/test-channel/index.m3u8?token=test",
        expiresAt: String(Math.floor(Date.now() / 1000) + 300),
      }),
    });
  });
  await page.route("**/hls/test-channel/**", (route) => route.fulfill({ status: 404 }));
  await page.goto("/watch/example");
  await expect(page.locator("video")).toBeVisible();
  expect(playbackCalls).toBe(1);
  await page.clock.fastForward(271_000);
  await expect.poll(() => playbackCalls).toBeGreaterThan(1);
});

test("expired playback authorization requests a new URL after 403", async ({ page }) => {
  await page.route("**/channel.v1.ChannelService/GetChannel", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({
        channel: { id: "test-channel", slug: "example", title: "Example", isLive: true },
      }),
    }),
  );
  let playbackCalls = 0;
  await page.route("**/channel.v1.ChannelService/GetPlaybackUrl", (route) => {
    playbackCalls++;
    return route.fulfill({
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({
        url: `https://streamix-svc-media.fly.dev/hls/test-channel/index.m3u8?token=${playbackCalls}`,
        expiresAt: String(Math.floor(Date.now() / 1000) + 300),
      }),
    });
  });
  await page.route("**/hls/test-channel/**", (route) =>
    route.fulfill({
      status: route.request().url().includes("token=1") ? 403 : 200,
      contentType: "application/vnd.apple.mpegurl",
      headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n",
    }),
  );
  await page.goto("/watch/example");
  await expect(page.locator("video")).toBeVisible();
  await expect.poll(() => playbackCalls, { timeout: 10_000 }).toBeGreaterThan(1);
});

test("playback failure is not mislabeled as offline", async ({ page }) => {
  await page.route("**/channel.v1.ChannelService/GetChannel", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({
        channel: { id: "test-channel", slug: "example", title: "Example", isLive: true },
      }),
    }),
  );
  await page.route("**/channel.v1.ChannelService/GetPlaybackUrl", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({ code: "unavailable", message: "unavailable" }),
    }),
  );
  await page.goto("/watch/example");
  await expect(page.getByText("재생 연결에 실패했습니다.")).toBeVisible();
  await expect(page.getByText("오프라인 방송입니다")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
});

test("studio lookup failure does not offer to create a duplicate channel", async ({ page }) => {
  await mockSignedIn(page);
  await page.route("**/channel.v1.ChannelService/GetMyChannel", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 503,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ code: "unavailable", message: "unavailable" }),
    }),
  );
  await page.goto("/studio");
  await expect(page.getByText("채널 정보를 불러오지 못했습니다.", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "채널 만들고 스트림 키 받기" })).toHaveCount(0);
});

test("chat rate limit keeps the unsent draft and explains the failure", async ({ page }) => {
  await mockSignedIn(page);
  let sends = 0;
  await page.route("**/channel.v1.ChannelService/GetChannel", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify({
        channel: { id: "test-channel", slug: "example", title: "Example", isLive: false },
      }),
    }),
  );
  await page.routeWebSocket("**/ws?channelId=test-channel", (ws) => {
    ws.onMessage((payload) => {
      const message = JSON.parse(String(payload));
      if (message.type === "auth") ws.send(JSON.stringify({ type: "ready" }));
      if (message.type === "send") {
        sends++;
        ws.send(
          JSON.stringify(
            sends === 1
              ? { type: "error", code: "rate_limited" }
              : { id: "accepted", userId: "test-user", displayName: "Test", text: message.text },
          ),
        );
      }
    });
  });
  await page.goto("/watch/example");
  const input = page.getByPlaceholder("메시지 보내기");
  await expect(input).toBeEnabled();
  await input.fill("다시 보낼 메시지");
  await input.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "너무 빠르게" })).toBeVisible();
  await expect(input).toHaveValue("다시 보낼 메시지");
  await input.press("Enter");
  await expect(page.getByText("다시 보낼 메시지", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
});

test("stream-key rotation confirms first and copy failure is visible", async ({ page }) => {
  await mockSignedIn(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await page.route("**/channel.v1.ChannelService/GetMyChannel", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({
        channel: { id: "test-channel", slug: "example", title: "Example", isLive: false },
        streamKeyPrefix: "live_old",
        streamKeyIssuedAt: "1",
      }),
    }),
  );
  let rotations = 0;
  await page.route("**/channel.v1.ChannelService/RotateStreamKey", (route) => {
    if (route.request().method() === "POST") rotations++;
    return route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ streamKey: "live_new_test_key" }),
    });
  });
  await page.goto("/studio");
  const rotate = page.getByRole("button", { name: "스트림 키 재발급" });
  await expect(rotate).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await rotate.click();
  expect(rotations).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await rotate.click();
  await expect(page.getByText("live_new_test_key", { exact: true })).toBeVisible();
  expect(rotations).toBe(1);
  await page
    .getByText("스트림 키", { exact: true })
    .locator("..")
    .getByRole("button", { name: "복사" })
    .click();
  await expect(page.getByRole("alert").filter({ hasText: "복사 실패" })).toBeVisible();
});

test("authentication pages have distinct browser titles", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle("로그인 | Streamix");
  await page.goto("/signup");
  await expect(page).toHaveTitle("회원가입 | Streamix");
});

test("first-visit curtain exposes signup and does not repeat", async ({ page }) => {
  await page.goto("/");
  const skip = page.getByRole("button", { name: "로그인으로 바로 가기" });
  await expect(skip).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "회원가입 신청" })).toBeVisible();
  expect(
    await page
      .locator("#landing-email")
      .evaluate((input: HTMLInputElement) => input.labels?.length),
  ).toBe(1);
  await skip.click();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "그냥 둘러보기", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "지금 라이브" })).toBeVisible();
});

test("signup explains approval and does not attempt automatic login", async ({ page }) => {
  let logins = 0;
  await page.route("**/auth/register", (route) =>
    route.fulfill({
      status: 201,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ user: {} }),
    }),
  );
  await page.route("**/auth/login", (route) => {
    logins++;
    return route.fulfill({ status: 500, headers: cors });
  });
  await page.goto("/signup");
  await page.getByRole("textbox", { name: "닉네임" }).fill("신청자");
  await page.getByRole("textbox", { name: "이메일" }).fill("pending@example.com");
  await page.getByLabel("비밀번호").fill("Example!42");
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("관리자 승인 후 로그인");
  expect(logins).toBe(0);
});

test("admin can approve a pending signup", async ({ page }) => {
  await mockSignedIn(page, true);
  await page.route("**/user.v1.AuthService/ListPendingUsers", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({
        users: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            email: "new@example.com",
            displayName: "신청자",
          },
        ],
      }),
    }),
  );
  let approvals = 0;
  await page.route("**/user.v1.AuthService/ApproveUser", (route) => {
    if (route.request().method() === "POST") approvals++;
    return route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.goto("/admin");
  await expect(page.getByText("new@example.com")).toBeVisible();
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.getByText("대기 중인 가입 신청이 없습니다.")).toBeVisible();
  expect(approvals).toBe(1);
});
