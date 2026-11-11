// Real-stack browser check for the Twitch benchmark (M2-M5): a real RTMP push,
// a viewer and a broadcaster in SEPARATE browser processes (a second tab in the
// broadcaster's browser gets throttled, see lib.mts), real BFF/core/chat/media.
//
// Run (from apps/svc-media, local stack up, svc-media with ABR_ENABLED=true):
//   pnpm exec tsx ../web/e2e/benchmark-browser.mts
// Optional env: WEB (default http://localhost:3000), BFF (default :8080).
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page } from "@playwright/test";
import { loginViaUi, reportError } from "./lib.mts";

const WEB = process.env.WEB ?? "http://localhost:3000";
const BFF = process.env.BFF ?? "http://localhost:8080";
// ffmpeg-static lives in svc-media (this script runs from there).
const ffmpeg = createRequire(`${process.cwd()}/package.json`)("ffmpeg-static") as string;
const run = Date.now().toString(36);
const PASSWORD = "Browser!Pass-2026";
const results: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, body: object, token?: string) {
  const r = await fetch(`${BFF}/channel.v1.ChannelService/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      origin: WEB,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return (await r.json()) as Record<string, any>;
}
async function auth(path: string, body: object) {
  const r = await fetch(`${BFF}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sx-web": "1", origin: WEB },
    body: JSON.stringify(body),
  });
  return (await r.json().catch(() => ({}))) as Record<string, any>;
}

// <video>.currentTime advances over 4s with data available.
async function playing(page: Page, attempts = 10): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const s = await page.evaluate(async () => {
      const v = document.querySelector("video");
      if (!v) return { ok: false, note: "no video" };
      const t0 = v.currentTime;
      await new Promise((r) => setTimeout(r, 4000));
      return { ok: v.currentTime > t0 && v.readyState >= 2, note: `t ${t0.toFixed(1)}→${v.currentTime.toFixed(1)}` };
    });
    if (s.ok) return s.note;
  }
  return "";
}

