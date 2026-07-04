import postgres from "postgres";

// Reversibility check (migration "down"): reset the public schema so migrations
// can be re-applied from scratch. Local/dev only.
const url = process.env.DATABASE_URL ?? "postgres://streamix:streamix@localhost:5432/streamix";
const sql = postgres(url, { max: 1 });
await sql.unsafe(
  // Also drop `drizzle` schema (holds __drizzle_migrations) so migrations re-apply.
  "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
);
await sql.end();
// eslint-disable-next-line no-console
console.log("schema reset (all tables dropped)");
