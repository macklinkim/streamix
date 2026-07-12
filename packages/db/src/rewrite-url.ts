// Rewrite a Postgres connection string to point at a local proxy host:port,
// forcing sslmode=disable, WITHOUT string surgery (inbox/review.md V9-3). Used
// by the deploy workflow's migration step; reads DATABASE_URL from stdin so the
// value never lands in argv/process listings, and prints only the rewritten URL.
//
// Usage: printf '%s' "$RAW_URL" | tsx src/rewrite-url.ts 15432
import { URL } from "node:url";

const port = process.argv[2];
if (!port || !/^\d+$/.test(port)) {
  console.error("usage: rewrite-url <local-port>  (raw URL on stdin)");
  process.exit(1);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const u = new URL(raw.trim());
  u.hostname = "localhost";
  u.port = port;
  u.searchParams.set("sslmode", "disable"); // set (not append) — no duplicate '?'
  process.stdout.write(u.toString());
});
