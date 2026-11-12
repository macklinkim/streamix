// Run from repository root: node docs/assets/ux-ui-review-2026-10-20/run.cjs <axe.min.js>
// Requires the existing web workspace dependencies and localhost:3000. All API writes are mocked.
const { chromium, expect } = require("../../../apps/web/node_modules/@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const output = __dirname;
const axePath = process.argv[2];
if (!axePath) throw new Error("Pass a local axe-core axe.min.js path");
const cors = {
  "access-control-allow-origin": "http://localhost:3000",
  "access-control-allow-credentials": "true",
};
const channel = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerUserId: "owner",
  slug: "review-channel",
  title: "긴 한글 방송 제목으로 방송과 채팅 관리의 실제 배치를 확인합니다",
  isLive: false,
  viewerCount: 3,
};
const results = {
  environment: "localhost:3000, mocked REST/Connect/WebSocket, fake camera",
  scans: [],
  checks: [],
  console: [],
  network5xx: [],
};
let browser;
async function main() {
  browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  results.browser = browser.version();
  async function setup(role, viewport = { width: 1920, height: 1080 }, landing = false) {
    const context = await browser.newContext({ viewport, permissions: ["camera", "microphone"] });
    if (!landing)
      await context.addCookies([
        { name: "streamix_landing_seen", value: "1", url: "http://localhost:3000" },
      ]);
    const page = await context.newPage();
    page.on("console", (m) => {
      if (["warning", "error"].includes(m.type()))
        results.console.push({
          role,
          type: m.type(),
          text: m.text().replace(/https?:\/\/\S+/g, "[URL]"),
        });
    });
    page.on("response", (r) => {
      if (r.status() >= 500)
        results.network5xx.push({ role, status: r.status(), url: r.url().split("?")[0] });
    });
    await page.route("**/auth/refresh", (r) =>
      r.fulfill({
        status: role === "guest" ? 401 : 200,
        headers: cors,
        json: { accessToken: "mock-review" },
      }),
    );
    await page.route("**/user.v1.AuthService/Me", (r) =>
      r.fulfill({
        headers: cors,
        json: {
          user: {
            id: "owner",
            email: "review@example.invalid",
            displayName: "리뷰 방송자",
            isAdmin: role === "admin",
          },
        },
      }),
    );
    await page.route("**/channel.v1.ChannelService/**", (r) => {
      const method = r.request().url().split("/").at(-1);
      const json =
        method === "ListLive"
          ? { channels: [] }
          : method === "IssueIngestToken"
            ? { token: "mock-ingest" }
            : { channel };
      return r.fulfill({
        status: r.request().method() === "OPTIONS" ? 204 : 200,
        headers: cors,
        json,
      });
    });
    await page.route("**/user.v1.AuthService/ListPendingUsers", (r) =>
      r.fulfill({
        headers: cors,
        json: {
          users: [
            { id: "pending", email: "pending@example.invalid", displayName: "승인 대기 사용자" },
          ],
        },
      }),
    );
    await page.route("**/chat.v1.ChatService/Moderate", (r) =>
      r.fulfill({ headers: cors, json: {} }),
    );
    let socket;
    await page.routeWebSocket(/\/ws\?channelId=/, (s) => {
      socket = s;
      s.onMessage((data) => {
        const m = JSON.parse(String(data));
        if (m.type === "auth") {
          s.send(JSON.stringify({ type: "ready" }));
          s.send(
            JSON.stringify({
              id: "first",
              userId: "00000000-0000-4000-8000-000000000002",
              displayName: "시청자",
              text: "방송 잘 보여요",
            }),
          );
        }
      });
    });
    let frames = 0,
      closed = false;
    await page.routeWebSocket(/\/ingest\?/, (s) => {
      s.onMessage(() => frames++);
      s.onClose(() => (closed = true));
    });
    return {
      page,
      context,
      send: (m) => socket.send(JSON.stringify(m)),
      frames: () => frames,
      closed: () => closed,
    };
  }
  async function scan(page, name) {
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    await page.addScriptTag({ path: axePath });
    const scan = await page.evaluate(async () => {
      const r = await axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      });
      return {
        version: r.testEngine.version,
        violations: r.violations,
        incomplete: r.incomplete.map((x) => ({
          id: x.id,
          impact: x.impact,
          nodes: x.nodes.map((n) => n.target),
        })),
      };
    });
    const geometry = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    results.scans.push({ name, ...geometry, ...scan });
    await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
  }
  for (const width of [1920, 768, 375, 390, 1023, 1024, 320]) {
    const t = await setup("guest", {
      width,
      height: width === 768 ? 1024 : width < 768 ? 667 : 1080,
    });
    await t.page.goto("http://localhost:3000/signup");
    await expect(t.page.getByRole("button", { name: "회원가입", exact: true })).toBeVisible();
    if ([1920, 768, 375, 320].includes(width)) await scan(t.page, "signup-" + width);
    results.checks.push({
      name: "signup horizontal reflow " + width,
      pass: await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    });
    await t.context.close();
  }
  const landing = await setup("guest", { width: 375, height: 667 }, true);
  await landing.page.goto("http://localhost:3000");
  await landing.page.getByRole("button", { name: "로그인으로 바로 가기" }).click();
  await expect(landing.page.getByLabel("아이디", { exact: true })).toBeFocused();
  await scan(landing.page, "landing-375");
  results.checks.push({
    name: "landing browse geometry before focus scroll",
    box: await landing.page.getByRole("button", { name: "그냥 둘러보기" }).boundingBox(),
  });
  await landing.page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(landing.page.getByText("비밀번호는 8자 이상", { exact: true })).toBeVisible();
  await landing.page.screenshot({
    path: path.join(output, "landing-errors-375.png"),
    fullPage: true,
  });
  await landing.page.setViewportSize({ width: 320, height: 568 });
  await landing.page.screenshot({
    path: path.join(output, "landing-errors-320.png"),
    fullPage: true,
  });
  results.checks.push({
    name: "landing narrow error reflow",
    title: await landing.page.getByRole("heading", { name: "STREAMIX" }).boundingBox(),
    browse: await landing.page.getByRole("button", { name: "그냥 둘러보기" }).boundingBox(),
    viewportHeight: 568,
  });
  await landing.page.getByLabel("아이디", { exact: true }).press("Escape");
  results.checks.push({
    name: "landing Escape closes dialog",
    pass: (await landing.page.getByRole("dialog").count()) === 0,
  });
  await landing.context.close();
  const guest = await setup("guest");
  for (const [url, name] of [
    ["/", "home-empty"],
    ["/login", "login"],
    ["/watch/review-channel", "watch-offline"],
    ["/admin", "admin-guest"],
  ]) {
    await guest.page.goto("http://localhost:3000" + url);
    await expect(
      guest.page.getByRole("link", { name: "로그인", exact: true }).first(),
    ).toBeVisible();
    if (url.includes("watch"))
      await expect(guest.page.getByText("오프라인 방송입니다")).toBeVisible();
    await scan(guest.page, name);
  }
  await guest.page.route("**/auth/login", (r) =>
    r.fulfill({ status: 503, headers: cors, json: { error: "service unavailable" } }),
  );
  await guest.page.goto("http://localhost:3000/login");
  await guest.page.getByLabel("이메일", { exact: true }).fill("review@example.invalid");
  await guest.page.getByLabel("비밀번호", { exact: true }).fill("mock-review-only");
  await guest.page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(guest.page.locator('main [role="alert"]')).toBeVisible();
  results.checks.push({
    name: "login 503 feedback",
    text: await guest.page.locator('main [role="alert"]').innerText(),
  });
  await guest.page.screenshot({
    path: path.join(output, "login-service-error.png"),
    fullPage: true,
  });
  await guest.context.close();
  const admin = await setup("admin", { width: 375, height: 667 });
  await admin.page.goto("http://localhost:3000/admin");
  await expect(admin.page.getByRole("button", { name: "승인", exact: true })).toBeVisible();
  await scan(admin.page, "admin-pending-375");
  await admin.context.close();
  const owner = await setup("owner");
  await owner.page.goto("http://localhost:3000/studio/live");
  await expect(owner.page.getByRole("heading", { name: "방송 관리", exact: true })).toBeVisible();
  await scan(owner.page, "studio-ready");
  await owner.page.getByRole("button", { name: "송출 시작", exact: true }).click();
  await expect.poll(owner.frames).toBeGreaterThan(1);
  await scan(owner.page, "studio-live");
  await owner.page.getByLabel("슬로우모드").selectOption("10");
  await expect(owner.page.getByRole("status")).toContainText("10초로 설정");
  results.checks.push({
    name: "slowmode value after successful setting",
    value: await owner.page.getByLabel("슬로우모드").inputValue(),
  });
  for (let i = 0; i < 80; i++)
    owner.send({
      id: "m" + i,
      userId: "viewer",
      displayName: "긴 닉네임 시청자",
      text: "긴 메시지 ".repeat(8) + i,
    });
  const log = owner.page.getByRole("log");
  await expect(log).toContainText("79");
  await log.evaluate((el) => (el.scrollTop = 0));
  const before = await log.evaluate((el) => el.scrollTop);
  owner.send({ id: "last", userId: "viewer", displayName: "시청자", text: "새 메시지 도착" });
  await expect(log).toContainText("새 메시지 도착");
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  results.checks.push({
    name: "reading old messages interrupted",
    before,
    after: await log.evaluate((el) => el.scrollTop),
  });
  await owner.page.screenshot({ path: path.join(output, "chat-new-message.png"), fullPage: true });
  let dialog = false;
  owner.page.on("dialog", async (d) => {
    dialog = true;
    await d.dismiss();
  });
  await owner.page.getByRole("link", { name: "스튜디오", exact: true }).click();
  await expect(owner.page).toHaveURL(/\/studio$/);
  await expect.poll(owner.closed).toBe(true);
  results.checks.push({
    name: "header studio navigation stops stream",
    closed: owner.closed(),
    confirmationShown: dialog,
  });
  await scan(owner.page, "studio-settings");
  await owner.page.setViewportSize({ width: 375, height: 667 });
  await owner.page.goto("http://localhost:3000/studio/live");
  await expect(owner.page.getByRole("heading", { name: "방송 관리", exact: true })).toBeVisible();
  await scan(owner.page, "studio-ready-375");
  await owner.page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await owner.page.screenshot({
    path: path.join(output, "studio-forced-colors.png"),
    fullPage: true,
  });
  await owner.context.close();
  await browser.close();
}
main()
  .catch((e) => {
    results.error = String(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    await fs.writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  });
