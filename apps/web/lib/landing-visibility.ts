const KEY = "streamix_landing_seen";

export function landingSeen(): boolean {
  return document.cookie.split("; ").includes(`${KEY}=1`);
}

export function markLandingSeen(): void {
  const expires = new Date();
  expires.setHours(24, 0, 0, 0);
  document.cookie = `${KEY}=1; Expires=${expires.toUTCString()}; Path=/; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
}
