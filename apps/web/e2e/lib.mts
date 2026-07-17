// Shared helpers for the broadcast E2E scripts.
import { chromium, type Browser } from "@playwright/test";

// Credentials differ per target (the local fixture does not exist on prod), so
// there is no safe default: a stale default silently 401s and the run looks like
// a product failure. Demand them explicitly instead.
export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `FAIL missing required env ${name}. Set WEB, EMAIL, PASSWORD, SLUG for the target ` +
        `(local: seed a fixture first; prod: use the prod smoke account).`,
    );
    process.exit(2);
  }
  return v;
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
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  viewer console error: ${m.text()}`);
    });
    page.on("requestfailed", (r) => console.log(`  viewer request failed: ${r.url().slice(0, 80)}`));
    page.on("response", (r) => {
      if (r.url().includes("ChannelService")) console.log(`  viewer rpc: ${r.status()} ${r.url().split("/").pop()}`);
    });
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
