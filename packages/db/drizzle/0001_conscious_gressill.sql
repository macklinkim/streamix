ALTER TABLE "channels" ADD COLUMN "stream_key_prefix" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "stream_key_issued_at" timestamp with time zone;