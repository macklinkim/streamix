// Full UI E2E on prod: login -> studio -> rotate key -> click 화면 공유 시작
// (fake display capture) -> verify 송출 중 -> watch page shows live playback.
//
// STALE: the 화면 공유 시작 button no longer exists — the studio was reworked to a
// single 방송시작 control (2861367). camera-broadcast.mts supersedes this script;
// see 작업계획서-모바일방송.md §10 before reviving it.
//
// Usage: WEB=… EMAIL=… PASSWORD=… pnpm exec tsx apps/web/e2e/broadcast-prod.mts
import { chromium } from "@playwright/test";

const WEB = process.env.WEB ?? "https://streamix-web.vercel.app";
// Credentials come from the environment — never committed.
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("FAIL (config) missing required env EMAIL/PASSWORD");
  process.exit(2);
}

const browser = await chromium.launch({
  headless: false,
  args: ["--auto-select-desktop-capture-source=Entire screen", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage();
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
await page.getByRole("button", { name: "스트림 키 재발급" }).click();
await page.getByText("이 키는 지금만 표시됩니다").waitFor({ timeout: 15000 });
console.log("PASS rotate key via ui");

await page.getByRole("button", { name: "화면 공유 시작" }).click();
try {
  await page.getByText("송출 중").waitFor({ timeout: 20000 });
  console.log("PASS broadcasting state");
} catch {
  const err = await page
    .locator("p.text-live")
    .first()
    .textContent()
    .catch(() => null);
  console.log("FAIL broadcasting state; error shown:", err);
  await browser.close();
  process.exit(1);
}

// Hold the broadcast; watch from a second tab like a viewer.
const viewer = await browser.newPage();
viewer.on("console", (msg) => {
  if (msg.type() === "error") console.log("viewer console error:", msg.text());
});
viewer.on("response", (res) => {
  if (res.url().includes(".m3u8")) console.log("m3u8:", res.status());
});
await viewer.goto(`${WEB}/watch/ingest-prod-smoke`);
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

// Broadcaster still healthy after ~1min?
const stillLive = await page
  .getByText("송출 중")
  .isVisible()
  .catch(() => false);
console.log(stillLive ? "PASS broadcast held" : "FAIL broadcast dropped");

await page.getByRole("button", { name: "방송 종료" }).click();
console.log("stopped broadcast");
await browser.close();
process.exit(advancing && stillLive ? 0 : 1);
