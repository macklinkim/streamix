import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env, m5, thumbRoot } from "./env.js";

// With MediaMTX (ADR-10) HLS segments live in the packager's memory, not on our
// disk, so there are no channel HLS dirs to reap — only the thumbnail (and any
// legacy dir) belongs to us now.
export function reapChannel(channelId: string): void {
  rmSync(join(env.MEDIA_ROOT, channelId), { recursive: true, force: true });
  rmSync(join(thumbRoot, `${channelId}.jpg`), { force: true });
}

// Backstop for the main.ts publish-end poller: a live channel refreshes its
// thumbnail every THUMB_INTERVAL_SECONDS, so a thumbnail older than the TTL
// belongs to a stream that ended without the poller reaping it (e.g. a restart).
// Replays past the retention window (benchmark G-15). Core stops listing them
// at the same age, so deleting here never breaks a listed video.
// ponytail: age-only policy, no disk-usage cap; upgrade = also evict oldest
// when VOD_ROOT exceeds a size budget.
function sweepVod(): void {
  let entries: string[];
  try {
    entries = readdirSync(m5.VOD_ROOT);
  } catch {
    return;
  }
  const cutoff = Date.now() - m5.VOD_RETENTION_DAYS * 86_400_000;
  for (const name of entries) {
    const p = join(m5.VOD_ROOT, name);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    } catch {
      /* raced with a concurrent delete */
    }
  }
}

export function sweepRetention(): void {
  sweepVod();
  let entries: string[];
  try {
    entries = readdirSync(thumbRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - env.RETENTION_TTL_SECONDS * 1000;
  for (const name of entries) {
    if (!name.endsWith(".jpg")) continue;
    const p = join(thumbRoot, name);
    try {
      if (statSync(p).mtimeMs < cutoff) reapChannel(name.slice(0, -4));
    } catch {
      /* raced with a concurrent reap */
    }
  }
}
