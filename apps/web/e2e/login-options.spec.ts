import { test, expect } from "@playwright/test";

const cors = {
  "access-control-allow-origin": "http://localhost:3000",
  "access-control-allow-credentials": "true",
};
const user = {
  id: "test-user",
  email: "saved@example.com",
  displayName: "저장사용자",
  isAdmin: false,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/refresh", (route) => route.fulfill({ status: 401, headers: cors }));
  await page.route("**/channel.v1.ChannelService/ListLive", (route) =>
    route.fulfill({ headers: cors, contentType: "application/json", body: '{"channels":[]}' }),
  );
});

test("successful login stores only the opted-in email and pre-fills it on the next visit", async ({
  page,
}) => {
  let body: Record<string, unknown> = {};
  await page.route("**/auth/login", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "memory-token", user }),
    });
  });
  await page.goto("/login");
  await expect(page.getByLabel("아이디 저장")).not.toBeChecked();
  await expect(page.getByLabel("자동 로그인")).not.toBeChecked();
  await page.getByRole("textbox", { name: "이메일" }).fill(user.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("Example!42");
  await page.getByLabel("아이디 저장").check();
  await page.getByLabel("자동 로그인").check();
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  expect(body.rememberMe).toBe(true);
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({
    streamix_saved_email: user.email,
  });
  await page.goto("/login");
  await expect(page.getByRole("textbox", { name: "이메일" })).toHaveValue(user.email);
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("아이디 저장")).toBeChecked();
  await page.getByLabel("아이디 저장").uncheck();
  expect(await page.evaluate(() => localStorage.getItem("streamix_saved_email"))).toBeNull();
});

test("landing login shares saved email and sends automatic-login opt-out", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("streamix_saved_email", "saved@example.com"));
  let body: Record<string, unknown> = {};
  await page.route("**/auth/login", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "memory-token", user }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "로그인으로 바로 가기" }).click();
  await expect(page.getByLabel("아이디", { exact: true })).toHaveValue(user.email);
  await expect(page.getByLabel("아이디 저장")).toBeChecked();
  await expect(page.getByLabel("자동 로그인")).not.toBeChecked();
  await page.getByLabel("비밀번호", { exact: true }).fill("Example!42");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(body.rememberMe).toBe(false);
});

test("failed login does not save an entered email", async ({ page }) => {
  await page.route("**/auth/login", (route) =>
    route.fulfill({
      status: 401,
      headers: cors,
      contentType: "application/json",
      body: '{"error":"invalid credentials"}',
    }),
  );
  await page.goto("/login");
  await page.getByRole("textbox", { name: "이메일" }).fill("failed@example.com");
  await page.getByLabel("비밀번호", { exact: true }).fill("Example!42");
  await page.getByLabel("아이디 저장").check();
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "올바르지 않습니다" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("streamix_saved_email"))).toBeNull();
});

test("automatic session restoration skips the landing; logout clears auth but keeps a saved email", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("streamix_saved_email", "saved@example.com"));
  let signedIn = true;
  await page.route("**/auth/refresh", (route) =>
    route.fulfill({
      status: signedIn ? 200 : 401,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "restored-token" }),
    }),
  );
  await page.route("**/user.v1.AuthService/Me", (route) =>
    route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ user }),
    }),
  );
  await page.route("**/auth/logout", (route) => {
    signedIn = false;
    return route.fulfill({ status: 204, headers: cors });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await page.reload();
  await expect(page.getByRole("link", { name: "로그인", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "로그아웃" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("streamix_saved_email"))).toBe(user.email);
});

test("storage restrictions do not prevent signing in", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("storage blocked");
      },
    }),
  );
  await page.route("**/auth/login", (route) =>
    route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ accessToken: "memory-token", user }),
    }),
  );
  await page.goto("/login");
  await page.getByRole("textbox", { name: "이메일" }).fill(user.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("Example!42");
  await page.getByLabel("아이디 저장").check();
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
});
