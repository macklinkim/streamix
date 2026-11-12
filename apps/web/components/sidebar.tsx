"use client";

import Link from "next/link";
import type { Channel } from "@streamix/proto";
import { useFollowing, useLiveChannels } from "@/lib/hooks";
import { useAuth } from "@/lib/auth-store";

function viewers(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}천` : String(n);
}

function ChannelRow({ c }: { c: Channel }) {
  return (
    <Link
      href={`/watch/${c.slug}`}
      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-900"
    >
      <span
        className={`size-8 shrink-0 rounded-full bg-gradient-to-br from-accent to-zinc-700 ${c.isLive ? "" : "opacity-40 grayscale"}`}
      />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm font-medium ${c.isLive ? "text-zinc-100" : "text-zinc-400"}`}
        >
          {c.slug}
        </span>
        <span className="block truncate text-xs text-zinc-400">
          {c.isLive ? c.category || "라이브" : "오프라인"}
        </span>
      </span>
      {c.isLive && (
        <span className="flex items-center gap-1 font-mono text-xs text-zinc-400">
          <span className="size-1.5 rounded-full bg-live" />
          {viewers(c.viewerCount)}
        </span>
      )}
    </Link>
  );
}

export function Sidebar() {
  const { data: channels } = useLiveChannels();
  const user = useAuth((s) => s.user);
  const { data: following } = useFollowing();

  return (
    <aside className="hidden w-60 shrink-0 border-r border-zinc-800/80 lg:block">
      <div className="sticky top-16 space-y-5 px-3 py-4">
        {user && (
          <section>
            <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              팔로우 중
            </h2>
            <nav aria-label="팔로우 중인 채널" className="flex flex-col gap-0.5">
              {following?.map((c) => (
                <ChannelRow key={c.id} c={c} />
              ))}
              {following?.length === 0 && (
                <p className="px-2 text-sm text-zinc-400">채널 페이지에서 팔로우해 보세요.</p>
              )}
            </nav>
          </section>
        )}
        <section>
          <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            라이브 채널
          </h2>
          <nav aria-label="라이브 채널" className="flex flex-col gap-0.5">
            {channels?.map((c) => (
              <ChannelRow key={c.id} c={c} />
            ))}
            {channels?.length === 0 && (
              <p className="px-2 text-sm text-zinc-400">라이브 방송이 없습니다.</p>
            )}
          </nav>
        </section>
      </div>
    </aside>
  );
}
