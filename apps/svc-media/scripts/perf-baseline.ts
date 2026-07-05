// M0 baseline: CPU/RSS of the browser-ingest transcoding path (ingest.ts).
// Drives the SAME pipeline as smoke-ingest (WS /ingest -> ffmpeg libx264 -> RTMP
// -> HLS), then samples the transcoder ffmpeg child and the svc-media node
// process at a fixed interval for a fixed duration. Emits a JSON report + a
// snapshot of the produced HLS segments (for perf-bitrate.ts).
//
// This is a MEASUREMENT harness only — it does not modify any app source.
//
// Usage (from apps/svc-media):
//   PERF_SOURCE=static  PERF_DURATION=300 node --import tsx scripts/perf-baseline.ts
//   PERF_SOURCE=complex PERF_DURATION=120 node --import tsx scripts/perf-baseline.ts
//
// Env:
//   PERF_SOURCE    static | complex        (default static)
//   PERF_DURATION  sampling seconds        (default 300)
//   PERF_INTERVAL  sample interval seconds (default 30)
//   PERF_OUT       JSON report path        (default scripts/../perf-out/<source>.json)
//   PERF_SNAPSHOT  dir to copy HLS into    (default perf-out/hls-<source>)
//   CORE_URL       svc-core gRPC           (default http://localhost:50051)
//   MEDIA_WS_URL   svc-media ws            (default ws://localhost:8090)
import { spawn, execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { mkdirSync, cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import ffmpegStatic from "ffmpeg-static";
import WebSocket from "ws";
import { AuthService, ChannelService } from "@streamix/proto";

const ff = ffmpegStatic as unknown as string;
const CORE = process.env.CORE_URL ?? "http://localhost:50051";
const WSBASE = process.env.MEDIA_WS_URL ?? "ws://localhost:8090";
const SOURCE = (process.env.PERF_SOURCE ?? "static").toLowerCase();
const DURATION = Number(process.env.PERF_DURATION ?? 300);
const INTERVAL = Number(process.env.PERF_INTERVAL ?? 30);
const OUT_DIR = join(process.cwd(), "perf-out");
const OUT = process.env.PERF_OUT ?? join(OUT_DIR, `baseline-${SOURCE}.json`);
const SNAPSHOT = process.env.PERF_SNAPSHOT ?? join(OUT_DIR, `hls-${SOURCE}`);
const NCPU = cpus().length;

const t = createGrpcTransport({ baseUrl: CORE });
const auth = createClient(AuthService, t);
const channel = createClient(ChannelService, t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EMAIL = "perf@streamix.test";
const PASSWORD = "perfpassword123";
const SLUG = "perf-baseline";

// Source ffmpeg args (producer side = stand-in for a browser MediaRecorder).
// static  = low-entropy testsrc (bars/gradients) -> low transcoder bitrate.
// complex = testsrc2 + heavy noise -> high entropy -> unbounded CRF bitrate.
function producerArgs(): string[] {
  const common = ["-c:a", "libopus", "-t", String(DURATION + 15), "-f", "webm", "pipe:1"];
  if (SOURCE === "complex") {
    return [
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-vf",
      "noise=alls=40:allf=t+u",
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "8000k",
      ...common,
    ];
  }
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
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-b:v",
    "2500k",
    ...common,
  ];
}

// --- Windows per-process sampling via PowerShell -----------------------------
function ps(cmd: string): string {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8",
  }).trim();
}
function findPid(match: string): number | null {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${match}*' -and $_.CommandLine -like '*rtmp*' } | ` +
      `Select-Object -First 1 -ExpandProperty ProcessId`,
  );
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// The svc-media node process is the parent of the transcoder ffmpeg it spawned;
// its command line is indistinguishable from svc-core's, so resolve by PPID.
function parentOf(pid: number): number | null {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
      `Select-Object -First 1 -ExpandProperty ParentProcessId`,
  );
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// Returns cumulative CPU seconds + working-set bytes for a pid, or null if gone.
function sampleProc(pid: number): { cpuSec: number; rss: number } | null {
  try {
    const out = ps(
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
        `"$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64)"`,
    );
    const [cpu, rss] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(cpu) || !Number.isFinite(rss)) return null;
    return { cpuSec: cpu, rss };
  } catch {
    return null;
  }
}

