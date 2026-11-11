// "1시간 5분" / "12분" from seconds.
export function durationLabel(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
}
