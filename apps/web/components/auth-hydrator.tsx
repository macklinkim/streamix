"use client";

import { useEffect } from "react";
import { useAuth } from "@/lib/auth-store";
import { authClient } from "@/lib/connect";
import { apiRefresh } from "@/lib/session";

// Restores the session on load: the access token is memory-only, so we silently
// mint a fresh one from the HttpOnly refresh cookie, then fetch the user. No
// valid cookie => logged out.
export function AuthHydrator() {
  const setSession = useAuth((s) => s.setSession);
  const clear = useAuth((s) => s.clear);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await apiRefresh();
      if (cancelled) return;
      if (!token) {
        clear();
        return;
      }
      try {
        const res = await authClient.me({}, { headers: { authorization: `Bearer ${token}` } });
        const u = res.user;
        if (!cancelled) {
          setSession(token, u ? { id: u.id, email: u.email, displayName: u.displayName } : null);
        }
      } catch {
        if (!cancelled) clear();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSession, clear]);

  return null;
}
