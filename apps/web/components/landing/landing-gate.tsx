"use client";

import { useEffect, useState } from "react";
import { landingHidden } from "@/lib/landing-visibility";
import { LandingLogin } from "./landing-login";
import { TearableCurtain } from "./tearable-curtain";

type Phase = "curtain" | "revealed";

// First-screen gate: shows the tearable curtain over a hidden login stage.
// Suppressed for the rest of the day if the user checked "오늘은 보지 않기".
export function LandingGate() {
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("curtain");

  useEffect(() => {
    if (!landingHidden()) setVisible(true);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden">
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
          className={`transition-all duration-500 ${
            phase === "revealed"
              ? "scale-100 opacity-100"
              : "pointer-events-none scale-[0.97] opacity-100"
          }`}
        >
          <LandingLogin onDone={() => setVisible(false)} />
        </div>
      </div>

      {phase === "curtain" && <TearableCurtain onReveal={() => setPhase("revealed")} />}
    </div>
  );
}
