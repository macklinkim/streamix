// D3 (ADR-15 dual detection) + D2-b (RTMP card on a phone viewport).
//
// Three independently-failing cases:
//   A  getDisplayMedia absent      -> screen disabled + RTMP notice
//   B  present but always rejects  -> after 방송시작, screen blocked + camera
//                                     restored + RTMP notice (not silent idle)
//   C  desktop, user cancels       -> stays cancellable; must NOT be misread as
//                                     unsupported (screen stays enabled)
//
// Case A also carries D2-b: the card renders and copies at exactly 390px.
//
// Run (from apps/svc-media):
//   WEB=… EMAIL=… PASSWORD=… pnpm exec tsx ../web/e2e/screen-fallback.mts
// Required env: WEB, EMAIL, PASSWORD.
//
// Side effects on the target: case A rotates that account's durable stream key
// (the plaintext key only exists in-session, and the full-URL row needs it), so
// any OBS profile using the old key stops working. Use a smoke account.
import { chromium, devices as playwrightDevices, type Browser } from "@playwright/test";
import { requiredEnv } from "./lib.mts";

const WEB = requiredEnv("WEB");
const EMAIL = requiredEnv("EMAIL");
const PASSWORD = requiredEnv("PASSWORD");

const results: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function studioPage(browser: Browser, mobile: boolean, init?: () => void) {
  const context = await browser.newContext(
    mobile
      ? // Pixel 5's own width is 393; the gate says 390, so set it explicitly
        // rather than letting the device preset decide.
        { ...playwrightDevices["Pixel 5"], viewport: { width: 390, height: 844 } }
      : { permissions: [] },
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto(`${WEB}/login`);
  await page.getByRole("textbox", { name: "이메일" }).fill(EMAIL);
  await page.getByRole("textbox", { name: "비밀번호" }).fill(PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  try {
    await page.waitForURL(`${WEB}/`, { timeout: 15000 });
  } catch {
    console.error(`FAIL login as ${EMAIL}. Wrong creds for ${WEB}?`);
    process.exit(2);
  }
  await page.goto(`${WEB}/studio`);
  await page.getByRole("button", { name: "방송시작" }).waitFor({ timeout: 20000 });
  return page;
}

let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: false,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });

  // ---- Case A: API absent (a phone browser that never shipped it) ----
  {
    const page = await studioPage(browser, true, () => {
      // @ts-expect-error - reproducing a browser without the API
      delete MediaDevices.prototype.getDisplayMedia;
    });

    check(
      "A: viewport is exactly 390px",
      (await page.evaluate(() => window.innerWidth)) === 390,
      `innerWidth=${await page.evaluate(() => window.innerWidth)}`,
    );

    const screenBtn = page.getByRole("button", { name: "화면" });
    check("A: screen source disabled", await screenBtn.isDisabled());
    check(
      "A: rtmp fallback notice shown",
      await page.getByText("이 브라우저는 화면 송출을 지원하지 않습니다").isVisible(),
    );

    // D2-b: the card needs an in-session plaintext key for the full-URL row.
    await page.getByRole("button", { name: "스트림 키 재발급" }).click();
    const fullUrlRow = page.getByText("전체 URL (한 줄 입력 장비용)");
    await fullUrlRow.waitFor({ timeout: 15000 });
    check("A/D2-b: full url row visible", await fullUrlRow.isVisible());

    const copyBtn = page.getByRole("button", { name: "복사" }).last();
    check("A/D2-b: copy button visible", await copyBtn.isVisible());
    await copyBtn.click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check("A/D2-b: full rtmp url copied", /^rtmps?:\/\/.+\/live\/.+/.test(copied));

    // Real overflow checks, not a heading's bounding box.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement.scrollWidth;
      const card = document.querySelector("#rtmp") as HTMLElement | null;
      return { doc, inner: window.innerWidth, card: card?.scrollWidth ?? 0, cardW: card?.clientWidth ?? 0 };
    });
    check(
      "A/D2-b: page does not scroll horizontally",
      overflow.doc <= overflow.inner,
      `scrollWidth=${overflow.doc} innerWidth=${overflow.inner}`,
    );
    check(
      "A/D2-b: rtmp card does not overflow itself",
      overflow.card <= overflow.cardW,
      `card scrollWidth=${overflow.card} clientWidth=${overflow.cardW}`,
    );

    // Key must not land in client storage even after reveal/copy (M2 invariant).
    const leaked = await page.evaluate(() => {
      const hay = JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + document.cookie;
      return hay.includes("live_");
    });
    check("A: key not persisted to client storage", !leaked);
    await page.context().close();
  }

  // ---- Case B: API present but always rejects (Chrome Android history) ----
  {
    const page = await studioPage(browser, true, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (MediaDevices.prototype as any).getDisplayMedia = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });

    const screenBtn = page.getByRole("button", { name: "화면" });
    check("B: screen source initially offered (API present)", await screenBtn.isEnabled());
    await screenBtn.click();
    await page.getByRole("button", { name: "방송시작" }).click();

    // The bug this replaces: a silent return to idle with nothing shown.
    const notice = page.getByText("이 브라우저는 화면 송출을 지원하지 않습니다");
    let noticed = false;
    try {
      await notice.waitFor({ timeout: 10000 });
      noticed = true;
    } catch {
      /* stays false */
    }
    check("B: rtmp fallback notice after rejected call", noticed);
    check("B: screen source now disabled", await screenBtn.isDisabled());
    check(
      "B: source fell back to camera",
      (await page
        .getByRole("button", { name: "카메라", exact: true })
        .getAttribute("class"))?.includes("border-accent") ?? false,
    );
    await page.context().close();
  }

  // ---- Case C: desktop cancel must stay a cancel ----
  {
    const page = await studioPage(browser, false, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (MediaDevices.prototype as any).getDisplayMedia = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    });

    const screenBtn = page.getByRole("button", { name: "화면" });
    await screenBtn.click();
    await page.getByRole("button", { name: "방송시작" }).click();
    await page.waitForTimeout(3000);

    check("C: desktop cancel keeps screen enabled", await screenBtn.isEnabled());
    check(
      "C: desktop cancel shows no unsupported notice",
      !(await page.getByText("이 브라우저는 화면 송출을 지원하지 않습니다").isVisible()),
    );
    check(
      "C: desktop cancel shows no error",
      !(await page.locator("p.text-live").first().isVisible().catch(() => false)),
    );
    await page.context().close();
  }
} finally {
  await browser?.close().catch(() => {});
}

process.exit(results.every(([, ok]) => ok) ? 0 : 1);
