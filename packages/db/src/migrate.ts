import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL ?? "postgres://streamix:streamix@localhost:5432/streamix";
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const client = postgres(url, { max: 1 });
await migrate(drizzle(client), { migrationsFolder });
await client.end();
// eslint-disable-next-line no-console
console.log("migrations applied");
