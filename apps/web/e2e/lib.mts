// Shared helpers for the broadcast E2E scripts.
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * A misconfigured run (missing env, wrong credentials, mixed targets) — not a
 * product failure. Thrown rather than exited on, so the callers' finally blocks
 * still close browsers and kill ffmpeg; the top level maps it to exit code 2.
 */
export class ConfigError extends Error {}

/**
 * Exit 2 = misconfigured, 1 = an assertion failed or the run blew up, 0 = all
 * passed. Sets process.exitCode instead of calling process.exit(), which would
 * skip the finally blocks that close browsers and kill ffmpeg.
 */
export function reportError(e: unknown): void {
  if (e instanceof ConfigError) {
    console.error(`FAIL (config) ${e.message}`);
    process.exitCode = 2;
  } else {
    console.error(e);
    process.exitCode = 1;
  }
}

// Credentials and endpoints differ per target (the local fixture does not exist
// on prod), so there is no safe default: a stale default silently 401s and the
// run looks like a product failure. Demand them explicitly instead.
export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`missing required env ${name} — see apps/web/e2e/README.md`);
  return v;
}

const isLocal = (u: string) => /^(https?|rtmps?):\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u);

/**
 * Refuses a run that mixes a local endpoint with a remote one. Without this, the
 * documented local command minus one variable pushes a locally-issued key at the
 * production RTMP host — reaching a system the operator did not mean to touch.
 */
export function assertSameTarget(urls: Record<string, string>) {
  const entries = Object.entries(urls);
  const local = entries.filter(([, u]) => isLocal(u));
  if (local.length > 0 && local.length < entries.length) {
    const describe = (es: typeof entries) => es.map(([k, u]) => `${k}=${u}`).join(" ");
    throw new ConfigError(
      `endpoints mix local and remote targets — ${describe(local)} vs ` +
        `${describe(entries.filter(([, u]) => !isLocal(u)))}. Point them all at one target.`,
    );
  }
}

/**
 * Logs in through the UI and reports *why* it failed, using the status the BFF
 * actually returned. 401 is bad credentials; 429 is the auth rate limit (5 per
 * 30s per IP), which back-to-back runs trip — calling that "wrong credentials"
 * sends the reader hunting for the wrong problem.
 */
export async function loginViaUi(page: Page, web: string, email: string, password: string) {
  let status = 0;
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/auth/login") status = r.status();
  });
  await page.goto(`${web}/login`);
  await page.getByRole("textbox", { name: "이메일" }).fill(email);
  await page.getByRole("textbox", { name: "비밀번호" }).fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  try {
    await page.waitForURL(`${web}/`, { timeout: 15000 });
  } catch {
    const why =
      status === 429
        ? "rate limited (429) — the auth limit is 5 per 30s per IP; space runs out"
        : status === 401
          ? "rejected (401) — wrong credentials for this target"
          : `no redirect (last /auth/login status: ${status || "none"})`;
    throw new ConfigError(`login failed at ${web}: ${why}`);
  }
}

/**
 * Proves the viewer-facing requirement: /watch/<slug> plays, i.e. <video>
 * currentTime actually advances. Runs in its OWN browser process — a second tab
 * or context in the broadcaster's browser gets the broadcaster window occluded,
 * and Chromium then throttles its MediaRecorder and stalls the stream (R3).
 */
export async function viewerPlaybackAdvances(
  web: string,
  slug: string,
  attempts = 12,
): Promise<boolean> {
  let viewer: Browser | undefined;
  try {
    viewer = await chromium.launch({
      headless: false,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const page = await viewer.newPage();
    // A viewer is anonymous, so the only expected 4xx is the silent session
    // probe on load: AuthHydrator calls /auth/refresh with no cookie and gets
    // 401. Anything else is reported with its URL — a bare "console error" line
    // hides which request failed.
    page.on("response", (r) => {
      if (r.status() < 400) return;
      const url = r.url().replace(/([?&](token|key)=)[^&]+/g, "$1***");
      const expected = r.status() === 401 && new URL(r.url()).pathname === "/auth/refresh";
      console.log(`  viewer http ${r.status()}${expected ? " (expected: anon session probe)" : ""}: ${url.slice(0, 100)}`);
    });
    page.on("requestfailed", (r) => console.log(`  viewer request failed: ${r.url().slice(0, 80)}`));
    // Not networkidle: a live HLS player keeps fetching segments, so the network
    // never goes idle and the wait would always time out.
    await page.goto(`${web}/watch/${slug}`);
    // The player only mounts once the app has hydrated and seen the channel go
    // live; poking at the DOM before that just measures the SSR placeholder.
    try {
      await page.waitForSelector("video", { timeout: 60000 });
    } catch {
      console.log(
        `  viewer: no <video> after 60s — page shows ${JSON.stringify(
          await page.evaluate(() => document.body.innerText.replace(/\n+/g, " | ").slice(0, 120)),
        )}`,
      );
      return false;
    }
    for (let i = 0; i < attempts; i++) {
      const sample = await page.evaluate(async () => {
        const v = document.querySelector("video");
        if (!v) return { ok: false, note: "no-video" };
        const t0 = v.currentTime;
        await new Promise((r) => setTimeout(r, 4000));
        return {
          ok: v.currentTime > t0 && v.readyState >= 2,
          note: `t0=${t0.toFixed(1)} t1=${v.currentTime.toFixed(1)} rs=${v.readyState}`,
        };
      });
      console.log(`  viewer[${i}] ${sample.note}`);
      if (sample.ok) return true;
    }
    return false;
  } finally {
    await viewer?.close().catch(() => {});
  }
}
