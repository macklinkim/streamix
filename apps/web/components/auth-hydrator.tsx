"use client";

import { useEffect } from "react";
import { useAuth, storedToken } from "@/lib/auth-store";
import { authClient } from "@/lib/connect";

// Restores the session on load: if a token is stored, fetch the user via `me`,
// otherwise mark auth ready as logged-out. Logs out on an invalid token.
export function AuthHydrator() {
  const hydrate = useAuth((s) => s.hydrate);
  const logout = useAuth((s) => s.logout);

  useEffect(() => {
    const token = storedToken();
    if (!token) {
      hydrate(null, null);
      return;
    }
    authClient
      .me({}, { headers: { authorization: `Bearer ${token}` } })
      .then((res) => hydrate(token, res.user ?? null))
      .catch(() => logout());
  }, [hydrate, logout]);

  return null;
}
