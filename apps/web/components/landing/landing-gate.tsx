"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { landingSeen, markLandingSeen } from "@/lib/landing-visibility";
import { useAuth } from "@/lib/auth-store";
import { LandingLogin } from "./landing-login";
import { TearableCurtain } from "./tearable-curtain";

type Phase = "curtain" | "revealed";

// First-screen gate: shows the tearable curtain over a hidden login stage.
// Shown once per local calendar day. Signing up and browsing remain reachable without tearing.
export function LandingGate() {
  const ready = useAuth((state) => state.ready);
  const user = useAuth((state) => state.user);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("curtain");
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready) return;
    if (user) {
      setVisible(false);
      return;
    }
    if (!landingSeen()) {
      markLandingSeen();
      setVisible(true);
    }
  }, [ready, user]);

  useEffect(() => {
    if (!visible) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const overlay = overlayRef.current;
    const background = [
      document.querySelector("header"),
      document.querySelector("aside"),
      ...Array.from(overlay?.parentElement?.children ?? []).filter((el) => el !== overlay),
    ].filter((el): el is HTMLElement => el instanceof HTMLElement);
    const previous = background.map((el) => el.inert);
    background.forEach((el) => (el.inert = true));
    const priorFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      document.body.style.overflow = prev;
      background.forEach((el, i) => (el.inert = previous[i]!));
      if (priorFocus?.isConnected) priorFocus.focus();
      else document.querySelector<HTMLElement>("header a")?.focus();
    };
  }, [visible]);

  useEffect(() => {
    if (visible && phase === "revealed") document.getElementById("landing-email")?.focus();
  }, [visible, phase]);

  if (!visible) return null;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="landing-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") setVisible(false);
        if (event.key !== "Tab") return;
        const items = Array.from(
          overlayRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], input:not([disabled])",
          ) ?? [],
        ).filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
        if (!items.length) return;
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }}
      className="fixed inset-0 z-[100] overflow-hidden"
    >
      {/* Designed login stage behind the cloth — a branded dark-purple scene, not
          a black void, so torn holes read as "our screen" showing through. */}
      <div className="absolute inset-0 bg-[linear-gradient(160deg,#4a2f95_0%,#2c1e63_50%,#170f36_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_44%,rgba(167,112,255,0.65),transparent_65%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_16%,rgba(180,120,255,0.35),transparent_48%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_88%,rgba(145,70,255,0.3),transparent_45%)]" />

      {/* Login stage sits BEHIND the cloth and is already visible, so tearing
          holes in the cloth reveals the real form (not a black void). On full
          reveal it just pops forward and becomes interactive. */}
      <div className="absolute inset-0 grid place-items-center p-4">
        <div
          inert={phase !== "revealed"}
          aria-hidden={phase !== "revealed"}
          className={`transition-all duration-500 ${
            phase === "revealed"
              ? "scale-100 opacity-100"
              : "pointer-events-none scale-[0.97] opacity-100"
          }`}
        >
          <LandingLogin onDone={() => setVisible(false)} />
        </div>
      </div>

      {phase === "curtain" && (
        <>
          <TearableCurtain
            onReveal={() => setPhase("revealed")}
            onSkip={() => setPhase("revealed")}
          />
          <Link
            href="/signup"
            className="absolute bottom-6 left-6 z-10 rounded-full border border-white/30 bg-black/60 px-4 py-3 text-sm font-semibold text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            회원가입 신청
          </Link>
        </>
      )}
    </div>
  );
}
