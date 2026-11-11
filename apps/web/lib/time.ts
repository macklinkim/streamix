const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });

// "3분 전" / "2시간 전" / "3일 전" from unix seconds.
export function relativeLabel(unixSeconds: bigint): string {
  const minutes = Math.round((Number(unixSeconds) * 1000 - Date.now()) / 60_000);
  if (minutes > -60) return rtf.format(minutes, "minute");
  if (minutes > -60 * 24) return rtf.format(Math.round(minutes / 60), "hour");
  return rtf.format(Math.round(minutes / (60 * 24)), "day");
}
