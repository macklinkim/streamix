import { create } from "zustand";

// The access token lives ONLY in memory (never localStorage) — a stolen-via-XSS
// token dies with the tab, and the long-lived refresh credential is an HttpOnly
// cookie the JS cannot read at all. On reload the session is restored by a
// silent /auth/refresh (see auth-hydrator).
export type SessionUser = { id: string; email: string; displayName: string; isAdmin: boolean };

type AuthState = {
  token: string | null; // in-memory access token
  user: SessionUser | null;
  ready: boolean; // true once we've tried to restore the session
  setSession: (token: string, user: SessionUser | null) => void;
  setToken: (token: string) => void; // silent-refresh replaces the access token
  clear: () => void;
};

// Non-secret "this browser was signed in" flag. Without it the header can show
// 로그인/회원가입 at once instead of waiting on the /auth/refresh round-trip
// (a cold BFF takes seconds). It only picks the first paint; the refresh still
// runs and replaces it with the real session.
const HINT_KEY = "streamix_session_hint";
function setHint(on: boolean) {
  try {
    if (on) localStorage.setItem(HINT_KEY, "1");
    else localStorage.removeItem(HINT_KEY);
  } catch {
    /* storage blocked: header just waits for the refresh as before */
  }
}
export function hadSession(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true; // unknown -> keep the old wait-for-refresh behaviour
  }
}

export const useAuth = create<AuthState>((set) => ({
  token: null,
  user: null,
  ready: false,
  setSession: (token, user) => {
    setHint(!!user);
    set({ token, user, ready: true });
  },
  setToken: (token) => set({ token }),
  clear: () => {
    setHint(false);
    set({ token: null, user: null, ready: true });
  },
}));
