"use client";

import { useEffect, useRef } from "react";
import Hls from "hls.js";

// LL-HLS playback (ADR-3). Native HLS on Safari; hls.js elsewhere, with a simple
// reload-on-fatal retry so the player recovers while a stream is warming up.
export function Player({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    // Prefer hls.js (MSE transmux) where supported. Chromium reports "maybe" for
    // native HLS but cannot demux TS, so native is only the Safari/iOS fallback.
    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) video.src = src;
      return;
    }

    const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // Stream may still be warming up (manifest 404s right after going live).
        // A fatal manifest error kills the loader, so re-load the source fully.
        setTimeout(() => {
          hls.loadSource(src);
          hls.startLoad();
        }, 2000);
      } else {
        hls.recoverMediaError();
      }
    });
    return () => hls.destroy();
  }, [src]);

  return (
    <video
      ref={videoRef}
      controls
      autoPlay
      muted
      playsInline
      className="aspect-video w-full rounded-lg bg-black"
    />
  );
}
