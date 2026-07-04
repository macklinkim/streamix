import { ChannelCard, type Channel } from "@/components/channel-card";

// Mock live channels (Phase 4 replaces with ListLive over Connect-Web).
const LIVE_CHANNELS: Channel[] = [
  {
    slug: "noa-devlog",
    title: "Rust로 게임 엔진 밑바닥부터 만들기 #14",
    streamer: "노아_devlog",
    category: "소프트웨어 개발",
    viewers: 1284,
    thumbSeed: "streamix-rust-engine",
  },
  {
    slug: "hana-cook",
    title: "새벽 야식 라이브 · 김치볶음밥의 정석",
    streamer: "하나키친",
    category: "먹방 & 요리",
    viewers: 8420,
    thumbSeed: "streamix-latenight-kitchen",
  },
  {
    slug: "ori-fps",
    title: "발로란트 레디언트 찍고 잠",
    streamer: "오리사냥꾼",
    category: "발로란트",
    viewers: 23100,
    thumbSeed: "streamix-valorant-night",
  },
  {
    slug: "seo-lofi",
    title: "비 오는 날 로파이 · 코딩하며 듣기 좋은",
    streamer: "서울로파이",
    category: "음악 & DJ",
    viewers: 642,
    thumbSeed: "streamix-lofi-rain",
  },
  {
    slug: "min-art",
    title: "프로크리에이트 커미션 작업 · 캐릭터 채색",
    streamer: "민초아트",
    category: "아트",
    viewers: 1930,
    thumbSeed: "streamix-digital-art",
  },
  {
    slug: "tae-talk",
    title: "퇴근하고 수다 · 오늘 있었던 일",
    streamer: "태태의라디오",
    category: "저스트 채팅",
    viewers: 3070,
    thumbSeed: "streamix-just-chatting",
  },
];

export default function HomePage() {
  return (
    <div>
      <div className="mb-6 flex items-baseline gap-3">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">지금 라이브</h1>
        <span className="font-mono text-sm text-zinc-500">{LIVE_CHANNELS.length}개 방송 중</span>
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {LIVE_CHANNELS.map((channel) => (
          <ChannelCard key={channel.slug} channel={channel} />
        ))}
      </div>
    </div>
  );
}
