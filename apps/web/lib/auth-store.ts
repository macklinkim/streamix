import { create } from "zustand";
import type { User } from "@streamix/proto";

const KEY = "streamix_access_token";

type AuthState = {
  token: string | null;
  user: User | null;
  ready: boolean; // true once we've tried to restore the session
  setAuth: (token: string, user: User | null) => void;
  hydrate: (token: string | null, user: User | null) => void;
  logout: () => void;
};

export const useAuth = create<AuthState>((set) => ({
  token: null,
  user: null,
  ready: false,
  setAuth: (token, user) => {
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, token);
    set({ token, user, ready: true });
  },
  hydrate: (token, user) => set({ token, user, ready: true }),
  logout: () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(KEY);
    set({ token: null, user: null, ready: true });
  },
}));

export const storedToken = (): string | null =>
  typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
