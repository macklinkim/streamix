"use client";

import { useTearable } from "@/hooks/use-tearable";
import type { ClothParams } from "@/lib/tearable";

// The tearable cloth (Twitch.png) covering the login stage. Drag or right-drag
// to rip it; tear enough (or Skip) and it collapses under gravity to reveal the
// form behind. `params` lets the lab page tune the physics live.
export function TearableCurtain({
  onReveal,
  params,
  showChrome = true,
}: {
  onReveal: () => void;
  params?: ClothParams;
  showChrome?: boolean;
}) {
  const { canvasRef, ready, skip } = useTearable({ imageSrc: "/twitch.png", onReveal, params });

  return (
    <div className="absolute inset-0">
      <canvas ref={canvasRef} className="size-full cursor-grab touch-none active:cursor-grabbing" />

      {ready && showChrome && (
        <>
          <p className="pointer-events-none absolute inset-x-0 top-10 text-center text-sm font-medium tracking-[0.3em] text-white/70 uppercase drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
            드래그해서 찢어보세요
          </p>
          <button
            type="button"
            onClick={skip}
            className="absolute bottom-6 right-6 rounded-full border border-white/20 bg-black/40 px-4 py-2 text-xs font-medium tracking-wide text-white/80 backdrop-blur-sm transition-colors hover:border-[#9146FF]/60 hover:text-white"
          >
            [ Skip Animation ]
          </button>
        </>
      )}
    </div>
  );
}
