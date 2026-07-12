-- Email canonicalization (inbox/review.md V6-3). The app now stores and looks
-- up trim+lowercase emails; existing rows must match and the DB must enforce
-- canonical uniqueness so a new lowercase registration cannot squat an
-- existing mixed-case account.
--
-- Refuse to run if two existing rows collapse to the same canonical email:
-- merging accounts is a manual decision, never automatic.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users GROUP BY lower(trim(email)) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'users.email canonicalization collision: resolve duplicate lower(trim(email)) rows manually before migrating';
  END IF;
END $$;--> statement-breakpoint
UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_canonical_unique" ON "users" (lower(trim(email)));