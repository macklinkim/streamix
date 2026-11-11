import { test, expect } from "@playwright/test";

test.use({
  permissions: ["camera", "microphone"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

const channelId = "00000000-0000-4000-8000-000000000001";
const viewerId = "00000000-0000-4000-8000-000000000002";
const cors = {
  "access-control-allow-origin": "http://localhost:3000",
  "access-control-allow-credentials": "true",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/refresh", (route) =>
    route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "owner-token" }),
    }),
  );
  await page.route("**/user.v1.AuthService/Me", (route) =>
    route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "owner", email: "owner@example.com", displayName: "방송자" },
      }),
    }),
  );
  await page.route("**/channel.v1.ChannelService/ListLive", (route) =>
    route.fulfill({ headers: cors, contentType: "application/json", body: '{"channels":[]}' }),
  );
  await page.route("**/channel.v1.ChannelService/GetMyChannel", (route) =>
    route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({
        channel: {
          id: channelId,
          ownerUserId: "owner",
          slug: "my-channel",
          title: "테스트 방송",
          isLive: false,
          viewerCount: 3,
        },
      }),
    }),
  );
  await page.route("**/channel.v1.ChannelService/IssueIngestToken", (route) =>
    route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: '{"token":"test-ingest"}',
    }),
  );
  await page.routeWebSocket(/\/ws\?channelId=/, (socket) => {
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message));
      if (payload.type === "auth") {
        // The server tells each socket its chat role (benchmark M3); the owner's
        // room is the broadcaster, which unlocks the moderation panel.
        socket.send(JSON.stringify({ type: "ready", role: "broadcaster" }));
        socket.send(
          JSON.stringify({
            id: "viewer-message",
            userId: viewerId,
            displayName: "시청자",
            text: "방송 잘 보여요",
          }),
        );
      } else if (payload.type === "send") {
        socket.send(
          JSON.stringify({
            id: "owner-message",
            userId: "owner",
            displayName: "방송자",
            text: payload.text,
          }),
        );
      }
    });
  });
});

test("starting opens the management screen without interrupting capture; moderation and stopping work", async ({
  page,
  context,
}, testInfo) => {
  let frames = 0;
  let ingestClosed = false;
  await page.routeWebSocket(/\/ingest\?/, (socket) => {
    socket.onMessage(() => {
      frames++;
    });
    socket.onClose(() => {
      ingestClosed = true;
    });
  });
  const requests: Record<string, unknown>[] = [];
  await page.route("**/chat.v1.ChatService/Moderate", (route) => {
    if (route.request().method() !== "OPTIONS") requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: route.request().method() === "OPTIONS" ? 204 : 200,
      headers: cors,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto("/studio");
  await expect(page.locator("video")).toHaveCount(0);
  await page.getByRole("button", { name: "방송시작", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/live$/);
  await expect(page.getByRole("heading", { name: "방송 관리", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "방송 채팅 관리" })).toBeVisible();
  expect(frames).toBe(0);
  await page.getByRole("button", { name: "송출 시작", exact: true }).click();
  await expect(page.getByRole("button", { name: "방송 종료" })).toBeVisible();
  await expect(page.getByText("방송 잘 보여요")).toBeVisible();
  await expect(page.getByText("시청자 3명")).toBeVisible();
  await expect(page.getByRole("link", { name: /내 방송 보기/ })).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(page.getByRole("link", { name: /내 방송 보기/ })).toHaveAttribute(
    "href",
    "/watch/my-channel",
  );
  await expect(page.getByRole("heading", { name: "비밀번호 변경" })).toHaveCount(0);
  await expect.poll(() => frames).toBeGreaterThan(1);
  const streamId = await page
    .locator("video")
    .evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).id);
  const previousFrames = frames;

  await context.route("**/channel.v1.ChannelService/GetChannel", (route) =>
    route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({
        channel: { id: channelId, slug: "my-channel", title: "테스트 방송", isLive: true },
      }),
    }),
  );
  await context.route("**/channel.v1.ChannelService/GetPlaybackUrl", (route) =>
    route.fulfill({
      status: 503,
      headers: cors,
      contentType: "application/json",
      body: '{"code":"unavailable","message":"mock media"}',
    }),
  );
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: /내 방송 보기/ }).click();
  const viewer = await popup;
  await expect(viewer).toHaveURL(/\/watch\/my-channel$/);
  await expect(viewer.getByRole("heading", { name: "테스트 방송", exact: true })).toBeVisible();
  await viewer.close();
  await expect(page).toHaveURL(/\/studio\/live$/);
  await expect.poll(() => frames).toBeGreaterThan(previousFrames);

  await page.getByRole("textbox", { name: "채팅 메시지" }).fill("반갑습니다");
  await page.getByRole("button", { name: "전송", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("반갑습니다");
  await page.getByRole("button", { name: "시청자 채팅 관리" }).click();
  await page.getByRole("button", { name: "10분 채팅 금지" }).click();
  await expect(page.getByRole("status")).toContainText("10분간 금지");
  expect(requests.at(-1)).toMatchObject({
    channelId,
    targetUserId: viewerId,
    action: "MODERATION_ACTION_BAN",
    durationSeconds: 600,
  });
  await page.getByRole("button", { name: "금지 해제", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("금지를 해제");
  expect(requests.at(-1)).toMatchObject({ action: "MODERATION_ACTION_UNBAN" });
  await page.getByLabel("슬로우모드").selectOption("10");
  await expect(page.getByRole("status")).toContainText("10초로 설정");
  expect(requests.at(-1)).toMatchObject({
    action: "MODERATION_ACTION_SLOWMODE",
    durationSeconds: 10,
  });
  await expect.poll(() => frames).toBeGreaterThan(previousFrames);
  expect(
    await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).id),
  ).toBe(streamId);
  expect(
    await page
      .locator("video")
      .evaluate((video: HTMLVideoElement) =>
        (video.srcObject as MediaStream).getTracks().every((track) => track.readyState === "live"),
      ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("studio-management.png"), fullPage: true });

  await page.getByRole("button", { name: "방송 종료" }).click();
  await expect(page.getByRole("heading", { name: "방송 관리", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "송출 시작", exact: true })).toBeEnabled();
  await expect(page.getByRole("region", { name: "방송 채팅 관리" })).toBeVisible();
  await expect.poll(() => ingestClosed).toBe(true);
  expect(
    await page.locator("video").evaluate((video: HTMLVideoElement) => video.srcObject),
  ).toBeNull();
});

