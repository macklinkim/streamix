"use client";

import { useQuery } from "@tanstack/react-query";
import { channelClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import { durationLabel } from "@/lib/format";

const dateFmt = new Intl.DateTimeFormat("ko", { dateStyle: "medium", timeStyle: "short" });

// end = 0 while live -> measured up to now.
const duration = (start: bigint, end: bigint) =>
  durationLabel(Number(end || BigInt(Math.floor(Date.now() / 1000))) - Number(start));

// Shared with the live room's status bar (G-22), which reads the live row's start.
export function useMyStreams() {
  const token = useAuth((s) => s.token);
  return useQuery({
    queryKey: ["my-streams"],
    queryFn: async () =>
      (await channelClient.listMyStreams({}, { headers: { authorization: `Bearer ${token}` } }))
        .streams,
    enabled: !!token,
    refetchInterval: 15_000,
  });
}

// Post-broadcast summary (benchmark G-13). `latestOnly` = the live room's
// "last broadcast" card; otherwise the studio's recent-broadcast table.
export function StreamHistory({ latestOnly = false }: { latestOnly?: boolean }) {
  const { data, isError, refetch } = useMyStreams();

  if (isError)
    return (
      <p role="alert" className="text-xs text-live">
        방송 기록을 불러오지 못했습니다.
        <button onClick={() => void refetch()} className="ml-2 text-accent hover:underline">
          다시 시도
        </button>
      </p>
    );
  if (!data) return null;

  if (latestOnly) {
    const last = data.find((s) => !s.live);
    if (!last) return null;
    return (
      <section
        aria-labelledby="last-stream-heading"
        className="rounded-lg border border-zinc-800 p-4"
      >
        <h2 id="last-stream-heading" className="text-sm font-semibold">
          지난 방송 요약
        </h2>
        <p className="mt-1 text-xs text-zinc-400">
          {dateFmt.format(Number(last.startedAt) * 1000)}
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div>
            <dt className="text-xs text-zinc-400">방송 시간</dt>
            <dd className="font-mono text-lg">{duration(last.startedAt, last.endedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-400">최대 시청자</dt>
            <dd className="font-mono text-lg">{last.peakViewers}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-400">채팅</dt>
            <dd className="font-mono text-lg">{last.chatMessages}</dd>
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section aria-labelledby="stream-history-heading" className="space-y-2">
      <h2 id="stream-history-heading" className="text-lg font-semibold">
        최근 방송
      </h2>
      {data.length === 0 ? (
        <p className="text-sm text-zinc-400">아직 방송 기록이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="text-xs text-zinc-400">
              <tr>
                <th scope="col" className="py-2 font-medium">
                  시작
                </th>
                <th scope="col" className="py-2 font-medium">
                  방송 시간
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  최대 시청자
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  채팅
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="border-t border-zinc-800">
                  <td className="py-2">
                    {dateFmt.format(Number(s.startedAt) * 1000)}
                    {s.live && <span className="ml-2 text-xs font-semibold text-live">● LIVE</span>}
                  </td>
                  <td className="py-2 font-mono">{duration(s.startedAt, s.endedAt)}</td>
                  <td className="py-2 text-right font-mono">{s.peakViewers}</td>
                  <td className="py-2 text-right font-mono">{s.chatMessages}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
