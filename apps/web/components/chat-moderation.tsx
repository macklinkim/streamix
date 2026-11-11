"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ModerationAction } from "@streamix/proto";
import { channelClient, chatClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import type { ChatLine, ChatRoleName, RoomState } from "./chat";

const btn =
  "rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-50";
const dangerBtn =
  "rounded border border-live/40 px-2 py-1.5 text-xs text-live hover:border-live disabled:opacity-50";

// Broadcaster/moderator controls (benchmark G-09/G-10/G-19/G-20). The BFF
// re-checks every permission; hiding buttons here is only for clarity.
export function ChatModeration({
  channelId,
  role,
  state,
  selected,
  onClose,
  onBlockedTermsSaved,
}: {
  channelId: string;
  role: ChatRoleName;
  state: RoomState;
  selected: ChatLine | null;
  onClose: () => void;
  onBlockedTermsSaved: (terms: string[]) => void;
}) {
  const { token, user } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [termsDraft, setTermsDraft] = useState<string | null>(null);
  const auth = { headers: { authorization: `Bearer ${token}` } };

  async function run(label: string, fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await fn();
      setStatus(label);
    } catch {
      setError("채팅 관리 설정을 변경하지 못했습니다. 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  }

  const moderate = (
    label: string,
    action: ModerationAction,
    opts: { durationSeconds?: number; targetUserId?: string; messageId?: string } = {},
  ) =>
    run(label, () =>
      chatClient.moderate(
        {
          channelId,
          action,
          durationSeconds: opts.durationSeconds ?? 0,
          targetUserId: opts.targetUserId ?? "",
          messageId: opts.messageId ?? "",
        },
        auth,
      ),
    );

  const target = selected;
  const targetIsBroadcaster = target?.badges?.includes("broadcaster") ?? false;
  const targetIsModerator = target?.badges?.includes("moderator") ?? false;
  const canTargetUser =
    !!target &&
    target.userId !== user?.id &&
    !targetIsBroadcaster &&
    (role === "broadcaster" || !targetIsModerator);
  const terms = termsDraft ?? (state.blockedTerms ?? []).join(", ");

  return (
    <div className="space-y-2 border-b border-zinc-800 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <label className="flex items-center gap-2">
          슬로우모드
          <select
            aria-label="슬로우모드"
            value={String(state.slowSeconds)}
            disabled={busy}
            onChange={(e) => {
              const seconds = Number(e.target.value);
              void moderate(
                seconds
                  ? `슬로우모드를 ${seconds}초로 설정했습니다.`
                  : "슬로우모드를 해제했습니다.",
                ModerationAction.SLOWMODE,
                { durationSeconds: seconds },
              );
            }}
            className="h-8 rounded border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 focus:outline-2 focus:outline-accent disabled:opacity-50"
          >
            <option value="0">해제</option>
            <option value="5">5초</option>
            <option value="10">10초</option>
            <option value="30">30초</option>
            {![0, 5, 10, 30].includes(state.slowSeconds) && (
              <option value={String(state.slowSeconds)}>{state.slowSeconds}초</option>
            )}
          </select>
        </label>
        <button
          type="button"
          aria-pressed={state.followersOnly}
          disabled={busy}
          onClick={() =>
            void moderate(
              state.followersOnly ? "팔로워 전용을 해제했습니다." : "팔로워 전용으로 바꿨습니다.",
              ModerationAction.FOLLOWERS_ONLY,
              { durationSeconds: state.followersOnly ? 0 : 1 },
            )
          }
          className={
            state.followersOnly ? "rounded bg-zinc-100 px-2 py-1.5 text-xs text-zinc-950" : btn
          }
        >
          팔로워 전용 {state.followersOnly ? "켜짐" : "꺼짐"}
        </button>
      </div>

      <details className="text-xs text-zinc-400">
        <summary className="cursor-pointer select-none">
          금지어 관리 ({state.blockedTerms?.length ?? 0}개)
        </summary>
        <div className="mt-2 space-y-2">
          <label className="block">
            <span className="sr-only">금지어 목록</span>
            <textarea
              value={terms}
              onChange={(e) => setTermsDraft(e.target.value)}
              rows={2}
              placeholder="쉼표로 구분 (대소문자 무시, 포함되면 차단)"
              className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-zinc-200 placeholder:text-zinc-500 focus:outline-2 focus:outline-accent"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            className={btn}
            onClick={() => {
              const next = [
                ...new Set(
                  terms
                    .split(/[,\n]/)
                    .map((t) => t.trim().toLowerCase())
                    .filter(Boolean),
                ),
              ];
              void run(`금지어 ${next.length}개를 저장했습니다.`, async () => {
                await chatClient.setBlockedTerms({ channelId, terms: next }, auth);
                onBlockedTermsSaved(next);
                setTermsDraft(null);
              });
            }}
          >
            금지어 저장
          </button>
        </div>
      </details>

      {target ? (
        <div className="space-y-2 rounded-md bg-zinc-950 p-3">
          <p className="break-words text-sm font-semibold">{target.displayName}님의 메시지</p>
          <p className="line-clamp-2 break-words text-xs text-zinc-400">{target.text}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              className={btn}
              onClick={() =>
                void moderate("메시지를 삭제했습니다.", ModerationAction.DELETE_MESSAGE, {
                  messageId: target.id,
                })
              }
            >
              메시지 삭제
            </button>
            {state.pinned?.id === target.id ? (
              <button
                type="button"
                disabled={busy}
                className={btn}
                onClick={() => void moderate("고정을 해제했습니다.", ModerationAction.UNPIN)}
              >
                고정 해제
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                className={btn}
                onClick={() =>
                  void moderate("메시지를 고정했습니다.", ModerationAction.PIN, {
                    messageId: target.id,
                  })
                }
              >
                고정
              </button>
            )}
            {canTargetUser && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  className={dangerBtn}
                  onClick={() =>
                    void moderate(
                      `${target.displayName}님의 채팅을 10분간 금지했습니다.`,
                      ModerationAction.BAN,
                      { targetUserId: target.userId, durationSeconds: 600 },
                    )
                  }
                >
                  10분 채팅 금지
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={dangerBtn}
                  onClick={() => {
                    if (!window.confirm(`${target.displayName}님을 영구적으로 채팅 금지할까요?`))
                      return;
                    void moderate(
                      `${target.displayName}님을 영구 채팅 금지했습니다.`,
                      ModerationAction.BAN,
                      { targetUserId: target.userId, durationSeconds: 0 },
                    );
                  }}
                >
                  영구 금지
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={btn}
                  onClick={() =>
                    void moderate(
                      `${target.displayName}님의 채팅 금지를 해제했습니다.`,
                      ModerationAction.UNBAN,
                      { targetUserId: target.userId },
                    )
                  }
                >
                  금지 해제
                </button>
              </>
            )}
            {role === "broadcaster" && target.userId !== user?.id && (
              <button
                type="button"
                disabled={busy}
                className={btn}
                onClick={() =>
                  void run(
                    targetIsModerator
                      ? `${target.displayName}님을 모더레이터에서 해제했습니다.`
                      : `${target.displayName}님을 모더레이터로 지정했습니다.`,
                    async () => {
                      if (targetIsModerator)
                        await channelClient.removeModerator({ userId: target.userId }, auth);
                      else await channelClient.addModerator({ userId: target.userId }, auth);
                      await queryClient.invalidateQueries({ queryKey: ["moderators"] });
                    },
                  )
                }
              >
                {targetIsModerator ? "모더레이터 해제" : "모더레이터 지정"}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded px-2 py-1.5 text-xs text-zinc-400 disabled:opacity-50"
            >
              닫기
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-zinc-400">채팅 작성자 이름을 눌러 메시지·사용자를 관리하세요.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-live">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="text-xs text-emerald-400">
          {status}
        </p>
      )}
    </div>
  );
}
