"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { VideoCamera, Broadcast, MagnifyingGlass } from "@phosphor-icons/react";
import { useAuth } from "@/lib/auth-store";
import { apiLogout } from "@/lib/session";

function AuthNav() {
  const { user, ready, token, clear } = useAuth();
  const logout = async () => {
    await apiLogout(token); // revoke the server session + refresh cookie
    clear();
  };
  if (!ready) return <div className="h-9 w-32" />; // reserve space, avoid flash

  if (user) {
    return (
      <div className="flex items-center gap-2">
        {user.isAdmin && (
          <Link
            href="/admin"
            aria-label="가입 승인"
            className="rounded-md px-2 py-2 text-sm font-medium text-zinc-300 hover:text-white sm:px-3"
          >
            <span className="sm:hidden">승인</span>
            <span className="hidden sm:inline">가입 승인</span>
          </Link>
        )}
        <Link
          href="/studio"
          className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-100"
        >
          <Broadcast weight="fill" className="size-4 text-live" />
          스튜디오
        </Link>
        <span className="hidden text-sm text-zinc-300 sm:inline">{user.displayName}</span>
        <button
          onClick={logout}
          className="rounded-md border border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-100"
        >
          로그아웃
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/login"
        className="rounded-md px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-100"
      >
        로그인
      </Link>
      <Link
        href="/signup"
        className="rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover active:scale-[0.98]"
      >
        회원가입
      </Link>
    </div>
  );
}

function SearchBox() {
  const router = useRouter();
  return (
    <>
      <form
        role="search"
        className="hidden max-w-sm flex-1 md:block"
        onSubmit={(e) => {
          e.preventDefault();
          const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
          if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
        }}
      >
        <label className="relative block">
          <span className="sr-only">채널 검색</span>
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="search"
            name="q"
            maxLength={50}
            placeholder="채널·카테고리 검색"
            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-9 pr-3 text-sm placeholder:text-zinc-400 focus:border-accent focus:outline-none"
          />
        </label>
      </form>
      <Link
        href="/search"
        aria-label="채널 검색"
        className="grid size-9 place-items-center rounded-md text-zinc-300 hover:text-white md:hidden"
      >
        <MagnifyingGlass className="size-5" />
      </Link>
    </>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 h-16 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-4 px-4 md:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <VideoCamera weight="fill" className="size-6 text-accent" />
          Streamix
        </Link>

        <SearchBox />

        <div className="ml-auto">
          <AuthNav />
        </div>
      </div>
    </header>
  );
}
