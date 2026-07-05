"use client";

import { useEffect, useRef, useState } from "react";
import { Broadcast as BroadcastIcon, StopCircle } from "@phosphor-icons/react";

const ingestUrl = process.env.NEXT_PUBLIC_MEDIA_INGEST_URL ?? "ws://localhost:8090";

// Browser screen-share broadcasting: getDisplayMedia -> MediaRecorder(webm)
// -> WS /ingest -> svc-media ffmpeg -> the same RTMP/HLS pipeline OBS uses.
function pickMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=h264,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

type Phase = "idle" | "starting" | "live" | "error";

export function ScreenBroadcast({ streamKey }: { streamKey: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cleanupRef = useRef<() => void>(() => {});
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => () => cleanupRef.current(), []);

  async function start() {
    setPhase("starting");
    setMessage("");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1280, height: 720, frameRate: 30 },
        audio: true,
      });
    } catch {
      setPhase("idle"); // user cancelled the picker
      return;
    }

    if (videoRef.current) videoRef.current.srcObject = stream;

    const ws = new WebSocket(`${ingestUrl}/ingest?key=${encodeURIComponent(streamKey)}`);
    const recorder = new MediaRecorder(stream, {
      mimeType: pickMimeType(),
      videoBitsPerSecond: 2_500_000,
    });

    let stopped = false;
    const stop = (failMessage?: string) => {
      if (stopped) return;
      stopped = true;
      if (recorder.state !== "inactive") recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
      if (videoRef.current) videoRef.current.srcObject = null;
      if (failMessage) {
        setPhase("error");
        setMessage(failMessage);
      } else {
        setPhase("idle");
      }
    };
    cleanupRef.current = () => stop();

    ws.onopen = () => {
      recorder.start(500); // 500ms chunks keep ingest latency low
      setPhase("live");
    };
    ws.onclose = (e) => {
      if (stopped) return;
      stop(
        e.code === 4403
          ? "스트림 키가 유효하지 않습니다. 키를 재발급해 주세요."
          : "송출 연결이 끊어졌습니다. 다시 시도해 주세요.",
      );
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === ws.OPEN) ws.send(e.data);
    };
    // Browser's own "공유 중지" button ends the track -> tear down cleanly.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">브라우저로 화면 방송</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            OBS 없이 내 화면을 바로 송출합니다. 시청자에게는 몇 초 뒤에 보입니다.
          </p>
        </div>
        {phase === "live" ? (
          <button
            onClick={() => cleanupRef.current()}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-live/15 px-3 text-sm font-semibold text-live transition-colors hover:bg-live/25 active:scale-[0.98]"
          >
            <StopCircle size={16} weight="fill" /> 방송 종료
          </button>
        ) : (
          <button
            onClick={() => void start()}
            disabled={phase === "starting"}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-accent-hover active:scale-[0.98] disabled:opacity-50"
          >
            <BroadcastIcon size={16} weight="fill" />
            {phase === "starting" ? "시작하는 중…" : "화면 공유 시작"}
          </button>
        )}
      </div>

      {phase === "error" && <p className="mt-3 text-xs text-live">{message}</p>}

      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`mt-3 aspect-video w-full rounded-md bg-zinc-950 ${
          phase === "live" || phase === "starting" ? "" : "hidden"
        }`}
      />
      {phase === "live" && (
        <p className="mt-2 flex items-center gap-1.5 font-mono text-xs text-live">
          <span className="size-1.5 animate-pulse rounded-full bg-live" /> 송출 중, 이 미리보기가
          방송으로 나갑니다
        </p>
      )}
    </div>
  );
}
