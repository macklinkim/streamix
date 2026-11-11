import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, mtx, thumbRoot } from "./env.js";
import { vodDir } from "./recorder.js";
import { abrPath } from "./abr.js";

// Data-plane HLS serving with signed-URL authz (§5.2), now a reverse proxy in
// front of MediaMTX LL-HLS (ADR-10). The HMAC token check is unchanged; on a
// valid token we proxy to MediaMTX (channelId -> its RTMP publish path, which is
// never exposed) and rewrite the playlist's URIs — including LL-HLS #EXT-X-PART,
// #EXT-X-MAP and #EXT-X-PRELOAD-HINT — to carry the same token. Unsigned/expired
// -> 403.
function sign(payload: string): string {
  return createHmac("sha256", env.PLAYBACK_SECRET).update(payload).digest("hex");
}

// scope = channelId for live HLS, `vod.<streamId>` for replays (separate token spaces).
function tokenValid(scope: string, token: string | null, exp: string | null): boolean {
  if (!token || !exp) return false;
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
  const expected = sign(`${scope}.${e}`);
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
export async function mtxFetch(pathAndQuery: string): Promise<Response> {
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

// Merge the source and 480p multivariant playlists into one (benchmark G-05).
// Each MediaMTX path emits its own multivariant index with identical group ids,
// so the rendition's URIs get the `r480/` prefix and its groups a suffix.
// Returns null when either side is not a multivariant playlist (caller falls back).
const RENDITION_DIR = "r480/";
function mergeMultivariant(source: string, rendition: string): string | null {
  if (!source.includes("#EXT-X-STREAM-INF") || !rendition.includes("#EXT-X-STREAM-INF"))
    return null;
  const header = /^#(EXTM3U|EXT-X-VERSION|EXT-X-INDEPENDENT-SEGMENTS)/;
  const body = (text: string, prefix: string, suffix: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !header.test(l))
      .map((l) =>
        l.startsWith("#")
          ? l
              .replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${prefix}${u}"`)
              .replace(/GROUP-ID="([^"]+)"/g, (_m, g: string) => `GROUP-ID="${g}${suffix}"`)
              .replace(/AUDIO="([^"]+)"/g, (_m, g: string) => `AUDIO="${g}${suffix}"`)
          : `${prefix}${l}`,
      );
  const version = source.match(/#EXT-X-VERSION:\d+/)?.[0] ?? "#EXT-X-VERSION:9";
  return [
    "#EXTM3U",
    version,
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...body(source, "", ""),
    ...body(rendition, RENDITION_DIR, "_r480"),
    "",
  ].join("\n");
}

// Replays are plain files written by recorder.ts; only its own names are served.
const VOD_FILE = /^(index\.m3u8|seg\d{5}\.ts)$/;
const UUID = /^[0-9a-f-]{36}$/i;

export function startHlsServer(resolve: {
  sourcePath: (channelId: string) => string | undefined;
  hasRendition: (channelId: string) => boolean;
}): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    // CORS on every response (403/404 included): the player must read failure
    // statuses cross-origin to retry while a stream warms up.
    res.setHeader("Access-Control-Allow-Origin", "*");
    // The playback token rides in the URL query (player compatibility). Suppress
    // the Referer so that token-bearing URL never leaks to another origin via a
    // subsequent request (inbox/review.md P1-3). nosniff for good measure.
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
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

    const token = url.searchParams.get("token");
    const exp = url.searchParams.get("exp");

    // Replays (benchmark G-15): /vod/<streamId>/<file> from disk.
    const vod = url.pathname.match(/^\/vod\/([^/]+)\/([^/]+)$/);
    if (vod) {
      const [, streamId, file] = vod;
      if (!UUID.test(streamId!) || !VOD_FILE.test(file!)) {
        res.writeHead(404).end("not found");
        return;
      }
      if (!tokenValid(`vod.${streamId}`, token, exp)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const p = join(vodDir(streamId!), file!);
      if (!existsSync(p)) {
        res.writeHead(404).end("not found");
        return;
      }
      if (file === "index.m3u8") {
        const body = rewritePlaylist(readFileSync(p, "utf8"), `?token=${token}&exp=${exp}`);
        res.writeHead(200, {
          "Cache-Control": "no-cache",
          "Content-Type": "application/vnd.apple.mpegurl",
        });
        res.end(body);
      } else {
        res.writeHead(200, {
          "Cache-Control": "private, max-age=3600",
          "Content-Type": "video/mp2t",
        });
        createReadStream(p).pipe(res);
      }
      return;
    }

    const m = url.pathname.match(/^\/hls\/([^/]+)\/(.+)$/);
    if (!m) {
      res.writeHead(404).end("not found");
      return;
    }
    const [, channelId, rawFile] = m;
    if (!tokenValid(channelId!, token, exp)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const sourcePath = resolve.sourcePath(channelId!);
    if (!sourcePath) {
      res.writeHead(404).end("not found");
      return;
    }

    // Strip our token/exp but forward LL-HLS blocking-reload params
    // (_HLS_msn / _HLS_part / _HLS_skip) so low-latency delivery keeps working.
    const fwd = new URLSearchParams();
    for (const [k, v] of url.searchParams) if (k !== "token" && k !== "exp") fwd.set(k, v);
    const qs = fwd.toString();
    let safeFile = rawFile!.replace(/\.\.[/\\]/g, "");
    // `r480/...` addresses the channel's rendition path (benchmark G-05).
    let mtxPath = sourcePath;
    if (safeFile.startsWith(RENDITION_DIR)) {
      mtxPath = abrPath(channelId!);
      safeFile = safeFile.slice(RENDITION_DIR.length);
    }
    const upstream = `/${mtxPath}/${safeFile}${qs ? `?${qs}` : ""}`;
    const tokenQuery = `?token=${token}&exp=${exp}`;

    void (async () => {
      // The top-level index becomes source + 480p when a rendition is publishing.
      if (mtxPath === sourcePath && safeFile === "index.m3u8" && resolve.hasRendition(channelId!)) {
        try {
          const [a, b] = await Promise.all([
            mtxFetch(upstream),
            mtxFetch(`/${abrPath(channelId!)}/index.m3u8`),
          ]);
          if (a.status === 200) {
            const source = await a.text();
            const merged = b.status === 200 ? mergeMultivariant(source, await b.text()) : null;
            res.writeHead(200, {
              "Cache-Control": "no-cache",
              "Content-Type": a.headers.get("content-type") ?? "application/vnd.apple.mpegurl",
            });
            res.end(rewritePlaylist(merged ?? source, tokenQuery));
            return;
          }
        } catch {
          /* fall through to the plain source playlist */
        }
      }

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
        // Playlists need the full text for token re-signing (small, cheap).
        const body = rewritePlaylist(await r.text(), tokenQuery);
        res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": ct });
        res.end(body);
      } else {
        // Media (segments + LL-HLS parts/preload hints): stream bytes through as
        // they arrive. Buffering the whole part first added up to a part-duration
        // of latency per request on the low-latency path.
        res.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": ct });
        if (r.body) {
          Readable.fromWeb(r.body as import("node:stream/web").ReadableStream).pipe(res);
        } else {
          res.end();
        }
      }
    })();
  });

  server.listen(env.HTTP_PORT, () => {
    console.log(`svc-media hls proxy on :${env.HTTP_PORT} -> ${mtx.hlsOrigin}`);
  });
  return server;
}
