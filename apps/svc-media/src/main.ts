import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { ConnectError } from "@connectrpc/connect";
import { env, mtx, thumbRoot } from "./env.js";
import { core } from "./core-client.js";
import { startHlsServer } from "./hls-server.js";
import { attachIngest } from "./ingest.js";
import { sweepRetention, reapChannel } from "./retention.js";

// ADR-10: MediaMTX packages RTMP -> LL-HLS. svc-media no longer runs NMS or an
// ffmpeg HLS packager; it (1) validates the stream key for MediaMTX's http auth
// so an invalid key can't publish, and (2) mirrors the old postPublish/
// donePublish lifecycle by polling MediaMTX's control API — the scratch image
// has no shell, so runOnReady/runOnNotReady hooks can't call back. Live-state is
// still claimed via Core.StartStream (SET NX single writer) exactly once per
// publish, and released via Core.StopStream.
const ffmpeg = ffmpegStatic as unknown as string;
mkdirSync(env.MEDIA_ROOT, { recursive: true });
mkdirSync(thumbRoot, { recursive: true });

type Session = { channelId: string; hb: NodeJS.Timeout; thumb: NodeJS.Timeout };
const sessions = new Map<string, Session>(); // keyed by MediaMTX path "live/<key>"
const channelToPath = new Map<string, string>(); // reverse lookup for the proxy
const claiming = new Set<string>(); // paths with an in-flight StartStream

const keyOf = (mtxPath: string) => mtxPath.split("/").pop() ?? "";

// Grab one JPEG frame off MediaMTX RTMP for the channel's list card (ADR-3).
// RTMP_PORT now points at MediaMTX (ingest.ts publishes there too).
function captureThumbnail(channelId: string, mtxPath: string): void {
  spawn(
    ffmpeg,
    [
      "-y",
      "-i",
      `rtmp://127.0.0.1:${env.RTMP_PORT}/${mtxPath}`,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-1",
      "-q:v",
      "4",
      join(thumbRoot, `${channelId}.jpg`),
    ],
    { stdio: "ignore" },
  );
}

// Best-effort kick so the single-writer invariant holds: the key was already
// validated at publish auth, so a StartStream failure means the live slot is
// still claimed (stale/crashed writer) — close the racing publisher like the old
// NMS reject did.
async function kickPublisher(mtxPath: string): Promise<void> {
  try {
    const r = await fetch(`${mtx.apiOrigin}/v3/paths/list`);
    const data = (await r.json()) as { items?: { name: string; source?: { id?: string } }[] };
    const id = data.items?.find((i) => i.name === mtxPath)?.source?.id;
    if (!id) return;
    for (const proto of ["rtmpconns", "srtconns", "webrtcsessions"]) {
      await fetch(`${mtx.apiOrigin}/v3/${proto}/kick/${id}`, { method: "POST" }).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}

// runOnReady-equivalent: claim live state + heartbeat + thumbnail.
async function onPublishReady(mtxPath: string): Promise<void> {
  if (sessions.has(mtxPath) || claiming.has(mtxPath)) return;
  claiming.add(mtxPath);
  try {
    const { channelId } = await core.startStream({ streamKey: keyOf(mtxPath) });
    const hb = setInterval(() => void core.heartbeat({ channelId }).catch(() => {}), 30_000);
    setTimeout(() => captureThumbnail(channelId, mtxPath), 4000); // first frame once warm
    const thumb = setInterval(
      () => captureThumbnail(channelId, mtxPath),
      env.THUMB_INTERVAL_SECONDS * 1000,
    );
    sessions.set(mtxPath, { channelId, hb, thumb });
    channelToPath.set(channelId, mtxPath);
    console.log(`live ${mtxPath} -> channel ${channelId}`);
  } catch (e) {
    const code = e instanceof ConnectError ? e.code : "?";
    console.warn(`startStream rejected ${mtxPath}: ${code} — kicking publisher`);
    await kickPublisher(mtxPath);
  } finally {
    claiming.delete(mtxPath);
  }
}

// runOnNotReady-equivalent: release live state + reap (grace for late viewers).
function onPublishGone(mtxPath: string): void {
  const s = sessions.get(mtxPath);
  if (!s) return;
  sessions.delete(mtxPath);
  channelToPath.delete(s.channelId);
  clearInterval(s.hb);
  clearInterval(s.thumb);
  void core.stopStream({ channelId: s.channelId }).catch(() => {});
  setTimeout(() => reapChannel(s.channelId), 8000);
  console.log(`offline ${mtxPath} -> channel ${s.channelId}`);
}

// Poll MediaMTX for publish start/stop transitions.
async function pollPaths(): Promise<void> {
  const ready = new Set<string>();
  try {
    const r = await fetch(`${mtx.apiOrigin}/v3/paths/list`);
    if (!r.ok) return;
    const data = (await r.json()) as { items?: { name: string; ready: boolean }[] };
    for (const it of data.items ?? []) if (it.ready) ready.add(it.name);
  } catch {
    return; // MediaMTX not reachable yet
  }
  for (const p of ready) if (!sessions.has(p)) void onPublishReady(p);
  for (const p of [...sessions.keys()]) if (!ready.has(p)) onPublishGone(p);
}

// Internal-only: MediaMTX http auth posts publish attempts here. Reads/api are
// excluded from auth in mediamtx.yml, so only 'publish' arrives. Deny (401)
// closes the publish natively — no kick needed for a plainly-invalid key.
const authServer = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/mtx/auth") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    void (async () => {
      let action = "";
      let path = "";
      try {
        ({ action, path } = JSON.parse(body || "{}"));
      } catch {
        /* empty/garbage body -> treated as non-publish */
      }
      if (action !== "publish") {
        res.writeHead(200).end(); // reads/api excluded upstream; allow anything else
        return;
      }
      try {
        const { valid } = await core.validateStreamKey({ streamKey: keyOf(path) });
        res.writeHead(valid ? 200 : 401).end();
      } catch {
        res.writeHead(503).end(); // Core down -> deny publish
      }
    })();
  });
});
authServer.listen(mtx.internalPort, "0.0.0.0", () =>
  console.log(`svc-media mtx-auth on :${mtx.internalPort}`),
);

setInterval(() => void pollPaths(), 2000);
setInterval(sweepRetention, 60_000); // backstop for streams the poller missed

attachIngest(startHlsServer((channelId) => channelToPath.get(channelId)));
console.log(
  `svc-media http :${env.HTTP_PORT} (mediamtx hls ${mtx.hlsOrigin}, rtmp :${env.RTMP_PORT})`,
);
