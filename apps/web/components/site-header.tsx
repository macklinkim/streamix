import Link from "next/link";
import { MagnifyingGlass, VideoCamera } from "@phosphor-icons/react/dist/ssr";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 h-16 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1400px] items-center gap-4 px-4 md:px-6">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <VideoCamera weight="fill" className="size-6 text-accent" />
          Streamix
        </Link>

        <div className="relative ml-4 hidden max-w-md flex-1 md:block">
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="search"
            placeholder="채널, 카테고리 검색"
            aria-label="검색"
            className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
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
      </div>
    </header>
  );
}
