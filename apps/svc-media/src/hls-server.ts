import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

// Data-plane HLS serving with signed-URL authz (§5.2). The master playlist is
// fetched with ?token&exp (from Core.GetPlaybackUrl); a valid token sets a
// short-lived cookie so hls.js segment requests stay authorized. Unsigned = 403.
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

function cookieValid(channelId: string, cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  const match = cookieHeader.split(";").map((c) => c.trim().split("="));
  const val = match.find(([k]) => k === `pb_${channelId}`)?.[1];
  if (!val) return false;
  const [token, exp] = decodeURIComponent(val).split(".");
  return tokenValid(channelId, token ?? null, exp ?? null);
}

const contentType = (file: string) =>
  file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";

export function startHlsServer(): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = url.pathname.match(/^\/hls\/([^/]+)\/(.+)$/);
    if (!m) {
      res.writeHead(404).end("not found");
      return;
    }
    const [, channelId, rawFile] = m;
    const token = url.searchParams.get("token");
    const exp = url.searchParams.get("exp");

    const byToken = tokenValid(channelId!, token, exp);
    if (!byToken && !cookieValid(channelId!, req.headers.cookie)) {
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

    const headers: Record<string, string> = {
      "Content-Type": contentType(safe),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    };
    // A token-authorized playlist grants a cookie for subsequent segments.
    // (Prod cross-origin needs SameSite=None; Secure; here dev is same-origin.)
    if (byToken && token && exp) {
      headers["Set-Cookie"] =
        `pb_${channelId}=${encodeURIComponent(`${token}.${exp}`)}; Path=/hls/${channelId}/; Max-Age=300; HttpOnly`;
    }
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  });

  server.listen(env.HTTP_PORT, () => {
    console.log(`svc-media hls authz server on :${env.HTTP_PORT}`);
  });
}
