"use client";

import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart } from "@phosphor-icons/react";
import type { Channel } from "@streamix/proto";
import { channelClient } from "@/lib/connect";
import { useAuth } from "@/lib/auth-store";
import { useFollowing } from "@/lib/hooks";

export function FollowButton({ channel }: { channel: Channel }) {
  const { token, user, ready } = useAuth();
  const following = useFollowing();
  const queryClient = useQueryClient();
  const isFollowing = following.data?.some((c) => c.id === channel.id) ?? false;

  const toggle = useMutation({
    mutationFn: async () => {
      const opts = { headers: { authorization: `Bearer ${token}` } };
      if (isFollowing) await channelClient.unfollowChannel({ channelId: channel.id }, opts);
      else await channelClient.followChannel({ channelId: channel.id }, opts);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["following"] }),
  });

  if (!ready || user?.id === channel.ownerUserId) return null;

  if (!user)
    return (
      <Link
        href="/login"
        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
      >
        <Heart weight="bold" className="size-4" />
        팔로우
      </Link>
    );

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        aria-pressed={isFollowing}
        disabled={toggle.isPending || following.isLoading}
        onClick={() => toggle.mutate()}
        className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${
          isFollowing
            ? "border border-zinc-700 text-zinc-200 hover:border-zinc-500"
            : "bg-accent text-white hover:bg-accent-hover"
        }`}
      >
        <Heart weight={isFollowing ? "fill" : "bold"} className="size-4" />
        {isFollowing ? "팔로잉" : "팔로우"}
      </button>
      {toggle.isError && (
        <p role="alert" className="text-xs text-live">
          팔로우를 변경하지 못했습니다. 다시 시도하세요.
        </p>
      )}
    </div>
  );
}
