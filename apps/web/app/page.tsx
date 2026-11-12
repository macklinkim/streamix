"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChannelCard } from "@/components/channel-card";
import { Reveal } from "@/components/reveal";
import { LandingGate } from "@/components/landing/landing-gate";
import { useLiveChannels } from "@/lib/hooks";
import { useAuth } from "@/lib/auth-store";
import { CHANNEL_CATEGORIES } from "@streamix/schemas";

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
  const [category, setCategory] = useState("");
  const { data: channels, isLoading, isError, refetch } = useLiveChannels(category);
  const user = useAuth((s) => s.user);
  const [oauthPending, setOauthPending] = useState(false);

  useEffect(() => {
    setOauthPending(new URLSearchParams(window.location.search).get("oauth") === "pending");
  }, []);

  return (
    <div>
      <LandingGate />
      {oauthPending && (
        <p
          role="status"
          className="mb-5 rounded-lg border border-accent/40 bg-accent/10 p-4 text-sm text-zinc-200"
        >
          트위치 가입 신청이 접수됐습니다. 관리자 승인 후 로그인할 수 있습니다.
        </p>
      )}
      <div className="mb-6 flex items-baseline gap-3">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">지금 라이브</h1>
        {channels && (
          <span className="font-mono text-sm text-zinc-500">{channels.length}개 방송 중</span>
        )}
      </div>

      <div role="group" aria-label="카테고리" className="mb-6 flex flex-wrap gap-2">
        {["", ...CHANNEL_CATEGORIES].map((c) => (
          <button
            key={c || "all"}
            type="button"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              category === c
                ? "bg-zinc-100 text-zinc-950"
                : "border border-zinc-800 text-zinc-300 hover:border-zinc-600"
            }`}
          >
            {c || "전체"}
          </button>
        ))}
      </div>

      {isError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-live/30 bg-zinc-900 p-4 text-sm text-zinc-200"
        >
          방송 목록을 불러오지 못했습니다.
          <button onClick={() => void refetch()} className="ml-2 text-accent hover:underline">
            다시 시도
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {isLoading && Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} />)}
        {channels?.map((channel, i) => (
          <Reveal key={channel.id} index={i}>
            <ChannelCard channel={channel} />
          </Reveal>
        ))}
      </div>

      {!isError && channels?.length === 0 && (
        <div className="grid place-items-center rounded-xl border border-dashed border-zinc-800 py-24 text-center">
          <div>
            <p className="text-lg font-medium text-zinc-300">
              {category ? `지금은 ${category} 라이브 방송이 없어요` : "지금은 라이브 방송이 없어요"}
            </p>
            <p className="mt-1 text-sm text-zinc-500">새 방송을 15초마다 자동으로 확인합니다.</p>
            <button
              onClick={() => void refetch()}
              className="mt-3 text-sm text-accent hover:underline"
            >
              지금 다시 확인
            </button>
            {user && (
              <p className="mt-3 text-sm text-zinc-400">
                직접 방송하시나요?{" "}
                <Link href="/studio" className="text-accent hover:underline">
                  스튜디오에서 시작하기
                </Link>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