test("mobile management remains usable and reports moderation failures", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.routeWebSocket(/\/ingest\?/, () => {});
  await page.route("**/chat.v1.ChatService/Moderate", (route) =>
    route.fulfill({
      status: 403,
      headers: cors,
      contentType: "application/json",
      body: '{"code":"permission_denied","message":"channel owner required"}',
    }),
  );
  await page.goto("/studio");
  await page.getByRole("button", { name: "방송시작", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/live$/);
  await expect(page.getByRole("heading", { name: "방송 관리", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "송출 시작", exact: true }).click();
  await expect(page.getByRole("button", { name: "방송 종료" })).toBeVisible();
  await page.getByRole("button", { name: "시청자 채팅 관리" }).click();
  await page.getByRole("button", { name: "10분 채팅 금지" }).click();
  await expect(
    page.getByRole("region", { name: "방송 채팅 관리" }).getByRole("alert"),
  ).toContainText("변경하지 못했습니다");
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("studio-management-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "방송 종료" }).click();
});

test("camera permission failure stays in the dedicated room with chat available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    };
  });
  await page.goto("/studio");
  await page.getByRole("button", { name: "방송시작", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/live$/);
  await page.getByRole("button", { name: "송출 시작", exact: true }).click();
  await expect(
    page.getByText("카메라·마이크 권한이 거부되었습니다.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "방송 관리", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "방송 채팅 관리" })).toBeVisible();
  await expect(page.getByRole("button", { name: "송출 시작", exact: true })).toBeEnabled();
});

test("the dedicated room requires a login", async ({ page }) => {
  await page.route("**/auth/refresh", (route) => route.fulfill({ status: 401, headers: cors }));
  await page.goto("/studio/live");
  await expect(page.getByRole("link", { name: "로그인하기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "송출 시작", exact: true })).toHaveCount(0);
});

test("a missing channel links back to channel creation", async ({ page }) => {
  await page.route("**/channel.v1.ChannelService/GetMyChannel", (route) =>
    route.fulfill({ headers: cors, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/studio/live");
  await expect(page.getByRole("link", { name: "채널 만들기", exact: true })).toHaveAttribute(
    "href",
    "/studio",
  );
  await expect(page.getByRole("button", { name: "송출 시작", exact: true })).toHaveCount(0);
});
