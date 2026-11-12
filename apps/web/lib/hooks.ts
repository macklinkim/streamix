"use client";

import { useQuery } from "@tanstack/react-query";
import { channelClient } from "./connect";
import { useAuth } from "./auth-store";

// Live channel list (F3). Polls so the grid/sidebar reflect new streams.
// Empty category = all categories.
export function useLiveChannels(category = "") {
  return useQuery({
    queryKey: ["live-channels", category],
    queryFn: async () => (await channelClient.listLive({ category })).channels,
    refetchInterval: 15_000,
  });
}

// Channels the signed-in user follows, live first (benchmark G-02). Keyed by
// user so a logout/login never shows the previous user's list.
export function useFollowing() {
  const token = useAuth((s) => s.token);
  const userId = useAuth((s) => s.user?.id);
  return useQuery({
    queryKey: ["following", userId],
    queryFn: async () =>
      (await channelClient.listFollowing({}, { headers: { authorization: `Bearer ${token}` } }))
        .channels,
    enabled: !!token && !!userId,
    refetchInterval: 30_000,
  });
}
