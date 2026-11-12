"use client";

import { useQuery } from "@tanstack/react-query";
import { channelClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import { relativeLabel } from "@/lib/time";

// Live-room activity feed: recent follows, polled (benchmark G-14).
// ponytail: 5s polling; upgrade = push follow events over the chat socket.
export function ActivityFeed() {
  const token = useAuth((s) => s.token);
  const { data, isError } = useQuery({
    queryKey: ["recent-followers"],
    queryFn: async () =>
      (
        await channelClient.listRecentFollowers(
          {},
          { headers: { authorization: `Bearer ${token}` } },
        )
      ).followers,
    enabled: !!token,
    refetchInterval: 5000,
  });

  return (
    <section aria-labelledby="activity-heading" className="space-y-2">
      <h2 id="activity-heading" className="text-sm font-semibold">
        활동
      </h2>
      {isError && <p className="text-xs text-live">활동을 불러오지 못했습니다.</p>}
      {data?.length === 0 && <p className="text-xs text-zinc-400">아직 팔로워가 없습니다.</p>}
      <ul aria-live="polite" className="space-y-1 text-sm">
        {data?.slice(0, 8).map((f) => (
          <li key={`${f.displayName}-${f.followedAt}`} className="flex justify-between gap-2">
            <span className="min-w-0 truncate">
              <span className="font-semibold">{f.displayName}</span>님이 팔로우했습니다
            </span>
            <span className="shrink-0 text-xs text-zinc-400">{relativeLabel(f.followedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
