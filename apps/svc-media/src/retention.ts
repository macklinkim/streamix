import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env, thumbRoot } from "./env.js";

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
export function sweepRetention(): void {
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
