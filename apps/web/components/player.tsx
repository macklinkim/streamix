"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Level = { index: number; height: number };

// LL-HLS playback (ADR-3). Native HLS on Safari; hls.js elsewhere, with a simple
// reload-on-fatal retry so the player recovers while a stream is warming up.
// `live={false}` plays a replay (benchmark G-15): no low-latency tuning.
export function Player({
  src,
  onAuthError,
  live = true,
}: {
  src: string;
  onAuthError?: () => void;
  live?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // Quality ladder (benchmark G-05): shown only when the playlist offers >1 level.
  const [levels, setLevels] = useState<Level[]>([]);
  const [level, setLevel] = useState(-1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    // Prefer hls.js (MSE transmux) where supported. Chromium reports "maybe" for
    // native HLS but cannot demux TS, so native is only the Safari/iOS fallback.
    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) video.src = src;
      return;
    }

    const hls = new Hls({ lowLatencyMode: live, backBufferLength: 30 });
    hlsRef.current = hls;
    let retry: ReturnType<typeof setTimeout> | undefined;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      setLevels(
        data.levels
          .map((l, index) => ({ index, height: l.height }))
          .filter((l) => l.height > 0)
          .sort((a, b) => b.height - a.height),
      );
    });
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (data.response?.code === 403) {
          onAuthError?.();
          return;
        }
        // Stream may still be warming up (manifest 404s right after going live).
        // A fatal manifest error kills the loader, so re-load the source fully.
        retry = setTimeout(() => {
          hls.loadSource(src);
          hls.startLoad();
        }, 2000);
      } else {
        hls.recoverMediaError();
      }
    });
    return () => {
      clearTimeout(retry);
      hls.destroy();
      hlsRef.current = null;
      setLevels([]);
      setLevel(-1);
    };
  }, [src, onAuthError, live]);

  return (
    <div className="relative">
      <video
        ref={videoRef}
        controls
        autoPlay
        muted
        playsInline
        className="aspect-video w-full rounded-lg bg-black object-contain"
      />
      {levels.length > 1 && (
        <label className="absolute right-2 top-2">
          <span className="sr-only">화질</span>
          <select
            value={level}
            onChange={(e) => {
              const next = Number(e.target.value);
              setLevel(next);
              if (hlsRef.current) hlsRef.current.currentLevel = next; // -1 = auto (ABR)
            }}
            className="h-8 rounded bg-black/70 px-2 text-xs text-zinc-100 focus:outline-2 focus:outline-accent"
          >
            <option value={-1}>자동</option>
            {levels.map((l) => (
              <option key={l.index} value={l.index}>
                {l.height}p
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
