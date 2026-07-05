// M0 baseline: per-segment bitrate distribution of produced HLS, via ffprobe.
// Reads an HLS directory (index.m3u8 + *.ts), ffprobes each segment for
// duration + byte size, and reports the kbps distribution (min/median/max/mean).
// Demonstrates the unbounded-CRF behaviour the rate-control gate (G2) targets.
//
// Measurement only — does not modify any app source.
//
// Usage (from apps/svc-media):
//   node --import tsx scripts/perf-bitrate.ts perf-out/hls-static
//   node --import tsx scripts/perf-bitrate.ts perf-out/hls-complex
//
// Env:
//   FFPROBE   ffprobe binary (default "ffprobe" on PATH)
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FFPROBE = process.env.FFPROBE ?? "ffprobe";
const dir = process.argv[2];
if (!dir) throw new Error("usage: perf-bitrate.ts <hls-dir>");

const segments = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .sort();
if (segments.length === 0) throw new Error(`no .ts segments in ${dir}`);

// ffprobe container-level duration; byte size from stat (exact on disk).
function probe(path: string): { durSec: number; kbps: number } {
  const out = execFileSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { encoding: "utf8" },
  ).trim();
  const durSec = Number(out);
  const bytes = statSync(path).size;
  const kbps = durSec > 0 ? (bytes * 8) / durSec / 1000 : 0;
  return { durSec, kbps };
}

const rows = segments.map((f) => {
  const { durSec, kbps } = probe(join(dir, f));
  return { file: f, durSec: +durSec.toFixed(3), kbps: Math.round(kbps) };
});

const kbpsList = rows.map((r) => r.kbps).sort((a, b) => a - b);
const durList = rows.map((r) => r.durSec);
const median = (xs: number[]) => xs[Math.floor(xs.length / 2)];
const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

console.log(`dir: ${dir}`);
console.log(`segments: ${rows.length}`);
console.log("");
console.log("segment                         dur(s)   kbps");
for (const r of rows) {
  console.log(
    `${r.file.padEnd(30)}  ${r.durSec.toFixed(2).padStart(6)}  ${String(r.kbps).padStart(6)}`,
  );
}
console.log("");
const summary = {
  segments: rows.length,
  bitrateKbps: {
    min: kbpsList[0],
    median: median(kbpsList),
    mean: mean(kbpsList),
    max: kbpsList[kbpsList.length - 1],
  },
  segmentDurationSec: {
    min: +Math.min(...durList).toFixed(3),
    median: +median([...durList].sort((a, b) => a - b)).toFixed(3),
    max: +Math.max(...durList).toFixed(3),
  },
};
console.log(JSON.stringify(summary, null, 2));
