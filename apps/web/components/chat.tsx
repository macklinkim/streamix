"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowBendUpLeft,
  PaperPlaneRight,
  PushPin,
  ShieldCheck,
  VideoCamera,
  X,
} from "@phosphor-icons/react";
import { ModerationAction } from "@streamix/proto";
import { chatClient, wsUrl } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import { ChatModeration } from "./chat-moderation";

export type ChatLine = {
  id: string;
  userId: string;
  displayName: string;
  text: string;
  badges?: string[];
  replyToId?: string;
  replyToName?: string;
  replyToText?: string;
};
export type ChatRoleName = "broadcaster" | "moderator" | "viewer";
export type RoomState = {
  slowSeconds: number;
  followersOnly: boolean;
  pinned: Pick<ChatLine, "id" | "userId" | "displayName" | "text"> | null;
  blockedTerms?: string[];
};

const EMPTY_ROOM: RoomState = { slowSeconds: 0, followersOnly: false, pinned: null };

function errorText(code: string): string {
  switch (code) {
    case "rate_limited":
      return "너무 빠르게 보내고 있습니다. 잠시 후 다시 시도하세요.";
    case "slowmode_active":
      return "슬로우 모드입니다. 잠시 후 다시 보내세요.";
    case "followers_only":
      return "팔로워 전용 채팅입니다. 채널을 팔로우하면 참여할 수 있어요.";
    case "blocked_term":
      return "이 채널에서 금지한 단어가 포함되어 보낼 수 없습니다.";
    case "banned":
      return "이 채널에서 채팅이 금지된 상태입니다.";
    case "validation":
      return "메시지는 1~500자여야 합니다.";
    default:
      return "메시지를 보내지 못했습니다. 다시 시도하세요.";
  }
}

function Badges({ badges }: { badges?: string[] }) {
  if (!badges?.length) return null;
  return (
    <>
      {badges.includes("broadcaster") && (
        <span
          title="방송자"
          className="mr-1 inline-grid size-4 place-items-center rounded-sm bg-live align-[-2px]"
        >
          <VideoCamera weight="fill" className="size-3 text-white" aria-hidden="true" />
          <span className="sr-only">방송자</span>
        </span>
      )}
      {badges.includes("moderator") && (
        <span
          title="모더레이터"
          className="mr-1 inline-grid size-4 place-items-center rounded-sm bg-emerald-600 align-[-2px]"
        >
          <ShieldCheck weight="fill" className="size-3 text-white" aria-hidden="true" />
          <span className="sr-only">모더레이터</span>
        </span>
      )}
    </>
  );
}

