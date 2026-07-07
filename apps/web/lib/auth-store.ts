import { create } from "zustand";

// The access token lives ONLY in memory (never localStorage) — a stolen-via-XSS
// token dies with the tab, and the long-lived refresh credential is an HttpOnly
// cookie the JS cannot read at all. On reload the session is restored by a
// silent /auth/refresh (see auth-hydrator).
export type SessionUser = { id: string; email: string; displayName: string };

type AuthState = {
  token: string | null; // in-memory access token
  user: SessionUser | null;
  ready: boolean; // true once we've tried to restore the session
  setSession: (token: string, user: SessionUser | null) => void;
  setToken: (token: string) => void; // silent-refresh replaces the access token
  clear: () => void;
};

export const useAuth = create<AuthState>((set) => ({
  token: null,
  user: null,
  ready: false,
  setSession: (token, user) => set({ token, user, ready: true }),
  setToken: (token) => set({ token }),
  clear: () => set({ token: null, user: null, ready: true }),
}));
