"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { Channel } from "@streamix/proto";
import { channelClient } from "@/lib/connect";
import { Player } from "@/components/player";
import { Chat } from "@/components/chat";

export default function WatchPage() {
  const { slug } = useParams<{ slug: string }>();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!slug) return;
    void (async () => {
      try {
        const res = await channelClient.getChannel({ slug });
        setChannel(res.channel ?? null);
        if (res.channel?.isLive) {
          const pb = await channelClient.getPlaybackUrl({ slug });
          setPlaybackUrl(pb.url);
        }
      } catch {
        setError("채널을 찾을 수 없습니다.");
      }
    })();
  }, [slug]);

  if (error) return <p className="text-zinc-400">{error}</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0">
        {channel?.isLive && playbackUrl ? (
          <Player src={playbackUrl} />
        ) : (
          <div className="grid aspect-video w-full place-items-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500">
            {channel ? "오프라인 방송입니다" : "불러오는 중…"}
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
