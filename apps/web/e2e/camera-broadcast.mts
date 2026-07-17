// Browser broadcast E2E: login -> studio -> 방송시작 (fake capture) -> 송출 중 ->
// a viewer at /watch/<slug> plays (currentTime advances) -> 방송 종료 -> offline.
//
// The gate is viewer playback. The manifest/segment fetch is a secondary
// assertion only: a manifest listing segments is not proof anything played.
//
// Run (from apps/svc-media, which has playwright + tsx):
//   WEB=… EMAIL=… PASSWORD=… SLUG=… pnpm exec tsx ../web/e2e/camera-broadcast.mts
// Required env: WEB, EMAIL, PASSWORD, SLUG (no defaults — see e2e/README.md).
// Optional: BFF_URL (defaults to prod), SOURCE(camera|screen), MOBILE(1),
// DEVICE_ID(index into the detailed camera list).
import { chromium, devices as playwrightDevices, type Browser } from "@playwright/test";
import { requiredEnv, viewerPlaybackAdvances } from "./lib.mts";

const WEB = requiredEnv("WEB");
const EMAIL = requiredEnv("EMAIL");
const PASSWORD = requiredEnv("PASSWORD");
const SLUG = requiredEnv("SLUG");
const SOURCE = (process.env.SOURCE ?? "camera") as "camera" | "screen";
const MOBILE = process.env.MOBILE === "1";
// Index into the detailed camera list; empty = front/back preset (default).
const DEVICE_ID = process.env.DEVICE_ID ?? "";
const bff = process.env.BFF_URL ?? "https://streamix-bff.fly.dev";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function channelLive(): Promise<boolean> {
  const r = await fetch(`${bff}/channel.v1.ChannelService/GetChannel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: SLUG }),
  });
  return (await r.json()).channel?.isLive ?? false;
}

// Fake media: --use-fake-device-for-media-stream feeds a synthetic camera/mic;
// --use-fake-ui-for-media-stream auto-accepts the permission prompt. Screen
// source additionally needs an auto-selected desktop capture source.
// device-count=3 makes Chromium's fake factory expose three cameras, so the
// detailed picker has something to choose between (M0 S1).
const args = [
  DEVICE_ID
    ? "--use-fake-device-for-media-stream=device-count=3"
    : "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  // The viewer runs in its own browser process, which can still occlude this
  // window; Chromium would then throttle MediaRecorder and stall the stream (R3).
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
if (SOURCE === "screen") args.push("--auto-select-desktop-capture-source=Entire screen");

let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: false, args });
  const context = await browser.newContext(MOBILE ? { ...playwrightDevices["Pixel 5"] } : {});
  // Spy on the video constraints the app actually asks for, so D1 can prove the
  // picked deviceId reached getUserMedia (a fake camera looks identical on screen).
  await context.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) => {
      (window as unknown as { __videoConstraint?: unknown }).__videoConstraint = c?.video;
      return orig(c);
    };
  });

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
  try {
    await page.waitForURL(`${WEB}/`, { timeout: 15000 });
  } catch {
    const err = await page
      .locator("p.text-live, [role=alert]")
      .first()
      .textContent()
      .catch(() => null);
    console.error(`FAIL login as ${EMAIL} — ${err ?? "no redirect"}. Wrong creds for this target?`);
    process.exit(2);
  }
  check("login", true);

  await page.goto(`${WEB}/studio`);

  // Pick source (camera is default; click the screen tab only when testing it).
  if (SOURCE === "screen") await page.getByRole("button", { name: "화면" }).click();

  // D1: expand the detailed camera list and pick the n-th camera (option 0 is the
  // front/back preset, so cameras start at index 1).
  let pickedDeviceId = "";
  if (DEVICE_ID) {
    await page.getByRole("button", { name: "카메라 더 보기" }).click();
    const select = page.getByLabel("카메라");
    await select.selectOption({ index: Number(DEVICE_ID) + 1 });
    pickedDeviceId = await select.inputValue();
    check("detailed camera selected", !!pickedDeviceId, pickedDeviceId.slice(0, 8));
  }

  await page.getByRole("button", { name: "방송시작" }).click();
  try {
    await page.getByText("송출 중").waitFor({ timeout: 20000 });
    check(`broadcasting state (source=${SOURCE}, mobile=${MOBILE})`, true);
  } catch {
    const err = await page
      .locator("p.text-live")
      .first()
      .textContent()
      .catch(() => null);
    check("broadcasting state", false, `error shown: ${err}`);
    throw new Error("cannot continue without a live broadcast");
  }

  if (DEVICE_ID) {
    const vc = (await page.evaluate(
      () => (window as unknown as { __videoConstraint?: unknown }).__videoConstraint,
    )) as { deviceId?: { exact?: string } } | undefined;
    check(
      "deviceId constraint reached getUserMedia",
      vc?.deviceId?.exact === pickedDeviceId,
      JSON.stringify(vc),
    );
  }

  // Server-side liveness (not just the broadcaster UI).
  let live = false;
  for (let i = 0; i < 20 && !live; i++) {
    live = await channelLive();
    if (!live) await sleep(2000);
  }
  check("channel live", live);

  // THE gate: a real viewer plays the stream.
  check("viewer playback advances at /watch", await viewerPlaybackAdvances(WEB, SLUG));

  await page.getByRole("button", { name: "방송 종료" }).click();
  let offline = false;
  for (let i = 0; i < 20 && !offline; i++) {
    await sleep(2000);
    offline = !(await channelLive());
  }
  check("offline transition", offline);
} finally {
  await browser?.close().catch(() => {});
}

process.exit(results.every(([, ok]) => ok) ? 0 : 1);
