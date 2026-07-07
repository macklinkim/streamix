// "오늘은 보지 않기" — hide the landing until the next local midnight (24:00).
const KEY = "streamix_landing_hidden_until";

/** ms timestamp of the next local 00:00 after `from`. */
export function nextMidnight(from: Date = new Date()): number {
  const d = new Date(from);
  d.setHours(24, 0, 0, 0); // rolls to tomorrow 00:00 local
  return d.getTime();
}

/** True if the landing is currently suppressed for the day. */
export function landingHidden(now: number = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return false;
  const until = Number(raw);
  if (!Number.isFinite(until) || now >= until) {
    window.localStorage.removeItem(KEY); // expired — clean up
    return false;
  }
  return true;
}

/** Suppress the landing until the next midnight. */
export function hideLandingForToday(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, String(nextMidnight()));
}
