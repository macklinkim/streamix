"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Code, ConnectError } from "@connectrpc/connect";
import { channelClient } from "@/lib/connect";
import { Player } from "@/components/player";
import { durationLabel } from "@/lib/format";

const dateFmt = new Intl.DateTimeFormat("ko", { dateStyle: "long", timeStyle: "short" });

// Replay page (benchmark G-15). The signed URL lasts hours; a 403 re-issues it.
export default function VideoPage() {
  const { id } = useParams<{ id: string }>();
  const vod = useQuery({
    queryKey: ["vod", id],
    queryFn: () => channelClient.getVodUrl({ streamId: id }),
    enabled: !!id,
    retry: false,
  });
  const refresh = useCallback(() => {
    void vod.refetch();
  }, [vod.refetch]);

  if (vod.isError) {
    const gone = vod.error instanceof ConnectError && vod.error.code === Code.NotFound;
    return (
      <div className="space-y-3 text-zinc-400">
        <p>
          {gone
            ? "다시보기를 찾을 수 없습니다. 보관 기간이 지났을 수 있어요."
            : "다시보기를 불러오지 못했습니다."}
        </p>
        {!gone && (
          <button onClick={() => void vod.refetch()} className="text-accent hover:underline">
            다시 시도
          </button>
        )}
      </div>
    );
  }

  const v = vod.data;
  return (
    <div className="mx-auto max-w-5xl">
      {v ? (
        <Player src={v.url} onAuthError={refresh} live={false} />
      ) : (
        <div className="grid aspect-video w-full place-items-center rounded-lg border border-zinc-800 bg-zinc-900">
          <p className="text-zinc-400">불러오는 중…</p>
        </div>
      )}
      {v && (
        <div className="mt-4">
          <h1 className="text-lg font-bold">{v.channelTitle} 다시보기</h1>
          <p className="text-sm text-zinc-400">
            {dateFmt.format(Number(v.startedAt) * 1000)} · {durationLabel(v.durationSeconds)} ·{" "}
            <Link href={`/watch/${v.channelSlug}`} className="text-accent hover:underline">
              @{v.channelSlug} 채널로
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