type ProcSample = { cpuCores: number | null; cpuPct: number | null; rssMB: number | null };
type Sample = { tSec: number; transcoder: ProcSample; svcMediaNode: ProcSample };

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[perf] source=${SOURCE} duration=${DURATION}s interval=${INTERVAL}s cores=${NCPU}`);

  // --- setup channel + key (mirrors smoke-ingest) ---
  await auth.register({ email: EMAIL, password: PASSWORD, displayName: "perf" }).catch((e) => {
    if (!(e instanceof ConnectError && e.code === Code.AlreadyExists)) throw e;
  });
  const login = await auth.login({ email: EMAIL, password: PASSWORD });
  const userHeader = { headers: { "x-user-id": login.user!.id } };
  let mine = (await channel.getMyChannel({}, userHeader)).channel;
  if (!mine) {
    await channel.createChannel(
      { title: "perf baseline", slug: SLUG, category: "test" },
      userHeader,
    );
    mine = (await channel.getMyChannel({}, userHeader)).channel;
  }
  const channelId = mine!.id;
  const { streamKey } = await channel.rotateStreamKey({}, userHeader);

  // --- start producer + WS ingest ---
  const producer = spawn(ff, producerArgs());
  producer.stderr.on("data", () => {}); // drain
  const ws = new WebSocket(`${WSBASE}/ingest?key=${streamKey}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  producer.stdout.on("data", (chunk: Buffer) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });

  // --- wait until live ---
  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    await sleep(1000);
    live = (await channel.getChannel({ slug: SLUG })).channel!.isLive;
  }
  if (!live) {
    console.error("[perf] stream never went live — aborting");
    producer.kill("SIGKILL");
    ws.close();
    process.exit(1);
  }
  console.log(`[perf] live channelId=${channelId}`);

  // --- locate processes to sample ---
  let transPid: number | null = null;
  for (let i = 0; i < 10 && transPid === null; i++) {
    transPid = findPid("libx264");
    if (transPid === null) await sleep(500);
  }
  const nodePid = transPid ? parentOf(transPid) : null;
  console.log(`[perf] transcoder pid=${transPid} svc-media node pid=${nodePid}`);

  // --- sample loop ---
  const samples: Sample[] = [];
  let prevTrans = transPid ? sampleProc(transPid) : null;
  let prevNode = nodePid ? sampleProc(nodePid) : null;
  const start = Date.now();
  const nSamples = Math.floor(DURATION / INTERVAL);
  for (let i = 1; i <= nSamples; i++) {
    await sleep(INTERVAL * 1000);
    const tSec = Math.round((Date.now() - start) / 1000);
    const curTrans = transPid ? sampleProc(transPid) : null;
    const curNode = nodePid ? sampleProc(nodePid) : null;

    const diff = (
      cur: { cpuSec: number; rss: number } | null,
      prev: { cpuSec: number; rss: number } | null,
    ): ProcSample => {
      if (!cur) return { cpuCores: null, cpuPct: null, rssMB: null };
      const cores = prev ? (cur.cpuSec - prev.cpuSec) / INTERVAL : null;
      return {
        cpuCores: cores === null ? null : +cores.toFixed(3),
        cpuPct: cores === null ? null : +(cores * 100).toFixed(1),
        rssMB: +(cur.rss / 1024 / 1024).toFixed(1),
      };
    };

    const s: Sample = {
      tSec,
      transcoder: diff(curTrans, prevTrans),
      svcMediaNode: diff(curNode, prevNode),
    };
    samples.push(s);
    console.log(
      `[perf] t=${tSec}s transcoder cores=${s.transcoder.cpuCores} rss=${s.transcoder.rssMB}MB | ` +
        `node cores=${s.svcMediaNode.cpuCores} rss=${s.svcMediaNode.rssMB}MB`,
    );
    prevTrans = curTrans;
    prevNode = curNode;
  }

  // --- snapshot HLS segments before teardown reaps them ---
  const hlsDir = join(process.cwd(), "hls-tmp", channelId);
  if (existsSync(hlsDir)) {
    if (existsSync(SNAPSHOT))
      cpSync(SNAPSHOT, SNAPSHOT + ".prev", { recursive: true, force: true });
    cpSync(hlsDir, SNAPSHOT, { recursive: true });
    console.log(`[perf] HLS snapshot -> ${SNAPSHOT}`);
  } else {
    console.warn(`[perf] HLS dir not found at ${hlsDir}`);
  }

  // --- teardown ---
  producer.kill("SIGKILL");
  ws.close();

  // --- summary ---
  const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const mean = (xs: number[]) =>
    xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null;
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  const report = {
    source: SOURCE,
    durationSec: DURATION,
    intervalSec: INTERVAL,
    machineCores: NCPU,
    transcoderPid: transPid,
    svcMediaNodePid: nodePid,
    samples,
    summary: {
      transcoder: {
        cpuCoresMean: mean(nums(samples.map((s) => s.transcoder.cpuCores))),
        cpuCoresMax: max(nums(samples.map((s) => s.transcoder.cpuCores))),
        cpuPctMean: mean(nums(samples.map((s) => s.transcoder.cpuPct))),
        rssMBMean: mean(nums(samples.map((s) => s.transcoder.rssMB))),
        rssMBMax: max(nums(samples.map((s) => s.transcoder.rssMB))),
      },
      svcMediaNode: {
        cpuCoresMean: mean(nums(samples.map((s) => s.svcMediaNode.cpuCores))),
        rssMBMean: mean(nums(samples.map((s) => s.svcMediaNode.rssMB))),
        rssMBMax: max(nums(samples.map((s) => s.svcMediaNode.rssMB))),
      },
    },
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`[perf] report -> ${OUT}`);
  console.log(JSON.stringify(report.summary, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
