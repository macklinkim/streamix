"use client";

import { useQuery } from "@tanstack/react-query";
import { channelClient } from "./connect";

// Live channel list (F3). Polls so the grid/sidebar reflect new streams.
export function useLiveChannels() {
  return useQuery({
    queryKey: ["live-channels"],
    queryFn: async () => (await channelClient.listLive({})).channels,
    refetchInterval: 15_000,
  });
}
