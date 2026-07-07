"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cloth, DEFAULT_PARAMS, type ClothParams } from "@/lib/tearable";

const COLLAPSE_FALLBACK_MS = 1600; // force reveal even if a few scraps linger

// `params` is held by reference — the lab page mutates it live for tuning.
type Options = { imageSrc: string; onReveal: () => void; params?: ClothParams };

export function useTearable({ imageSrc, onReveal, params }: Options) {
  const paramsRef = useRef<ClothParams>(params ?? DEFAULT_PARAMS);
  paramsRef.current = params ?? DEFAULT_PARAMS;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clothRef = useRef<Cloth | null>(null);
  const revealedRef = useRef(false);
  const [ready, setReady] = useState(false);

  const fireReveal = useCallback(() => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    onReveal();
  }, [onReveal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = 0;
    let frame = 0;
    let collapseTimer: ReturnType<typeof setTimeout> | null = null;
    let autoTimer: ReturnType<typeof setTimeout> | null = null;
    const drag = { on: false, x: 0, y: 0 };

    const triggerCollapse = () => {
      const cloth = clothRef.current;
      if (!cloth || cloth.isCollapsing) return;
      cloth.collapse();
      collapseTimer = setTimeout(fireReveal, COLLAPSE_FALLBACK_MS);
    };

    const sizeToParent = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      canvas.width = w; // CSS-resolution backing store (dpr=1) so the per-
      canvas.height = h; // triangle setTransform isn't fighting a base scale
      return { w, h };
    };

    const img = new Image();
    img.src = imageSrc;

    const start = () => {
      const { w, h } = sizeToParent();
      clothRef.current = new Cloth(img, w, h, paramsRef.current);
      setReady(true);

      // Safety net: drop the sheet on its own if the user can't tear enough.
      const autoMs = paramsRef.current.autoCollapseMs;
      if (autoMs > 0) autoTimer = setTimeout(triggerCollapse, autoMs);

      const loop = (t: number) => {
        const cloth = clothRef.current!;
        const dt = last ? Math.min(0.032, (t - last) / 1000) : 0.016;
        last = t;
        cloth.step(dt);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        cloth.draw(ctx);

        // Once enough of the sheet has come loose from the top, drop it all.
        // Connectivity is O(points) so only check a few times a second.
        frame++;
        if (
          !cloth.isCollapsing &&
          frame % 8 === 0 &&
          1 - cloth.attachedFraction() > paramsRef.current.revealRatio
        ) {
          triggerCollapse();
        }
        if (cloth.isCollapsing && cloth.allGone()) fireReveal();

        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    };

    if (img.complete && img.naturalWidth) start();
    else img.onload = start;

    const pos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      const p = pos(e);
      drag.on = true;
      drag.x = p.x;
      drag.y = p.y;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.on) return;
      const cloth = clothRef.current;
      if (!cloth) return;
      const p = pos(e);
      cloth.pointerGrab(p.x, p.y, cloth.tearRadius, { dx: p.x - drag.x, dy: p.y - drag.y });
      drag.x = p.x;
      drag.y = p.y;
    };
    const onUp = (e: PointerEvent) => {
      drag.on = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    const onCtx = (e: Event) => e.preventDefault(); // right-drag = cut, no menu

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("contextmenu", onCtx);

    const ro = new ResizeObserver(() => {
      const cloth = clothRef.current;
      if (!cloth || cloth.isCollapsing) return; // don't rebuild mid-collapse
      const { w, h } = sizeToParent();
      cloth.resize(w, h);
    });
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      if (collapseTimer) clearTimeout(collapseTimer);
      if (autoTimer) clearTimeout(autoTimer);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("contextmenu", onCtx);
    };
  }, [imageSrc, fireReveal]);

  const skip = useCallback(() => {
    const cloth = clothRef.current;
    if (!cloth) {
      fireReveal();
      return;
    }
    cloth.slice();
    setTimeout(fireReveal, COLLAPSE_FALLBACK_MS);
  }, [fireReveal]);

  return { canvasRef, ready, skip };
}
