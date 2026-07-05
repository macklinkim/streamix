"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { channelClient } from "@/lib/connect";
import { Player } from "@/components/player";
import { Chat } from "@/components/chat";

export default function WatchPage() {
  const { slug } = useParams<{ slug: string }>();

  // Poll the channel so offline→online (and back) transitions without reload.
  const { data: channel, isError } = useQuery({
    queryKey: ["channel", slug],
    queryFn: async () => (await channelClient.getChannel({ slug })).channel ?? null,
    enabled: !!slug,
    refetchInterval: (q) => (q.state.data?.isLive ? 15_000 : 5_000),
  });

  const { data: playbackUrl } = useQuery({
    queryKey: ["playback", slug],
    queryFn: async () => (await channelClient.getPlaybackUrl({ slug })).url,
    enabled: !!channel?.isLive,
  });

  if (isError) return <p className="text-zinc-400">채널을 찾을 수 없습니다.</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0">
        {channel?.isLive && playbackUrl ? (
          <Player src={playbackUrl} />
        ) : (
          <div className="grid aspect-video w-full place-items-center rounded-lg border border-zinc-800 bg-zinc-900">
            {channel ? (
              <div className="text-center">
                <p className="text-zinc-400">오프라인 방송입니다</p>
                <p className="mt-1 text-xs text-zinc-600">방송이 시작되면 자동으로 재생됩니다</p>
              </div>
            ) : (
              <p className="text-zinc-500">불러오는 중…</p>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <span className="size-11 shrink-0 rounded-full bg-gradient-to-br from-accent to-zinc-700" />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold">{channel?.title ?? slug}</h1>
            <p className="truncate text-sm text-zinc-400">
              {channel?.slug}
              {channel?.isLive && (
                <span className="ml-2 font-mono text-live">● 시청자 {channel.viewerCount}</span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="h-[70vh] lg:h-[calc(100dvh-8rem)]">
        {channel && <Chat channelId={channel.id} />}
      </div>
    </div>
  );
}