export function Chat({ channelId }: { channelId: string }) {
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState<ChatRoleName>("viewer");
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM);
  const [selected, setSelected] = useState<ChatLine | null>(null);
  const [replyTo, setReplyTo] = useState<ChatLine | null>(null);
  const token = useAuth((s) => s.token);
  const userId = useAuth((s) => s.user?.id);
  const myName = useAuth((s) => s.user?.displayName);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<string | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Follow new messages only while the reader is at the bottom (U04).
  const followRef = useRef(true);
  const [unread, setUnread] = useState(0);
  const privileged = role !== "viewer";

  useEffect(() => {
    if (!token) return; // chat requires auth (login first)

    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const applyState = (state: RoomState) =>
      // Blocked terms arrive only in the join frame (moderators); broadcasts omit them.
      setRoom((prev) => ({ ...state, blockedTerms: state.blockedTerms ?? prev.blockedTerms }));

    const connect = () => {
      // Token is NOT in the URL (leaks into logs); it's sent as the first frame
      // and the server replies {type:"ready"} once authed (P1-3).
      const ws = new WebSocket(`${wsUrl}/ws?channelId=${channelId}`);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
      ws.onclose = () => {
        setConnected(false);
        if (pendingRef.current) {
          pendingRef.current = null;
          clearTimeout(ackTimerRef.current);
          setSending(false);
          setError(
            "연결이 끊겨 전송을 확인하지 못했습니다. 채팅 목록을 확인한 뒤 다시 시도하세요.",
          );
        }
        if (!closed) retry = setTimeout(connect, 2000); // auto-reconnect (룸 재조인)
      };
      ws.onmessage = (evt) => {
        const m = JSON.parse(evt.data);
        if (m.type === "ready") {
          setRole(m.role === "broadcaster" || m.role === "moderator" ? m.role : "viewer");
          return setConnected(true);
        }
        if (m.type === "error") {
          pendingRef.current = null;
          clearTimeout(ackTimerRef.current);
          setSending(false);
          setError(errorText(String(m.code)));
          return;
        }
        // Frames: chat lines (no type) and room events (delete/clear_user/state),
        // alone or coalesced in a batch.
        const frames: Record<string, unknown>[] =
          m.type === "batch" && Array.isArray(m.items) ? m.items : [m];
        const items: ChatLine[] = [];
        const deleted = new Set<string>();
        const cleared = new Set<string>();
        for (const f of frames) {
          if (f.type === "delete") deleted.add(String(f.id));
          else if (f.type === "clear_user") cleared.add(String(f.userId));
          else if (f.type === "state") applyState(f.state as RoomState);
          else if (!f.type && f.text) items.push(f as unknown as ChatLine);
        }
        if (items.length || deleted.size || cleared.size) {
          // Read the DOM now: a pending scroll event may not have updated the ref yet.
          const el = listRef.current;
          if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          // ponytail: trimming the head shifts a reader's scroll position, so while
          // they read history keep up to 1000; past that the view jumps (anchor-restore upgrade).
          const keep = followRef.current ? 200 : 1000;
          const visible = (x: ChatLine) => !deleted.has(x.id) && !cleared.has(x.userId);
          setMessages((prev) => [...prev, ...items].filter(visible).slice(-keep));
          setReplyTo((r) => (r && visible(r) ? r : null));
          if (!followRef.current && items.length) setUnread((n) => n + items.length);
        }
        if (
          pendingRef.current &&
          items.some((it) => it.userId === userId && it.text === pendingRef.current)
        ) {
          const sent = pendingRef.current;
          pendingRef.current = null;
          clearTimeout(ackTimerRef.current);
          setSending(false);
          setDraft((current) => (current === sent ? "" : current));
          setReplyTo(null);
          setError("");
        }
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(ackTimerRef.current);
      wsRef.current?.close();
    };
  }, [channelId, token, userId]);

  useEffect(() => {
    if (followRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (followRef.current) setUnread(0);
  };

  const jumpToLatest = () => {
    followRef.current = true;
    setUnread(0);
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  };

  const send = () => {
    const text = draft.trim();
    if (!text || sending || !connected || wsRef.current?.readyState !== WebSocket.OPEN) return;
    jumpToLatest(); // your own message should be visible
    pendingRef.current = text;
    setSending(true);
    setError("");
    wsRef.current.send(JSON.stringify({ type: "send", text, replyToId: replyTo?.id ?? "" }));
    ackTimerRef.current = setTimeout(() => {
      pendingRef.current = null;
      setSending(false);
      setError("전송을 확인하지 못했습니다. 채팅 목록을 확인한 뒤 다시 시도하세요.");
    }, 10_000);
  };

  const unpin = () =>
    void chatClient
      .moderate(
        {
          channelId,
          action: ModerationAction.UNPIN,
          targetUserId: "",
          durationSeconds: 0,
          messageId: "",
        },
        { headers: { authorization: `Bearer ${token}` } },
      )
      .catch(() => setError("고정을 해제하지 못했습니다. 다시 시도하세요."));

  const hasToken = Boolean(token);
  const reduce = useReducedMotion();
  const modes = [
    room.slowSeconds > 0 && `슬로우 ${room.slowSeconds}초`,
    room.followersOnly && "팔로워 전용",
  ].filter(Boolean);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold">채팅</h2>
        <span className="flex items-center gap-2 text-xs text-zinc-400">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-600"}`}
          />
          {!hasToken ? "로그인 필요" : connected ? "연결됨" : "연결 중…"}
        </span>
      </div>

      {modes.length > 0 && (
        <p className="border-b border-zinc-800 px-4 py-1.5 text-xs text-zinc-300">
          채팅 모드: {modes.join(" · ")}
        </p>
      )}

      {room.pinned && (
        <div className="flex items-start gap-2 border-b border-zinc-800 bg-zinc-950/60 px-4 py-2 text-sm">
          <PushPin
            weight="fill"
            className="mt-0.5 size-4 shrink-0 text-accent"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 break-words">
            <span className="sr-only">고정된 메시지: </span>
            <span className="font-semibold text-accent">{room.pinned.displayName}</span>{" "}
            <span className="text-zinc-200">{room.pinned.text}</span>
          </p>
          {privileged && (
            <button
              type="button"
              onClick={unpin}
              className="shrink-0 text-xs text-zinc-400 hover:text-zinc-100"
            >
              고정 해제
            </button>
          )}
        </div>
      )}

      {privileged && (
        <ChatModeration
          channelId={channelId}
          role={role}
          state={room}
          selected={selected}
          onClose={() => setSelected(null)}
          onBlockedTermsSaved={(terms) => setRoom((r) => ({ ...r, blockedTerms: terms }))}
        />
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          role="log"
          aria-label="채팅 메시지"
          onScroll={onListScroll}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
        >
          {messages.map((m) => {
            const mentionsMe = !!myName && m.userId !== userId && m.text.includes(`@${myName}`);
            return (
              <motion.div
                key={m.id}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={`group relative rounded text-sm ${mentionsMe ? "-mx-2 bg-accent/15 px-2 py-1" : ""}`}
              >
                {m.replyToId && (
                  <p className="mb-0.5 truncate text-xs text-zinc-400">
                    ↳ <span className="font-medium">@{m.replyToName}</span> {m.replyToText}
                  </p>
                )}
                <p className="pr-7 leading-snug [overflow-wrap:anywhere]">
                  <Badges badges={m.badges} />
                  {privileged ? (
                    <button
                      type="button"
                      aria-label={
                        m.userId === userId ? "내 메시지 관리" : `${m.displayName} 채팅 관리`
                      }
                      onClick={() => setSelected(m)}
                      className="rounded font-semibold text-accent underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {m.displayName}
                    </button>
                  ) : (
                    <span className="font-semibold text-accent">{m.displayName}</span>
                  )}{" "}
                  <span className="text-zinc-200">{m.text}</span>
                </p>
                {hasToken && connected && (
                  <button
                    type="button"
                    aria-label={`${m.displayName}님에게 답장`}
                    onClick={() => {
                      setReplyTo(m);
                      inputRef.current?.focus();
                    }}
                    className="absolute right-0 top-0 grid size-6 place-items-center rounded text-zinc-400 opacity-0 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <ArrowBendUpLeft className="size-4" />
                  </button>
                )}
              </motion.div>
            );
          })}
          {messages.length === 0 && (
            <p className="text-sm text-zinc-400">
              {hasToken ? "첫 채팅을 남겨보세요." : "채팅하려면 로그인하세요."}
            </p>
          )}
        </div>
        {unread > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-white"
          >
            새 메시지 {unread}개 ↓
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="px-3 pt-2 text-xs text-live">
          {error}
        </p>
      )}
      {replyTo && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300">
          <p className="min-w-0 flex-1 truncate">
            ↳ <span className="font-semibold">{replyTo.displayName}</span>님에게 답장:{" "}
            {replyTo.text}
          </p>
          <button
            type="button"
            aria-label="답장 취소"
            onClick={() => setReplyTo(null)}
            className="grid size-5 place-items-center rounded text-zinc-400 hover:text-zinc-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex gap-2 border-t border-zinc-800 p-3">
        <input
          ref={inputRef}
          aria-label="채팅 메시지"
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
            if (e.key === "Escape") setReplyTo(null);
          }}
          disabled={!hasToken || !connected || sending}
          placeholder={
            !hasToken
              ? "로그인 필요"
              : sending
                ? "전송 확인 중…"
                : connected
                  ? "메시지 보내기"
                  : "연결 중…"
          }
          className="h-9 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm placeholder:text-zinc-500 focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={!hasToken || !connected || sending}
          aria-label="전송"
          className="grid size-9 place-items-center rounded-md bg-accent text-white transition-colors hover:bg-accent-hover active:scale-95 disabled:opacity-50"
        >
          <PaperPlaneRight weight="fill" className="size-4" />
        </button>
      </div>
    </div>
  );
}
