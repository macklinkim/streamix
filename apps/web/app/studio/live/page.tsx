"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { channelClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import { clockLabel } from "@/lib/format";
import { BroadcastPanel } from "@/components/broadcast";
import { Chat } from "@/components/chat";
import { ModeratorList } from "@/components/moderator-list";
import { StreamHistory, useMyStreams } from "@/components/stream-history";
import { ActivityFeed } from "@/components/activity-feed";

// Ticks every second from the server-recorded stream start (unix seconds).
function LiveClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{clockLabel(now / 1000 - since)}</>;
}

export default function LiveStudioPage() {
  const { token, ready } = useAuth();
  const [broadcasting, setBroadcasting] = useState(false);
  const historyGuardRef = useRef(false);

  // Leaving this page unmounts BroadcastPanel, which stops the stream (U01):
  // confirm in-app link clicks, back navigation, and reload/close while live.
  useEffect(() => {
    if (!broadcasting) return;
    const ask = () => window.confirm("이 페이지를 벗어나면 송출이 종료됩니다. 이동할까요?");
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    // Capture phase on document runs before Next's <Link> handler on the React root.
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank") return;
      if (a.origin !== location.origin || a.pathname === location.pathname) return;
      if (!ask()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Back can't be cancelled, so sit on a duplicate entry of this URL and
    // decide on popstate. Next's own state is copied, so its router stays put.
    // ponytail: the duplicate entry outlives the broadcast (one extra Back press
    // afterwards); upgrade = pop it on stop if it is still the current entry.
    if (!historyGuardRef.current) {
      history.pushState(history.state, "", location.href);
      historyGuardRef.current = true;
    }
    let leaving = false;
    const onPopState = () => {
      if (leaving) return;
      if (ask()) {
        leaving = true;
        historyGuardRef.current = false;
        history.back();
      } else history.pushState(history.state, "", location.href);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
    };
  }, [broadcasting]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["my-channel"],
    queryFn: () =>
      channelClient.getMyChannel({}, { headers: { authorization: `Bearer ${token}` } }),
    enabled: ready && !!token,
    refetchInterval: 5000,
  });

  // Status bar (benchmark G-22). The live row appears when the server registers
  // the publish, so refresh streams as soon as the channel flips live/offline.
  const serverLive = data?.channel?.isLive ?? false;
  const queryClient = useQueryClient();
  const { data: streams } = useMyStreams();
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["my-streams"] });
  }, [serverLive, queryClient]);

  if (!ready || (token && isLoading))
    return (
      <p role="status" className="py-12 text-zinc-400">
        방송실을 준비하고 있습니다…
      </p>
    );

  if (!token)
    return (
      <div className="space-y-3 py-12 text-center">
        <p>방송실에 입장하려면 로그인이 필요합니다.</p>
        <Link href="/login" className="inline-block text-accent hover:underline">
          로그인하기
        </Link>
      </div>
    );

  if (isError && !data)
    return (
      <div role="alert" className="space-y-3 py-12 text-center">
        <p>방송실 정보를 불러오지 못했습니다.</p>
        <button onClick={() => void refetch()} className="text-accent hover:underline">
          다시 시도
        </button>
      </div>
    );

  const channel = data?.channel;
  if (!channel)
    return (
      <div className="space-y-3 py-12 text-center">
        <p>방송실에 입장하기 전에 채널을 만들어 주세요.</p>
        <Link href="/studio" className="inline-block text-accent hover:underline">
          채널 만들기
        </Link>
      </div>
    );

  const live = broadcasting || channel.isLive;
  const liveSince = channel.isLive ? streams?.find((s) => s.live)?.startedAt : undefined;
  // "Is the server actually receiving?" — isLive comes from the media server's
  // publish hook, so it also covers OBS/RTMP. Browser sending without it yet =
  // the ingest hasn't reached the server (connecting, or stuck).
  const [statusText, statusClass] = channel.isLive
    ? ["● LIVE 수신 중", "text-live"]
    : broadcasting
      ? ["서버 수신 대기 중…", "text-amber-400"]
      : ["오프라인", "text-zinc-400"];
  return (
    <div className="mx-auto max-w-6xl space-y-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">방송 관리</h1>
          <p className="mt-1 break-words text-sm text-zinc-300">{channel.title}</p>
          <p className="mt-1 text-xs text-zinc-400">/{channel.slug}</p>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <div>
              <dt className="sr-only">송출 상태</dt>
              <dd className={statusClass}>{statusText}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-zinc-400">경과</dt>
              <dd className="font-mono tabular-nums">
                {liveSince ? <LiveClock since={Number(liveSince)} /> : "-:--:--"}
              </dd>
            </div>
            <div>
              <dt className="sr-only">시청자 수</dt>
              <dd>시청자 {channel.viewerCount}명</dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/studio"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-600"
          >
            방송 설정 ↗
          </Link>
          <Link
            href={`/watch/${channel.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-accent/50 bg-accent/10 px-3 py-2 text-sm text-zinc-100 hover:bg-accent/20"
          >
            내 방송 보기 ↗
          </Link>
        </div>
      </div>
      <p className="text-xs text-zinc-400">
        이 방송실을 열어둔 상태로 송출·채팅을 관리하세요. 시청 화면과 설정은 새 탭으로 열립니다.
      </p>
      {isError && (
        <p role="alert" className="text-sm text-live">
          방송 상태를 갱신하지 못했습니다. 잠시 후 다시 확인합니다.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <BroadcastPanel token={token} onLiveChange={setBroadcasting} />
          {!live && <StreamHistory latestOnly />}
          <ActivityFeed />
        </div>
        <div className="min-w-0 space-y-4">
          <section aria-label="방송 채팅 관리" className="h-[min(70vh,640px)] min-h-96">
            <Chat channelId={channel.id} />
          </section>
          <ModeratorList />
        </div>
      </div>
    </div>
  );
}
