"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Code, ConnectError } from "@connectrpc/connect";
import { useParams } from "next/navigation";
import { channelClient } from "@/lib/connect";
import { Player } from "@/components/player";
import { Chat } from "@/components/chat";
import { FollowButton } from "@/components/follow-button";
import { relativeLabel } from "@/lib/time";
import { VideoList } from "@/components/video-list";
import { ArrowsIn, ArrowsOut } from "@phosphor-icons/react";

// One id per browser tab so a viewer is counted once (benchmark G-21).
// sessionStorage can be unavailable (private mode / blocked) -> in-memory id.
let memoryViewerId = "";
function tabViewerId(): string {
  try {
    const id = sessionStorage.getItem("streamix_viewer_id") ?? crypto.randomUUID();
    sessionStorage.setItem("streamix_viewer_id", id);
    return id;
  } catch {
    return (memoryViewerId ||= crypto.randomUUID());
  }
}

export default function WatchPage() {
  const { slug } = useParams<{ slug: string }>();

  // Poll the channel so offline→online (and back) transitions without reload.
  const channelQuery = useQuery({
    queryKey: ["channel", slug],
    queryFn: async () => (await channelClient.getChannel({ slug })).channel ?? null,
    enabled: !!slug,
    retry: false,
    refetchInterval: (q) =>
      q.state.status === "error" && !q.state.data ? false : q.state.data?.isLive ? 15_000 : 5_000,
  });

  const channel = channelQuery.data;
  const playbackQuery = useQuery({
    queryKey: ["playback", slug],
    queryFn: () => channelClient.getPlaybackUrl({ slug }),
    enabled: !!channel?.isLive,
    retry: false,
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expiresAt;
      return expiresAt ? Math.max(15_000, Number(expiresAt) * 1000 - Date.now() - 30_000) : false;
    },
  });
  const refreshPlayback = useCallback(() => {
    void playbackQuery.refetch();
  }, [playbackQuery.refetch]);

  // Presence beat while a live player is mounted; the viewer count is playback
  // presence, not chat sockets. Failures are ignored (count is best-effort).
  const watchingId = channel?.isLive && playbackQuery.data?.url ? channel.id : "";
  useEffect(() => {
    if (!watchingId) return;
    const viewerId = tabViewerId();
    const beat = () =>
      void channelClient.watchHeartbeat({ channelId: watchingId, viewerId }).catch(() => {});
    beat();
    const timer = setInterval(beat, 30_000);
    return () => clearInterval(timer);
  }, [watchingId]);

  // Theatre mode (benchmark G-06): player + chat take the viewport; Esc exits.
  const [theater, setTheater] = useState(false);
  useEffect(() => {
    if (!theater) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTheater(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theater]);

  if (!channel && (channelQuery.isError || channelQuery.isSuccess)) {
    const notFound =
      (channelQuery.isSuccess && !channel) ||
      (channelQuery.error instanceof ConnectError && channelQuery.error.code === Code.NotFound);
    return (
      <div className="space-y-3 text-zinc-400">
        <p>{notFound ? "채널을 찾을 수 없습니다." : "채널을 불러오지 못했습니다."}</p>
        {!notFound && (
          <button
            onClick={() => void channelQuery.refetch()}
            className="text-accent hover:underline"
          >
            다시 시도
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={
        theater
          ? "fixed inset-x-0 bottom-0 top-16 z-30 grid gap-2 overflow-y-auto bg-black p-2 lg:grid-cols-[1fr_340px]"
          : "grid gap-4 lg:grid-cols-[1fr_340px]"
      }
    >
      <div className="min-w-0">
        {channelQuery.isError && (
          <p role="alert" className="mb-2 text-sm text-live">
            채널 상태를 갱신하지 못했습니다.
            <button
              onClick={() => void channelQuery.refetch()}
              className="ml-2 text-accent hover:underline"
            >
              다시 시도
            </button>
          </p>
        )}
        {channel?.isLive && playbackQuery.data?.url ? (
          <>
            <Player src={playbackQuery.data.url} onAuthError={refreshPlayback} />
            {playbackQuery.isError && (
              <p className="mt-2 text-sm text-live" role="alert">
                재생 연결을 갱신하지 못했습니다. 잠시 후 다시 시도하세요.
                <button
                  onClick={() => void playbackQuery.refetch()}
                  className="ml-2 text-accent hover:underline"
                >
                  다시 시도
                </button>
              </p>
            )}
          </>
        ) : (
          <div className="grid aspect-video w-full place-items-center rounded-lg border border-zinc-800 bg-zinc-900">
            {channel?.isLive ? (
              <div className="text-center">
                <p className="text-zinc-400">
                  {playbackQuery.isError ? "재생 연결에 실패했습니다." : "재생 준비 중…"}
                </p>
                {playbackQuery.isError && (
                  <button
                    onClick={() => void playbackQuery.refetch()}
                    className="mt-2 text-sm text-accent hover:underline"
                  >
                    다시 시도
                  </button>
                )}
              </div>
            ) : channel ? (
              <div className="text-center">
                <p className="text-zinc-300">오프라인 방송입니다</p>
                <p className="mt-1 text-sm text-zinc-400">
                  {channel.lastLiveAt > 0n
                    ? `마지막 방송 ${relativeLabel(channel.lastLiveAt)}`
                    : "아직 방송한 적이 없습니다"}
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  방송이 시작되면 자동으로 재생됩니다. 팔로우하면 사이드바에서 바로 확인할 수
                  있어요.
                </p>
              </div>
            ) : (
              <p className="text-zinc-500">불러오는 중…</p>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <span className="size-11 shrink-0 rounded-full bg-gradient-to-br from-accent to-zinc-700" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold">{channel?.title ?? slug}</h1>
            <p className="truncate text-sm text-zinc-400">
              {channel?.slug}
              {channel?.category && <span className="ml-2">· {channel.category}</span>}
              {channel?.isLive && (
                <span className="ml-2 font-mono text-live">● 시청자 {channel.viewerCount}</span>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-pressed={theater}
            onClick={() => setTheater((t) => !t)}
            className="hidden items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500 lg:flex"
          >
            {theater ? <ArrowsIn className="size-4" /> : <ArrowsOut className="size-4" />}
            {theater ? "극장 모드 종료" : "극장 모드"}
          </button>
          {channel && <FollowButton channel={channel} />}
        </div>
        {channel && !theater && <VideoList slug={channel.slug} />}
      </div>

      <div className={theater ? "h-[60vh] lg:h-full" : "h-[70vh] lg:h-[calc(100dvh-8rem)]"}>
        {channel && <Chat channelId={channel.id} />}
      </div>
    </div>
  );
}
