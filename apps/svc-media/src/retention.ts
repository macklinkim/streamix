import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { env, thumbRoot } from "./env.js";

export function reapChannel(channelId: string): void {
  rmSync(join(env.MEDIA_ROOT, channelId), { recursive: true, force: true });
  rmSync(join(thumbRoot, `${channelId}.jpg`), { force: true });
}

// Reap channel HLS dirs whose playlist hasn't updated within the TTL (covers
// crashed encoders that never send donePublish). Backstop to per-stop cleanup.
export function sweepRetention(): void {
  let entries: string[];
  try {
    entries = readdirSync(env.MEDIA_ROOT);
  } catch {
    return;
  }
  const cutoff = Date.now() - env.RETENTION_TTL_SECONDS * 1000;
  for (const name of entries) {
    if (name.startsWith("_")) continue; // skip _thumbs
    const m3u8 = join(env.MEDIA_ROOT, name, "index.m3u8");
    if (existsSync(m3u8) && statSync(m3u8).mtimeMs < cutoff) reapChannel(name);
  }
}
