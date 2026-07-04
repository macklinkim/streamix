import Image from "next/image";
import Link from "next/link";

export type Channel = {
  slug: string;
  title: string;
  streamer: string;
  category: string;
  viewers: number;
  thumbSeed: string;
};

function formatViewers(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}천`;
  return String(n);
}

export function ChannelCard({ channel }: { channel: Channel }) {
  return (
    <Link href={`/watch/${channel.slug}`} className="group block">
      <div className="relative aspect-video overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <Image
          src={`https://picsum.photos/seed/${channel.thumbSeed}/640/360`}
          alt={channel.title}
          fill
          sizes="(max-width: 768px) 100vw, 320px"
          className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-live px-1.5 py-0.5 text-[11px] font-bold uppercase text-white">
          <span className="live-dot size-1.5 rounded-full bg-white" />
          Live
        </span>
        <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-zinc-100">
          시청자 {formatViewers(channel.viewers)}
        </span>
      </div>

      <div className="mt-2.5 flex gap-2.5">
        <span className="mt-0.5 size-8 shrink-0 rounded-full bg-gradient-to-br from-accent to-zinc-700" />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-zinc-100 group-hover:text-accent">
            {channel.title}
          </h3>
          <p className="truncate text-sm text-zinc-400">{channel.streamer}</p>
          <p className="truncate text-xs text-zinc-500">{channel.category}</p>
        </div>
      </div>
    </Link>
  );
}
