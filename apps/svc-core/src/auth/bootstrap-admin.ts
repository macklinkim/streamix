import { createDb, users } from "@streamix/db";
import { emailSchema, passwordSchema } from "@streamix/schemas";
import { eq } from "drizzle-orm";
import { hashPassword } from "./password.js";

const email = emailSchema.parse(process.env.ADMIN_EMAIL);
const password = passwordSchema.parse(process.env.ADMIN_PASSWORD);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

const db = createDb(url);
try {
  const [existingAdmin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .limit(1);
  if (existingAdmin) throw new Error("an admin account already exists");
  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(users)
    .values({ email, passwordHash, displayName: "관리자", approvedAt: new Date(), isAdmin: true })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  if (!created) throw new Error("admin email already exists; no account was changed");
  console.log("admin account ready");
} finally {
  await db.$client.end();
}
