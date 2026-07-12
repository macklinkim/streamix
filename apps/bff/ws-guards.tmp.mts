// Temporary V4 guard smoke. Delete after run.
import WebSocket from "ws";

let failures = 0;
function ok(label: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// 1. Hostile origin now rejected BEFORE upgrade -> handshake fails (HTTP 403),
//    no close code, ws emits an "Unexpected server response" error.
const preUpgrade = await new Promise<string>((resolve) => {
  const ws = new WebSocket("ws://localhost:8080/ws?channelId=x&token=y", {
    headers: { origin: "https://evil.example" },
  });
  ws.on("error", (e) => resolve(`error:${(e as Error).message}`));
  ws.on("open", () => {
    ws.terminate();
    resolve("open");
  });
  setTimeout(() => resolve("timeout"), 5000).unref();
});
ok("hostile origin rejected pre-upgrade (HTTP 403)", /403/.test(preUpgrade), preUpgrade);

// 2. Login to get a real token for room-guard tests.
const login = await fetch("http://localhost:8080/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json", "x-sx-web": "1" },
  body: JSON.stringify({ email: "mixed@ex.com", password: "longenough1234" }),
});
const { accessToken } = (await login.json()) as { accessToken: string };
ok("login for token", login.status === 200 && Boolean(accessToken), `status=${login.status}`);

// 3. Room-creation rate: 5 new rooms/min allowed, 6th+ closed 4429.
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
const codes: number[] = [];
for (let i = 0; i < 7; i++) {
  const code = await new Promise<number>((resolve) => {
    const ws = new WebSocket(
      `ws://localhost:8080/ws?channelId=${uuid()}&token=${accessToken}`,
    );
    ws.on("close", (c) => resolve(c));
    ws.on("open", () => setTimeout(() => ws.close(1000), 300));
    ws.on("error", () => {});
    setTimeout(() => {
      ws.terminate();
      resolve(-1);
    }, 5000).unref();
  });
  codes.push(code);
}
const rateLimited = codes.filter((c) => c === 4429).length;
ok(
  "room-creation rate limits after 5 new rooms",
  rateLimited >= 2,
  `codes=${codes.join(",")}`,
);

console.log(failures ? `\nGUARDS FAILED (${failures})` : "\nGUARDS OK");
process.exit(failures ? 1 : 0);
