"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { channelClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";

// Broadcaster-only list of chat moderators (benchmark G-09). Appointing happens
// from a chat message; this is where moderators who are not chatting are removed.
// Collapsed by default (G-23): rarely needed while live, so it stays out of the way.
export function ModeratorList() {
  const token = useAuth((s) => s.token);
  const queryClient = useQueryClient();
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const { data, isError, refetch } = useQuery({
    queryKey: ["moderators"],
    queryFn: async () => (await channelClient.listModerators({}, auth)).moderators,
    enabled: !!token,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => channelClient.removeModerator({ userId }, auth),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["moderators"] }),
  });

  return (
    <details className="space-y-2">
      <summary className="cursor-pointer select-none text-sm font-semibold">
        모더레이터 관리{data ? ` (${data.length}명)` : ""}
      </summary>
      {isError && (
        <p role="alert" className="text-xs text-live">
          모더레이터 목록을 불러오지 못했습니다.
          <button onClick={() => void refetch()} className="ml-2 text-accent hover:underline">
            다시 시도
          </button>
        </p>
      )}
      {data?.length === 0 && (
        <p className="text-xs text-zinc-400">
          아직 없습니다. 채팅에서 이름을 눌러 모더레이터로 지정하세요.
        </p>
      )}
      <ul className="space-y-1">
        {data?.map((m) => (
          <li key={m.userId} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">{m.displayName}</span>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate(m.userId)}
              className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
            >
              해제
            </button>
          </li>
        ))}
      </ul>
      {remove.isError && (
        <p role="alert" className="text-xs text-live">
          해제하지 못했습니다. 다시 시도하세요.
        </p>
      )}
    </details>
  );
}
