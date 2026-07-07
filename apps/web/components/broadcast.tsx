"use client";

import { useEffect, useRef, useState } from "react";
import {
  Broadcast as BroadcastIcon,
  StopCircle,
  VideoCamera,
  Monitor,
} from "@phosphor-icons/react";

// trim() guards against config junk (stray whitespace/BOM) breaking the WS URL.
const ingestUrl = (process.env.NEXT_PUBLIC_MEDIA_INGEST_URL ?? "ws://localhost:8090").trim();

// Browser broadcasting: getUserMedia (camera, default) or getDisplayMedia (screen)
// -> MediaRecorder -> WS /ingest -> svc-media ffmpeg -> the same RTMP/HLS pipeline
// OBS uses. Codec negotiation (ADR-9/ADR-12): prefer formats the server can remux
// without re-encoding (mp4/H.264 -> full copy, webm/H.264 -> video copy); VP8
// falls back to full transcoding server-side.
function pickMimeType(): { mimeType: string; codec: string } | undefined {
  const candidates: Array<{ mimeType: string; codec: string }> = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", codec: "mp4-h264" },
    { mimeType: "video/webm;codecs=h264", codec: "webm-h264" },
    { mimeType: "video/webm;codecs=vp8,opus", codec: "webm-vp8" },
    { mimeType: "video/webm", codec: "webm-vp8" },
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mimeType));
}

type Phase = "idle" | "starting" | "live" | "error";
type Source = "camera" | "screen";

// enumerateDevices only returns labels after a permission grant; before that the
// selects stay on "기본 장치" and getUserMedia uses the browser default.
type Devices = { cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[] };

function errorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError")
    return "카메라·마이크 권한이 거부되었습니다. 브라우저 주소창의 권한을 허용해 주세요.";
  if (name === "NotFoundError") return "사용할 수 있는 카메라·마이크를 찾지 못했습니다.";
  if (name === "NotReadableError")
    return "카메라·마이크를 다른 앱이 사용 중입니다. 해당 앱을 닫고 다시 시도해 주세요.";
  return "장치를 열지 못했습니다. 다시 시도해 주세요.";
}

export function BroadcastPanel({ streamKey }: { streamKey: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cleanupRef = useRef<() => void>(() => {});
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState<Source>("camera");
  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [] });
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");

  useEffect(() => () => cleanupRef.current(), []);

  // Populate device selects. Labels are hidden until the site has been granted
  // permission once, so re-run enumeration after every successful capture.
  async function refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        cameras: all.filter((d) => d.kind === "videoinput"),
        mics: all.filter((d) => d.kind === "audioinput"),
      });
    } catch {
      /* enumeration unsupported/blocked -> keep defaults */
    }
  }
  useEffect(() => {
    void refreshDevices();
  }, []);

  async function acquireStream(): Promise<MediaStream> {
    if (source === "screen") {
      return navigator.mediaDevices.getDisplayMedia({
        video: { width: 1280, height: 720, frameRate: 30 },
        audio: true,
      });
    }
    return navigator.mediaDevices.getUserMedia({
      video: {
        width: 1280,
        height: 720,
        frameRate: 30,
        ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(micId ? { deviceId: { exact: micId } } : {}),
      },
    });
  }

  async function start() {
    setPhase("starting");
    setMessage("");

    let stream: MediaStream;
    try {
      stream = await acquireStream();
    } catch (e) {
      // Screen picker cancel (NotAllowedError from getDisplayMedia) is not an
      // error state; a denied camera permission is.
      if (source === "screen" && e instanceof DOMException && e.name === "NotAllowedError") {
        setPhase("idle");
        return;
      }
      setPhase("error");
      setMessage(errorMessage(e));
      return;
    }

    void refreshDevices(); // labels are available now that permission was granted
    if (videoRef.current) videoRef.current.srcObject = stream;

    const picked = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: picked?.mimeType,
        videoBitsPerSecond: 2_500_000,
      });
    } catch {
      // No supported MediaRecorder config for this stream (older Safari, etc.).
      stream.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      setPhase("error");
      setMessage("이 브라우저는 방송 인코딩을 지원하지 않습니다.");
      return;
    }

    const codecParam = picked ? `&codec=${picked.codec}` : "";
    const ws = new WebSocket(
      `${ingestUrl}/ingest?key=${encodeURIComponent(streamKey)}${codecParam}`,
    );

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
          : `송출 연결이 끊어졌습니다. 다시 시도해 주세요. (코드 ${e.code})`,
      );
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === ws.OPEN) ws.send(e.data);
    };
    // Browser's own "공유 중지"/track-end (screen stop, device unplug) tears down.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
  }

  const busy = phase === "starting" || phase === "live";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">방송시작</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            카메라나 화면을 OBS 없이 바로 송출합니다. 시청자에게는 몇 초 뒤에 보입니다.
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
            {phase === "starting" ? "시작하는 중…" : "방송시작"}
          </button>
        )}
      </div>

      {/* Source + device pickers stay editable only before going live. */}
      {!busy && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            {(["camera", "screen"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-sm transition-colors ${
                  source === s
                    ? "border-accent bg-accent/10 text-zinc-100"
                    : "border-zinc-800 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                {s === "camera" ? <VideoCamera size={16} /> : <Monitor size={16} />}
                {s === "camera" ? "카메라" : "화면"}
              </button>
            ))}
          </div>
          {source === "camera" && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select
                value={cameraId}
                onChange={(e) => setCameraId(e.target.value)}
                className="h-9 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
                aria-label="카메라"
              >
                <option value="">기본 카메라</option>
                {devices.cameras.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `카메라 ${i + 1}`}
                  </option>
                ))}
              </select>
              <select
                value={micId}
                onChange={(e) => setMicId(e.target.value)}
                className="h-9 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
                aria-label="마이크"
              >
                <option value="">기본 마이크</option>
                {devices.mics.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `마이크 ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {phase === "error" && <p className="mt-3 text-xs text-live">{message}</p>}

      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`mt-3 aspect-video w-full rounded-md bg-zinc-950 ${busy ? "" : "hidden"}`}
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
