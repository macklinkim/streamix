"use client";

import Link from "next/link";
import { useLiveChannels } from "@/lib/hooks";

function viewers(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}천` : String(n);
}

export function Sidebar() {
  const { data: channels } = useLiveChannels();

  return (
    <aside className="hidden w-60 shrink-0 border-r border-zinc-800/80 lg:block">
      <div className="sticky top-16 px-3 py-4">
        <h2 className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          라이브 채널
        </h2>
        <nav className="flex flex-col gap-0.5">
          {channels?.map((c) => (
            <Link
              key={c.id}
              href={`/watch/${c.slug}`}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-900"
            >
              <span className="size-8 shrink-0 rounded-full bg-gradient-to-br from-accent to-zinc-700" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-100">{c.slug}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {c.category || "라이브"}
                </span>
              </span>
              <span className="flex items-center gap-1 font-mono text-xs text-zinc-400">
                <span className="size-1.5 rounded-full bg-live" />
                {viewers(c.viewerCount)}
              </span>
            </Link>
          ))}
          {channels?.length === 0 && (
            <p className="px-2 text-sm text-zinc-400">라이브 방송이 없습니다.</p>
          )}
        </nav>
      </div>
    </aside>
  );
}
