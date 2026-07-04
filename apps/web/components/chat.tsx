"use client";

import { useEffect, useRef, useState } from "react";
import { PaperPlaneRight } from "@phosphor-icons/react";
import { wsUrl } from "@/lib/connect";
import { getToken } from "@/lib/auth";

type ChatMessage = { id: string; displayName: string; text: string };

export function Chat({ channelId }: { channelId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return; // chat requires auth (login first)

    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(`${wsUrl}/ws?channelId=${channelId}&token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000); // auto-reconnect (룸 재조인)
      };
      ws.onmessage = (evt) => {
        const m = JSON.parse(evt.data);
        if (m.type === "error") return;
        if (m.text) setMessages((prev) => [...prev.slice(-199), m]);
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [channelId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (!text || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "send", text }));
    setDraft("");
  };

  const hasToken = typeof window !== "undefined" && Boolean(getToken());

  return (
    <div className="flex h-full flex-col rounded-lg border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold">채팅</h2>
        <span className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-600"}`} />
      </div>

      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.map((m) => (
          <p key={m.id} className="text-sm leading-snug">
            <span className="font-semibold text-accent">{m.displayName}</span>{" "}
            <span className="text-zinc-200">{m.text}</span>
          </p>
        ))}
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            {hasToken ? "첫 채팅을 남겨보세요." : "채팅하려면 로그인하세요."}
          </p>
        )}
      </div>

      <div className="flex gap-2 border-t border-zinc-800 p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={!hasToken}
          placeholder={hasToken ? "메시지 보내기" : "로그인 필요"}
          className="h-9 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm placeholder:text-zinc-500 focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={!hasToken}
          aria-label="전송"
          className="grid size-9 place-items-center rounded-md bg-accent text-white transition-colors hover:bg-accent-hover active:scale-95 disabled:opacity-50"
        >
          <PaperPlaneRight weight="fill" className="size-4" />
        </button>
      </div>
    </div>
  );
}
