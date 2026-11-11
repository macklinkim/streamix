"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Play } from "@phosphor-icons/react";
import { channelClient } from "@/lib/connect";
import { relativeLabel } from "@/lib/time";
import { durationLabel } from "@/lib/format";

// A channel's replays within the retention window (benchmark G-15).
export function VideoList({ slug }: { slug: string }) {
  const { data, isError, refetch } = useQuery({
    queryKey: ["videos", slug],
    queryFn: async () => (await channelClient.listVideos({ slug })).videos,
  });

  if (isError)
    return (
      <p role="alert" className="text-sm text-live">
        다시보기를 불러오지 못했습니다.
        <button onClick={() => void refetch()} className="ml-2 text-accent hover:underline">
          다시 시도
        </button>
      </p>
    );
  if (!data?.length) return null;

  return (
    <section aria-labelledby="videos-heading" className="mt-6">
      <h2 id="videos-heading" className="mb-3 text-base font-semibold">
        다시보기
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {data.map((v) => (
          <li key={v.streamId}>
            <Link
              href={`/videos/${v.streamId}`}
              className="flex items-center gap-3 rounded-lg border border-zinc-800 p-3 hover:border-zinc-600"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-md bg-zinc-900">
                <Play weight="fill" className="size-4 text-accent" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{relativeLabel(v.startedAt)} 방송</span>
                <span className="block text-xs text-zinc-400">
                  {durationLabel(v.durationSeconds)} · 최대 시청자 {v.peakViewers}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
