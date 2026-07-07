"use client";

import { ChannelCard } from "@/components/channel-card";
import { Reveal } from "@/components/reveal";
import { LandingGate } from "@/components/landing/landing-gate";
import { useLiveChannels } from "@/lib/hooks";

function CardSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="aspect-video rounded-lg bg-zinc-900" />
      <div className="mt-2.5 flex gap-2.5">
        <div className="size-8 shrink-0 rounded-full bg-zinc-900" />
        <div className="flex-1 space-y-1.5 py-0.5">
          <div className="h-3.5 w-3/4 rounded bg-zinc-900" />
          <div className="h-3 w-1/3 rounded bg-zinc-900" />
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { data: channels, isLoading } = useLiveChannels();

  return (
    <div>
      <LandingGate />
      <div className="mb-6 flex items-baseline gap-3">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">지금 라이브</h1>
        {channels && (
          <span className="font-mono text-sm text-zinc-500">{channels.length}개 방송 중</span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {isLoading && Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} />)}
        {channels?.map((channel, i) => (
          <Reveal key={channel.id} index={i}>
            <ChannelCard channel={channel} />
          </Reveal>
        ))}
      </div>

      {channels?.length === 0 && (
        <div className="grid place-items-center rounded-xl border border-dashed border-zinc-800 py-24 text-center">
          <p className="text-lg font-medium text-zinc-300">지금은 라이브 방송이 없어요</p>
          <p className="mt-1 text-sm text-zinc-500">OBS로 송출하면 여기에 바로 표시됩니다.</p>
        </div>
      )}
    </div>
  );
}