async function main() {
  const owner = { email: `bo-${run}@verify.test`, name: `방송${run.slice(-3)}` };
  const viewer = { email: `bv-${run}@verify.test`, name: `시청${run.slice(-3)}` };
  for (const u of [owner, viewer])
    await auth("/auth/register", { email: u.email, password: PASSWORD, displayName: u.name });
  execFileSync("docker", [
    "exec", "streamix-postgres-1", "psql", "-U", "streamix", "-d", "streamix", "-c",
    `update users set approved_at = now() where email like '%-${run}@verify.test'`,
  ]);
  const ownerToken = (await auth("/auth/login", { email: owner.email, password: PASSWORD })).accessToken;
  const slug = `browser-${run}`;
  const created = await rpc("CreateChannel", { title: `브라우저 검증 ${run}`, slug, category: "게임" }, ownerToken);
  const push = spawn(
    ffmpeg,
    [
      "-re", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "24",
      "-c:a", "aac", "-t", "80", "-f", "flv",
      `rtmp://127.0.0.1:1935/live/${created.streamKey}`,
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 30 && !(await rpc("GetChannel", { slug })).channel?.isLive; i++) await sleep(1000);

  const launch = () =>
    chromium.launch({ headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
  let vb: Browser | undefined;
  let ob: Browser | undefined;
  try {
    vb = await launch();
    ob = await launch();
    const vp = await vb.newPage({ viewport: { width: 1440, height: 900 } });
    const op = await ob.newPage({ viewport: { width: 1440, height: 900 } });
    await loginViaUi(vp, WEB, viewer.email, PASSWORD);
    await loginViaUi(op, WEB, owner.email, PASSWORD);
    await vp.goto(`${WEB}/watch/${slug}`);
    await op.goto(`${WEB}/watch/${slug}`);
    await vp.waitForSelector("video", { timeout: 60_000 });

    // --- playback, quality ladder, viewer count ---
    const t = await playing(vp);
    check("viewer playback advances (separate browser)", !!t, t);
    const quality = vp.getByLabel("화질");
    await quality.waitFor({ timeout: 30_000 }).catch(() => {});
    const options = (await quality.locator("option").allTextContents().catch(() => [])).join(",");
    check("G-05 quality selector lists 720p and 480p", options.includes("720p") && options.includes("480p"), options);
    if (options.includes("480p")) {
      await quality.selectOption({ label: "480p" });
      const t480 = await playing(vp);
      check("G-05 playback continues after choosing 480p", !!t480, t480);
    }
    const viewers = await vp
      .getByText(/● 시청자 [1-9]/)
      .waitFor({ timeout: 40_000 })
      .then(() => true, () => false);
    check("G-21 live viewer count shows playing viewers", viewers);

    // --- follow + sidebar, theatre mode ---
    await vp.getByRole("button", { name: "팔로우", exact: true }).click();
    const followed = await vp.getByRole("button", { name: "팔로잉" }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    const inSidebar = await vp
      .getByRole("navigation", { name: "팔로우 중인 채널" })
      .getByText(slug)
      .waitFor({ timeout: 10_000 })
      .then(() => true, () => false);
    check("G-02 follow button + sidebar following list", followed && inSidebar);
    await vp.getByRole("button", { name: "극장 모드" }).click();
    const theatre = await vp.getByRole("button", { name: "극장 모드 종료" }).isVisible();
    await vp.keyboard.press("Escape");
    const back = await vp.getByRole("button", { name: "극장 모드", exact: true }).isVisible();
    check("G-06 theatre mode toggles and Esc exits", theatre && back);

    // --- chat UI: badges, reply, moderation panel, pin, modes ---
    const vlog = vp.getByRole("log", { name: "채팅 메시지" });
    const olog = op.getByRole("log", { name: "채팅 메시지" });
    await op.getByPlaceholder("메시지 보내기").fill(`환영합니다 ${run}`);
    await op.getByPlaceholder("메시지 보내기").press("Enter");
    const ownerLine = vlog.locator("div.group").filter({ hasText: `환영합니다 ${run}` });
    await ownerLine.waitFor({ timeout: 10_000 });
    check("G-08 viewer sees the broadcaster badge", (await ownerLine.getByText("방송자").count()) === 1);
    check(
      "G-09 moderation panel: broadcaster yes, viewer no",
      (await op.getByLabel("슬로우모드").count()) === 1 && (await vp.getByLabel("슬로우모드").count()) === 0,
    );
    await ownerLine.hover();
    await ownerLine.getByRole("button", { name: `${owner.name}님에게 답장` }).click();
    await vp.getByPlaceholder("메시지 보내기").fill(`답장 ${run}`);
    await vp.getByPlaceholder("메시지 보내기").press("Enter");
    const replyLine = olog.locator("div.group").filter({ hasText: `답장 ${run}` });
    await replyLine.waitFor({ timeout: 10_000 });
    check("G-07 reply shows the quoted parent", (await replyLine.innerText()).includes(`@${owner.name}`));

    await olog.getByRole("button", { name: `${viewer.name} 채팅 관리` }).first().click();
    await op.getByRole("button", { name: "고정", exact: true }).click();
    const pinned = await vp.getByText("고정된 메시지:").waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check("G-19 pinned message bar appears for the viewer", pinned);
    await op.getByRole("button", { name: "팔로워 전용 꺼짐" }).click();
    const mode = await vp.getByText(/채팅 모드: .*팔로워 전용/).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check("G-10 chat mode is shown to viewers", mode);
    await op.getByRole("button", { name: "팔로워 전용 켜짐" }).click();

    // --- end of broadcast: offline page, replay, studio summary ---
    await new Promise((r) => push.once("exit", r));
    const offline = await vp.getByText("마지막 방송").waitFor({ timeout: 40_000 }).then(() => true, () => false);
    check("G-04 offline page shows the last broadcast time", offline);
    const replayLink = vp.getByRole("link", { name: /방송/ }).filter({ has: vp.locator("text=최대 시청자") });
    const listed = await replayLink.first().waitFor({ timeout: 70_000 }).then(() => true, () => false);
    check("G-15 replay appears on the channel page without reload", listed);
    if (listed) {
      await replayLink.first().click();
      await vp.waitForURL(/\/videos\//);
      await vp.waitForSelector("video", { timeout: 30_000 });
      const tv = await playing(vp);
      const duration = await vp.evaluate(() => document.querySelector("video")?.duration ?? 0);
      check("G-15 replay plays and is seekable VOD", !!tv && duration > 30, `${tv} duration=${duration.toFixed(0)}s`);
    }
    await op.goto(`${WEB}/studio`);
    const history = await op
      .getByRole("table")
      .getByRole("row")
      .nth(1)
      .innerText({ timeout: 20_000 })
      .catch(() => "");
    check("G-13 studio shows the broadcast in recent history", /\d+분/.test(history), history.replace(/\s+/g, " "));
    await op.screenshot({ path: `benchmark-studio-${run}.png`, fullPage: true }).catch(() => {});
  } finally {
    push.kill();
    await vb?.close();
    await ob?.close();
  }
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(reportError);
