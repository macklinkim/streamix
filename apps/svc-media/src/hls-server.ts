import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, mtx, thumbRoot } from "./env.js";

// Data-plane HLS serving with signed-URL authz (§5.2), now a reverse proxy in
// front of MediaMTX LL-HLS (ADR-10). The HMAC token check is unchanged; on a
// valid token we proxy to MediaMTX (channelId -> its RTMP publish path, which is
// never exposed) and rewrite the playlist's URIs — including LL-HLS #EXT-X-PART,
// #EXT-X-MAP and #EXT-X-PRELOAD-HINT — to carry the same token. Unsigned/expired
// -> 403.
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

function appendToken(uri: string, q: string): string {
  if (/^https?:/i.test(uri)) return uri; // MediaMTX emits only relative URIs
  return uri.includes("?") ? `${uri}&${q.slice(1)}` : `${uri}${q}`;
}

// Re-sign every media reference so hls.js stays authorized cross-origin without
// cookies. Covers plain segment/part/playlist lines and URI="..." tag attributes.
function rewritePlaylist(text: string, q: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${appendToken(uri, q)}"`);
      }
      const t = line.trim();
      return t && /\.(m3u8|mp4|m4s|ts)$/.test(t) ? appendToken(t, q) : line;
    })
    .join("\n");
}

// MediaMTX gates HLS with a DNS-rebinding guard: an unauthenticated request gets
// a cookieCheck 302, and the follow-up sets an hlsSession cookie. We do that
// handshake once server-side and reuse the session, refreshing on a 401.
let mtxCookie = "";
function grabCookie(r: Response): void {
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) mtxCookie = set[set.length - 1]!.split(";")[0]!;
}
async function mtxFetch(pathAndQuery: string): Promise<Response> {
  const url = `${mtx.hlsOrigin}${pathAndQuery}`;
  const doFetch = (cookie: string) =>
    fetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  let r = await doFetch(mtxCookie);
  grabCookie(r);
  if (r.status === 302) {
    const loc = r.headers.get("location") ?? "";
    r = await fetch(new URL(loc, mtx.hlsOrigin), {
      headers: mtxCookie ? { cookie: mtxCookie } : {},
      redirect: "manual",
    });
    grabCookie(r);
  } else if (r.status === 401 && mtxCookie) {
    mtxCookie = "";
    r = await doFetch("");
    grabCookie(r);
    if (r.status === 302) {
      const loc = r.headers.get("location") ?? "";
      r = await fetch(new URL(loc, mtx.hlsOrigin), {
        headers: mtxCookie ? { cookie: mtxCookie } : {},
        redirect: "manual",
      });
      grabCookie(r);
    }
  }
  return r;
}

export function startHlsServer(
  resolvePath: (channelId: string) => string | undefined,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    // CORS on every response (403/404 included): the player must read failure
    // statuses cross-origin to retry while a stream warms up.
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url ?? "/", "http://localhost");

    // Thumbnails are public (low-sensitivity list-card previews, no token).
    const thumb = url.pathname.match(/^\/thumb\/([^/]+)\.jpg$/);
    if (thumb) {
      const p = join(thumbRoot, `${thumb[1]}.jpg`);
      if (!existsSync(p)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
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

    const mtxPath = resolvePath(channelId!);
    if (!mtxPath) {
      res.writeHead(404).end("not found");
      return;
    }

    // Strip our token/exp but forward LL-HLS blocking-reload params
    // (_HLS_msn / _HLS_part / _HLS_skip) so low-latency delivery keeps working.
    const fwd = new URLSearchParams();
    for (const [k, v] of url.searchParams) if (k !== "token" && k !== "exp") fwd.set(k, v);
    const qs = fwd.toString();
    const safeFile = rawFile!.replace(/\.\.[/\\]/g, "");
    const upstream = `/${mtxPath}/${safeFile}${qs ? `?${qs}` : ""}`;

    void (async () => {
      let r: Response;
      try {
        r = await mtxFetch(upstream);
      } catch {
        res.writeHead(502).end("bad gateway");
        return;
      }
      if (r.status !== 200) {
        res.writeHead(r.status).end();
        return;
      }
      const ct = r.headers.get("content-type") ?? "application/octet-stream";
      if (safeFile.endsWith(".m3u8")) {
        const body = rewritePlaylist(await r.text(), `?token=${token}&exp=${exp}`);
        res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": ct });
        res.end(body);
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": ct });
        res.end(buf);
      }
    })();
  });

  server.listen(env.HTTP_PORT, () => {
    console.log(`svc-media hls proxy on :${env.HTTP_PORT} -> ${mtx.hlsOrigin}`);
  });
  return server;
}
