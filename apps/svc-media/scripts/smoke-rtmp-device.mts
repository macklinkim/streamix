// D2-a: an RTMP device (GoPro etc.) publishing to the durable stream key takes
// the channel live and a viewer at /watch/<slug> plays it — the fallback path
// the studio's RTMP card points phones at. ffmpeg stands in for the device; the
// push pattern is perf-g2g-stage.mts's (M0 S3).
//
// The gate is viewer playback. The signed-manifest fetch is kept as a secondary
// assertion (this script is the only one that still checks the manifest).
//
// Run (from apps/svc-media):
//   WEB=… BFF_URL=… RTMP_URL=… EMAIL=… PASSWORD=… SLUG=… pnpm exec tsx scripts/smoke-rtmp-device.mts
// Required env: WEB, BFF_URL, RTMP_URL, EMAIL, PASSWORD, SLUG. Optional: SECONDS.
//
// Side effects on the target: rotates that account's durable stream key (any OBS
// profile using the old key stops working) and publishes for up to SECONDS
// (default 150) — the producer is killed as soon as the assertions finish, so
// the channel is live for however long that takes, not for SECONDS. Use a
// dedicated smoke account, never a real broadcaster's.
import { spawn, type ChildProcess } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import {
  ConfigError,
  assertSameTarget,
  reportError,
  requiredEnv,
  viewerPlaybackAdvances,
} from "../../web/e2e/lib.mts";

const ff = ffmpegStatic as unknown as string;
// Upper bound on the producer; assertions normally finish well before this.
const SECONDS = Number(process.env.SECONDS ?? 150);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function main() {
  const WEB = requiredEnv("WEB");
  const BFF = requiredEnv("BFF_URL");
  const RTMP = requiredEnv("RTMP_URL");
  const EMAIL = requiredEnv("EMAIL");
  const PASSWORD = requiredEnv("PASSWORD");
  const SLUG = requiredEnv("SLUG");
  assertSameTarget({ WEB, BFF_URL: BFF, RTMP_URL: RTMP });

  async function rpc<T>(service: string, method: string, body: unknown, token?: string): Promise<T> {
    const res = await fetch(`${BFF}/${service}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & { code?: string; message?: string };
    if (!res.ok) throw new Error(`${method}: ${res.status} ${json.code ?? ""} ${json.message ?? ""}`);
    return json;
  }

  const channelLive = async () =>
    !!(
      await rpc<{ channel?: { isLive?: boolean } }>("channel.v1.ChannelService", "GetChannel", {
        slug: SLUG,
      })
    ).channel?.isLive;

  // Auth is REST-only at the BFF edge; the Connect AuthService is blocked there.
  const loginRes = await fetch(`${BFF}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    throw new ConfigError(`login failed at ${BFF} (${loginRes.status}) — wrong creds for this target?`);
  }
  const login = (await loginRes.json()) as { accessToken: string };

  let producer: ChildProcess | undefined;
  try {
    const { streamKey } = await rpc<{ streamKey: string }>(
      "channel.v1.ChannelService",
      "RotateStreamKey",
      {},
      login.accessToken,
    );
    check("durable key issued", streamKey.startsWith("live_"));

    // The card hands devices this exact one-line URL, so publish to that literally.
    producer = spawn(ff, [
      "-re",
      "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "60",
      "-c:a", "aac",
      "-t", String(SECONDS),
      "-f", "flv", `${RTMP}/${streamKey}`,
    ]);
    producer.stderr?.on("data", () => {});

    let live = false;
    for (let i = 0; i < 40 && !live; i++) {
      await sleep(1000);
      live = await channelLive();
    }
    check("channel live via rtmp", live);

    if (live) {
      // THE gate: a real viewer plays the device's stream.
      check("viewer playback advances at /watch", await viewerPlaybackAdvances(WEB, SLUG));

      // Secondary: the signed manifest lists segments.
      const { url } = await rpc<{ url: string }>("channel.v1.ChannelService", "GetPlaybackUrl", {
        slug: SLUG,
      });
      const res = await fetch(url);
      let served = false;
      if (res.ok) {
        let text = await res.text();
        const variant = text
          .split("\n")
          .find((l) => !l.startsWith("#") && l.includes(".m3u8"))
          ?.trim();
        if (variant) {
          const vr = await fetch(`${url.split("/index.m3u8")[0]}/${variant}`).catch(() => null);
          if (vr?.ok) text = await vr.text();
        }
        served = /\.(ts|mp4|m4s)/.test(text);
      }
      check("signed m3u8 lists segments (secondary)", served);
    }

    producer.kill("SIGKILL");
    let offline = false;
    for (let i = 0; i < 20 && !offline; i++) {
      await sleep(2000);
      offline = !(await channelLive());
    }
    check("offline transition", offline);
  } finally {
    producer?.kill("SIGKILL");
  }
}

try {
  await main();
  if (!results.every(([, ok]) => ok)) process.exitCode = 1;
} catch (e) {
  reportError(e);
}
