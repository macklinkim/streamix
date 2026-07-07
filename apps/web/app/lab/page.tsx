"use client";

import { useReducer, useRef, useState } from "react";
import { TearableCurtain } from "@/components/landing/tearable-curtain";
import { DEFAULT_PARAMS, type ClothParams } from "@/lib/tearable";

// Hidden tuning page (not linked anywhere). Drag to tear, move the sliders to
// change the physics live — no rebuild, no deploy. When it feels right, hit
// "config 복사" and send the JSON; those values get baked into DEFAULT_PARAMS.
const SLIDERS: { key: keyof ClothParams; label: string; min: number; max: number; step: number }[] =
  [
    {
      key: "cutStretch",
      label: "cutStretch (드래그 절단, 낮을수록 잘 찢김)",
      min: 1.05,
      max: 3,
      step: 0.05,
    },
    { key: "pull", label: "pull (커서로 당기는 힘)", min: 0.05, max: 0.6, step: 0.01 },
    { key: "momentum", label: "momentum (드래그 관성)", min: 0, max: 1, step: 0.05 },
    { key: "radiusMul", label: "radiusMul (찢기 반경)", min: 0.8, max: 3, step: 0.1 },
    { key: "tearFactor", label: "tearFactor (자동 과신장 절단)", min: 1.2, max: 6, step: 0.1 },
    { key: "iterations", label: "iterations (뻣뻣함)", min: 1, max: 6, step: 1 },
    { key: "damping", label: "damping (낮을수록 출렁임)", min: 0.9, max: 1, step: 0.005 },
    { key: "gravity", label: "gravity (붕괴 낙하 속도)", min: 200, max: 4000, step: 50 },
    {
      key: "revealRatio",
      label: "revealRatio (자동 넘어가는 찢김 비율)",
      min: 0.1,
      max: 0.9,
      step: 0.05,
    },
  ];

const btn =
  "flex-1 rounded-md border border-white/15 bg-white/5 px-2 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10";

export default function LabPage() {
  const paramsRef = useRef<ClothParams>({ ...DEFAULT_PARAMS });
  const [, force] = useReducer((x) => x + 1, 0);
  const [armKey, setArmKey] = useState(0);
  const [copied, setCopied] = useState(false);

  const set = (k: keyof ClothParams, v: number) => {
    paramsRef.current[k] = v;
    force();
  };
  const reArm = () => setArmKey((k) => k + 1); // remount => fresh, un-torn sheet
  const toDefaults = () => {
    paramsRef.current = { ...DEFAULT_PARAMS };
    setArmKey((k) => k + 1);
  };
  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(paramsRef.current, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="fixed inset-0 z-[100] overflow-hidden">
      {/* branded backdrop so torn holes show purple, matching the real landing */}
      <div className="absolute inset-0 bg-[linear-gradient(160deg,#4a2f95_0%,#2c1e63_50%,#170f36_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_44%,rgba(167,112,255,0.6),transparent_65%)]" />

      {/* key re-arms the cloth on reset / auto-reveal */}
      <TearableCurtain
        key={armKey}
        params={paramsRef.current}
        onReveal={reArm}
        showChrome={false}
      />

      <div className="absolute left-4 top-4 max-h-[calc(100vh-2rem)] w-80 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/85 p-4 text-zinc-200 backdrop-blur-md">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-sm font-bold tracking-wide">🧪 Tear Lab</h1>
          <span className="font-mono text-[10px] text-zinc-500">/lab</span>
        </div>

        <div className="space-y-3">
          {SLIDERS.map((s) => (
            <label key={s.key} className="block">
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-400">{s.label}</span>
                <span className="font-mono text-[#c9b3ff]">{paramsRef.current[s.key]}</span>
              </div>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={paramsRef.current[s.key]}
                onChange={(e) => set(s.key, parseFloat(e.target.value))}
                className="mt-1 w-full accent-[#9146FF]"
              />
            </label>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={reArm} className={btn}>
            다시 찢기
          </button>
          <button type="button" onClick={toDefaults} className={btn}>
            기본값
          </button>
          <button
            type="button"
            onClick={copy}
            className={`${btn} border-[#9146FF]/40 bg-[#9146FF]/15 text-[#c9b3ff]`}
          >
            {copied ? "복사됨 ✓" : "config 복사"}
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
          드래그로 찢고 슬라이더로 즉시 튜닝. 마음에 들면 <b>config 복사</b> 눌러 값 전달하면
          기본값에 반영·배포.
        </p>
      </div>
    </div>
  );
}
