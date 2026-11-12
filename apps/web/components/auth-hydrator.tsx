"use client";

import { useEffect } from "react";
import { hadSession, useAuth } from "@/lib/auth-store";
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
    // Never signed in here: show the signed-out header now; a valid refresh
    // cookie below still upgrades it to the real session.
    if (!hadSession()) useAuth.setState({ ready: true });
    (async () => {
      const token = await apiRefresh().catch(() => null);
      if (cancelled) return;
      if (!token) {
        clear();
        return;
      }
      try {
        const res = await authClient.me({}, { headers: { authorization: `Bearer ${token}` } });
        const u = res.user;
        if (!cancelled) {
          setSession(
            token,
            u ? { id: u.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin } : null,
          );
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
