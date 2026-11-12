"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { channelClient } from "@/lib/connect";
import { ChannelCard } from "@/components/channel-card";

function SearchResults() {
  const router = useRouter();
  const q = (useSearchParams().get("q") ?? "").trim();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["search", q],
    queryFn: async () => (await channelClient.searchChannels({ query: q })).channels,
    enabled: q.length > 0,
  });

  return (
    <div>
      <form
        role="search"
        className="mb-6 max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          const next = String(new FormData(e.currentTarget).get("q") ?? "").trim();
          if (next) router.push(`/search?q=${encodeURIComponent(next)}`);
        }}
      >
        <label className="block">
          <span className="sr-only">채널 검색</span>
          <input
            key={q}
            type="search"
            name="q"
            defaultValue={q}
            maxLength={50}
            autoFocus={!q}
            placeholder="채널 이름·제목·카테고리"
            className="h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm placeholder:text-zinc-400 focus:border-accent focus:outline-none"
          />
        </label>
      </form>

      {q && (
        <h1 className="mb-4 text-xl font-bold tracking-tight">
          ‘{q}’ 검색 결과
          {data && <span className="ml-2 font-mono text-sm text-zinc-400">{data.length}개</span>}
        </h1>
      )}

      {isError && (
        <div role="alert" className="rounded-lg border border-live/30 bg-zinc-900 p-4 text-sm">
          검색하지 못했습니다.
          <button onClick={() => void refetch()} className="ml-2 text-accent hover:underline">
            다시 시도
          </button>
        </div>
      )}
      {isLoading && (
        <p role="status" className="text-sm text-zinc-400">
          검색 중…
        </p>
      )}
      {data?.length === 0 && (
        <p className="text-sm text-zinc-400">
          일치하는 채널이 없습니다. 다른 단어로 검색해 보세요.
        </p>
      )}

      <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {data?.map((channel) => (
          <ChannelCard key={channel.id} channel={channel} />
        ))}
      </div>
    </div>
  );
}

// useSearchParams needs a Suspense boundary for static prerendering.
export default function SearchPage() {
  return (
    <Suspense>
      <SearchResults />
    </Suspense>
  );
}
