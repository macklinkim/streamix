// G1 verdict harness: CPU/RSS of the browser-ingest COPY path (codec=mp4-h264,
// ADR-9) — same sampling method as perf-baseline.ts so numbers are comparable
// against docs/perf-baseline.md. The producer (client stand-in) encodes on its
// own pid and is excluded; only the server-side remux ffmpeg + svc-media node
// are sampled.
//
// Usage (from apps/svc-media, svc-core + MediaMTX + svc-media running):
//   PERF_DURATION=300 pnpm exec tsx scripts/perf-copy.ts
import { spawn, execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import WebSocket from "ws";
import { AuthService, ChannelService } from "@streamix/proto";

const ff = ffmpegStatic as unknown as string;
const CORE = process.env.CORE_URL ?? "http://localhost:50051";
const WSBASE = process.env.MEDIA_WS_URL ?? "ws://localhost:8090";
const DURATION = Number(process.env.PERF_DURATION ?? 300);
const INTERVAL = Number(process.env.PERF_INTERVAL ?? 30);
const OUT_DIR = join(process.cwd(), "perf-out");
const NCPU = cpus().length;

const t = createGrpcTransport({ baseUrl: CORE });
const auth = createClient(AuthService, t);
const channel = createClient(ChannelService, t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EMAIL = "perf@streamix.test";
const PASSWORD = "perfpassword123";
const SLUG = "perf-baseline";

// Realtime fMP4 (H.264+AAC) producer — what MediaRecorder video/mp4 emits.
function producerArgs(): string[] {
  return [
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    "2500k",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-t",
    String(DURATION + 15),
    "-f",
    "mp4",
    "pipe:1",
  ];
}

function ps(cmd: string): string {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8",
  }).trim();
}
// The server-side copy ffmpeg has "-c:v copy" + rtmp in its command line.
function findPid(): number | null {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*copy*' -and $_.CommandLine -like '*rtmp*' } | ` +
      `Select-Object -First 1 -ExpandProperty ProcessId`,
  );
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parentOf(pid: number): number | null {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
      `Select-Object -First 1 -ExpandProperty ParentProcessId`,
  );
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function sampleProc(pid: number): { cpuSec: number; rss: number } | null {
  try {
    const out = ps(
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
        `"$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64)"`,
    );
    const [cpu, rss] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(cpu!) || !Number.isFinite(rss!)) return null;
    return { cpuSec: cpu!, rss: rss! };
  } catch {
    return null;
  }
}

mkdirSync(OUT_DIR, { recursive: true });
console.log(`[perf-copy] duration=${DURATION}s interval=${INTERVAL}s cores=${NCPU}`);

await auth.register({ email: EMAIL, password: PASSWORD, displayName: "perf" }).catch((e) => {
  if (!(e instanceof ConnectError && e.code === Code.AlreadyExists)) throw e;
});
const login = await auth.login({ email: EMAIL, password: PASSWORD });
const userHeader = { headers: { "x-user-id": login.user!.id } };
let mine = (await channel.getMyChannel({}, userHeader)).channel;
if (!mine) {
  await channel.createChannel({ title: "perf baseline", slug: SLUG, category: "test" }, userHeader);
  mine = (await channel.getMyChannel({}, userHeader)).channel;
}
const { streamKey } = await channel.rotateStreamKey({}, userHeader);

const producer = spawn(ff, producerArgs());
producer.stderr.on("data", () => {});
const ws = new WebSocket(`${WSBASE}/ingest?key=${streamKey}&codec=mp4-h264`);
await new Promise<void>((resolve, reject) => {
  ws.on("open", () => resolve());
  ws.on("error", reject);
});
producer.stdout.on("data", (chunk: Buffer) => {
  if (ws.readyState === ws.OPEN) ws.send(chunk);
});

let live = false;
for (let i = 0; i < 30 && !live; i++) {
  await sleep(1000);
  live = (await channel.getChannel({ slug: SLUG })).channel!.isLive;
}
if (!live) {
  console.error("[perf-copy] never went live — abort");
  process.exit(1);
}

let remuxPid: number | null = null;
for (let i = 0; i < 20 && remuxPid === null; i++) {
  remuxPid = findPid();
  if (remuxPid === null) await sleep(500);
}
const nodePid = remuxPid ? parentOf(remuxPid) : null;
console.log(`[perf-copy] remux pid=${remuxPid} svc-media node pid=${nodePid}`);

type Row = { tSec: number; remuxCores: number | null; remuxRssMB: number | null };
const rows: Row[] = [];
let prev = remuxPid ? sampleProc(remuxPid) : null;
const start = Date.now();
const n = Math.floor(DURATION / INTERVAL);
for (let i = 1; i <= n; i++) {
  await sleep(INTERVAL * 1000);
  const cur = remuxPid ? sampleProc(remuxPid) : null;
  const tSec = Math.round((Date.now() - start) / 1000);
  if (cur && prev) {
    const cores = (cur.cpuSec - prev.cpuSec) / INTERVAL;
    rows.push({
      tSec,
      remuxCores: +cores.toFixed(4),
      remuxRssMB: +(cur.rss / 1024 / 1024).toFixed(1),
    });
    console.log(`[perf-copy] t=${tSec}s cores=${cores.toFixed(4)}`);
  }
  prev = cur ?? prev;
}

producer.kill("SIGKILL");
ws.close();
const avg = rows.reduce((a, r) => a + (r.remuxCores ?? 0), 0) / Math.max(1, rows.length);
const out = { codec: "mp4-h264", durationSec: DURATION, avgCores: +avg.toFixed(4), rows };
writeFileSync(join(OUT_DIR, "copy-mp4h264.json"), JSON.stringify(out, null, 2));
console.log(`[perf-copy] avg remux cores=${avg.toFixed(4)} (${(avg * 100).toFixed(1)}%)`);
