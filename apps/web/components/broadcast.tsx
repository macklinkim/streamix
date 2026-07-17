"use client";

import { useEffect, useRef, useState } from "react";
import {
  Broadcast as BroadcastIcon,
  StopCircle,
  VideoCamera,
  Monitor,
  CameraRotate,
  Warning,
} from "@phosphor-icons/react";
import { channelClient } from "@/lib/connect";

// Mobile phones need native (portrait) capture and front/back switching; desktops
// get a fixed 720p landscape + device pickers. Coarse UA check is enough here.
function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

type Facing = "user" | "environment";

// trim() guards against config junk (stray whitespace/BOM) breaking the WS URL.
const ingestUrl = (process.env.NEXT_PUBLIC_MEDIA_INGEST_URL ?? "ws://localhost:8090").trim();

// Browser broadcasting: getUserMedia (camera, default) or getDisplayMedia (screen)
// -> MediaRecorder -> WS /ingest -> svc-media ffmpeg -> the same RTMP/HLS pipeline
// OBS uses. Codec negotiation (ADR-9/ADR-12): prefer WebM/VP8, which MediaRecorder
// streams cleanly over the non-seekable ingest pipe and ffmpeg transcodes reliably
// (verified end-to-end on prod). The H.264 "copy" formats are demoted: both
// fragmented-MP4 ("moov atom not found") and Chromium's webm+H.264 fail to parse
// from a pipe. MP4 remains last so Safari (webm-less) still has an option — the
// R1 real-device case, validated separately on hardware.
function pickMimeType(): { mimeType: string; codec: string } | undefined {
  const candidates: Array<{ mimeType: string; codec: string }> = [
    { mimeType: "video/webm;codecs=vp8,opus", codec: "webm-vp8" },
    { mimeType: "video/webm", codec: "webm-vp8" },
    { mimeType: "video/webm;codecs=h264", codec: "webm-h264" },
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", codec: "mp4-h264" },
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
  if (name === "OverconstrainedError")
    return "선택한 장치를 사용할 수 없습니다. 분리되었을 수 있어요. 다른 카메라를 선택해 주세요.";
  return "장치를 열지 못했습니다. 다시 시도해 주세요.";
}

// A fresh short-lived ingest token is issued at go-live (ADR-13), so browsing
// broadcasting works after a reload without rotating the durable OBS key.
export function BroadcastPanel({ token }: { token: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cleanupRef = useRef<() => void>(() => {});
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState<Source>("camera");
  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [] });
  const [cameraId, setCameraId] = useState("");
  const [micId, setMicId] = useState("");
  const [facing, setFacing] = useState<Facing>("user");
  const [backgrounded, setBackgrounded] = useState(false);
  const [title, setTitle] = useState("");
  const [moreCameras, setMoreCameras] = useState(false);
  // Screen capture gating (ADR-15). Assume supported until mount decides, so SSR
  // markup matches; the effect below flips it on browsers without the API.
  const [screenBlocked, setScreenBlocked] = useState(false);
  const mobile = isMobile();

  useEffect(() => () => cleanupRef.current(), []);

  // (1) Existence detection. No mobile browser ships getDisplayMedia; when it is
  // missing the screen source is offered as an RTMP fallback instead of failing.
  useEffect(() => {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") setScreenBlocked(true);
  }, []);

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

  async function acquireStream(effFacing: Facing, effCameraId: string): Promise<MediaStream> {
    if (source === "screen") {
      return navigator.mediaDevices.getDisplayMedia({
        video: { width: 1280, height: 720, frameRate: 30 },
        audio: true,
      });
    }
    return navigator.mediaDevices.getUserMedia({
      // Mobile: let the device pick its native (portrait) resolution and select
      // the camera by facingMode — unless a specific device was picked from the
      // detailed list (multi-lens phones, iPad UVC), which overrides facingMode
      // (ADR-17). Desktop: fixed 720p landscape + deviceId.
      video: mobile
        ? effCameraId
          ? { deviceId: { exact: effCameraId }, frameRate: 30 }
          : { facingMode: effFacing, frameRate: 30 }
        : {
            width: 1280,
            height: 720,
            frameRate: 30,
            ...(effCameraId ? { deviceId: { exact: effCameraId } } : {}),
          },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(micId ? { deviceId: { exact: micId } } : {}),
      },
    });
  }

  async function start(effFacing: Facing = facing, effCameraId: string = cameraId) {
    setPhase("starting");
    setMessage("");

    let stream: MediaStream;
    try {
      stream = await acquireStream(effFacing, effCameraId);
    } catch (e) {
      // Screen picker cancel (NotAllowedError from getDisplayMedia) is not an
      // error state; a denied camera permission is.
      if (source === "screen" && e instanceof DOMException && e.name === "NotAllowedError") {
        // (2) Call-failure detection (ADR-15): some mobile browsers expose
        // getDisplayMedia but always reject it, which existence detection alone
        // can't catch. On mobile there is no picker to cancel, so a rejection
        // means "unsupported" — fall back to RTMP rather than silently idling.
        if (mobile) {
          setScreenBlocked(true);
          setSource("camera");
        }
        setPhase("idle");
        return;
      }
      setPhase("error");
      setMessage(errorMessage(e));
      return;
    }

    void refreshDevices(); // labels are available now that permission was granted
    if (videoRef.current) videoRef.current.srcObject = stream;

    // Issue a short-lived browser ingest token for this session (ADR-13).
    let ingestKey: string;
    try {
      const res = await channelClient.issueIngestToken(
        {},
        { headers: { authorization: `Bearer ${token}` } },
      );
      ingestKey = res.token;
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      setPhase("error");
      setMessage("방송 토큰 발급에 실패했습니다. 다시 시도해 주세요.");
      return;
    }

    // Optional broadcast title (empty leaves the existing title). Non-fatal —
    // a title update failure must not block going live.
    if (title.trim()) {
      try {
        await channelClient.updateChannel(
          { title: title.trim() },
          { headers: { authorization: `Bearer ${token}` } },
        );
      } catch {
        /* keep broadcasting with the old title */
      }
    }

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
      `${ingestUrl}/ingest?key=${encodeURIComponent(ingestKey)}${codecParam}`,
    );

    // Keep the phone awake while live; re-request on foreground (the lock is
    // auto-released when the tab hides). Warn if the app is backgrounded, since
    // MediaRecorder can be throttled/paused there (R3), and stop on pagehide.
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = () => {
      navigator.wakeLock
        ?.request("screen")
        .then((w) => {
          wakeLock = w;
        })
        .catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        setBackgrounded(true);
      } else {
        setBackgrounded(false);
        requestWakeLock();
      }
    };
    const onPageHide = () => stop();

    let stopped = false;
    const stop = (failMessage?: string) => {
      if (stopped) return;
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      void wakeLock?.release().catch(() => {});
      wakeLock = null;
      setBackgrounded(false);
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
      requestWakeLock();
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
    };
    ws.onclose = (e) => {
      if (stopped) return;
      stop(
        e.code === 4403
          ? "방송 세션이 만료되었습니다. 방송시작을 다시 눌러 주세요."
          : e.code === 4409
            ? "이미 다른 곳에서 이 채널을 방송 중입니다. 기존 방송을 종료한 뒤 다시 시도해 주세요."
            : `송출 연결이 끊어졌습니다. 다시 시도해 주세요. (코드 ${e.code})`,
      );
    };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === ws.OPEN) ws.send(e.data);
    };
    // Browser's own "공유 중지"/track-end (screen stop, device unplug) tears down.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
  }

  // Front/back switch = clean restart (ADR-14): MediaRecorder can't swap tracks,
  // so end the session and reconnect. The watch page's live/offline polling
  // auto-recovers the viewer across the few-second gap.
  async function switchCamera() {
    const next: Facing = facing === "user" ? "environment" : "user";
    setFacing(next);
    setCameraId(""); // the live switch is facingMode-based; drop any detailed pick
    cleanupRef.current();
    await start(next, "");
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

      {/* Title + source + device pickers stay editable only before going live. */}
      {!busy && (
        <div className="mt-3 space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={140}
            placeholder="방송 제목 (선택 — 비우면 기존 제목 유지)"
            aria-label="방송 제목"
            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200 placeholder:text-zinc-600"
          />
          <div className="flex gap-2">
            {(["camera", "screen"] as const).map((s) => (
              <button
                key={s}
                type="button"
                disabled={s === "screen" && screenBlocked}
                onClick={() => setSource(s)}
                className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
          {screenBlocked && (
            <p className="rounded-md bg-zinc-800/50 px-2 py-1.5 text-xs text-zinc-400">
              이 브라우저는 화면 송출을 지원하지 않습니다. RTMP를 지원하는 화면 송출 앱에서{" "}
              <a href="#rtmp" className="text-accent hover:underline">
                아래 장비 방송(RTMP) 주소
              </a>
              를 입력해 방송하세요. (권장 720p / 2.5Mbps)
            </p>
          )}
          {source === "camera" && mobile && (
            <div className="flex gap-2">
              {(["user", "environment"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    setFacing(f);
                    setCameraId(""); // preset overrides a detailed pick
                  }}
                  className={`h-9 flex-1 rounded-md border text-sm transition-colors ${
                    facing === f && !cameraId
                      ? "border-accent bg-accent/10 text-zinc-100"
                      : "border-zinc-800 text-zinc-400 hover:border-zinc-700"
                  }`}
                >
                  {f === "user" ? "전면" : "후면"}
                </button>
              ))}
            </div>
          )}
          {source === "camera" && mobile && (
            <div>
              <button
                type="button"
                onClick={() => setMoreCameras((v) => !v)}
                className="text-xs text-zinc-400 hover:text-zinc-200"
              >
                {moreCameras ? "카메라 접기" : "카메라 더 보기"}
              </button>
              {moreCameras && (
                <select
                  value={cameraId}
                  onChange={(e) => setCameraId(e.target.value)}
                  className="mt-2 h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200"
                  aria-label="카메라"
                >
                  <option value="">전/후면 프리셋 사용</option>
                  {devices.cameras.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `카메라 ${i + 1}`}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {source === "camera" && !mobile && (
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

      {/* object-contain letterboxes any ratio, so portrait phone video isn't cropped. */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`mt-3 max-h-[70vh] w-full rounded-md bg-zinc-950 object-contain ${
          busy ? "" : "hidden"
        }`}
      />
      {phase === "live" && backgrounded && (
        <p className="mt-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-400">
          <Warning size={14} weight="fill" /> 화면을 벗어나면 방송이 끊길 수 있어요. 이 탭을 열어
          두세요.
        </p>
      )}
      {phase === "live" && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-mono text-xs text-live">
            <span className="size-1.5 animate-pulse rounded-full bg-live" /> 송출 중, 이 미리보기가
            방송으로 나갑니다
          </p>
          {mobile && source === "camera" && (
            <button
              type="button"
              onClick={() => void switchCamera()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 px-2.5 text-xs text-zinc-300 transition-colors hover:border-zinc-700 active:scale-[0.98]"
            >
              <CameraRotate size={14} /> 카메라 전환
            </button>
          )}
        </div>
      )}
    </div>
  );
}
