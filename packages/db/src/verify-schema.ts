// Post-migration proof against the PRODUCTION DB (inbox/review.md V9-4): reads
// the last applied migration from Drizzle's migration table and confirms the
// canonical-email unique index actually exists. Prints schema facts only — never
// the connection string. Exits non-zero if the expected index is missing.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const [last] = await sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations
    ORDER BY created_at DESC LIMIT 1
  `;
  const [idx] = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'users' AND indexname = 'users_email_canonical_unique'
  `;
  console.log(`last migration hash=${last?.hash ?? "none"} appliedAt=${last?.created_at ?? "?"}`);
  console.log(`canonical email index present: ${Boolean(idx)}`);
  if (!idx) {
    console.error("FATAL: users_email_canonical_unique index not found in production DB");
    process.exit(1);
  }
} finally {
  await sql.end();
}
