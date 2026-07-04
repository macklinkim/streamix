// Minimal token storage (localStorage). Phase 4 replaces with a proper store +
// refresh flow; for now this unblocks authed WS chat from the watch page.
const KEY = "streamix_access_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(KEY);
}
