import { createServer } from "node:http";
import { createReadStream, readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, thumbRoot } from "./env.js";

// Data-plane HLS serving with signed-URL authz (§5.2). The playlist is fetched
// with ?token&exp (from Core.GetPlaybackUrl); the playlist's segment URIs are
// rewritten to carry the same token so hls.js stays authorized cross-origin
// without cookies (browser-friendly). Unsigned / expired -> 403.
function sign(payload: string): string {
  return createHmac("sha256", env.PLAYBACK_SECRET).update(payload).digest("hex");
}

function tokenValid(channelId: string, token: string | null, exp: string | null): boolean {
  if (!token || !exp) return false;
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
  const expected = sign(`${channelId}.${e}`);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function startHlsServer(): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Thumbnails are public (low-sensitivity list-card previews, no token).
    const thumb = url.pathname.match(/^\/thumb\/([^/]+)\.jpg$/);
    if (thumb) {
      const p = join(thumbRoot, `${thumb[1]}.jpg`);
      if (!existsSync(p)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      });
      createReadStream(p).pipe(res);
      return;
    }

    const m = url.pathname.match(/^\/hls\/([^/]+)\/(.+)$/);
    if (!m) {
      res.writeHead(404).end("not found");
      return;
    }
    const [, channelId, rawFile] = m;
    const token = url.searchParams.get("token");
    const exp = url.searchParams.get("exp");
    if (!tokenValid(channelId!, token, exp)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    // Prevent path traversal, then resolve inside the channel's HLS dir.
    const safe = normalize(rawFile!).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(env.MEDIA_ROOT, channelId!, safe);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }

    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" };

    if (safe.endsWith(".m3u8")) {
      const q = `?token=${token}&exp=${exp}`;
      const rewritten = readFileSync(filePath, "utf8")
        .split("\n")
        .map((line) => {
          const t = line.trim();
          return t && !t.startsWith("#") && (t.endsWith(".ts") || t.endsWith(".m4s"))
            ? `${t}${q}`
            : line;
        })
        .join("\n");
      res.writeHead(200, { ...cors, "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(rewritten);
      return;
    }

    res.writeHead(200, { ...cors, "Content-Type": "video/mp2t" });
    createReadStream(filePath).pipe(res);
  });

  server.listen(env.HTTP_PORT, () => {
    console.log(`svc-media hls authz server on :${env.HTTP_PORT}`);
  });
}
