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
    <div className="fixed inset-0 z-[100] overflow-hidden bg-zinc-950">
      {/* Designed login stage behind the cloth (cyberpunk dark + purple glow). */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,rgba(145,70,255,0.18),transparent_60%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(10,10,12,0.4),rgba(10,10,12,0.9))]" />

      <div className="absolute inset-0 grid place-items-center p-4">
        <div
          className={`transition-all duration-700 ${
            phase === "revealed"
              ? "translate-y-0 opacity-100 blur-0"
              : "pointer-events-none translate-y-3 opacity-0 blur-sm"
          }`}
        >
          <LandingLogin onDone={() => setVisible(false)} />
        </div>
      </div>

      {phase === "curtain" && <TearableCurtain onReveal={() => setPhase("revealed")} />}
    </div>
  );
}
