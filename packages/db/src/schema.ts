import { pgTable, pgEnum, uuid, text, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";

// Relational schema (§6.1). svc-core is the logical owner of this data.

export const streamStatus = pgEnum("stream_status", ["idle", "live", "ended"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  category: text("category"),
  streamKeyHash: text("stream_key_hash").notNull(),
  // Owner-facing key identification (§ studio key management): a short prefix
  // of the plaintext key + when it was issued. Never enough to reconstruct it.
  streamKeyPrefix: text("stream_key_prefix"),
  streamKeyIssuedAt: timestamp("stream_key_issued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const streams = pgTable("streams", {
  id: uuid("id").primaryKey().defaultRandom(),
  channelId: uuid("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  peakViewers: integer("peak_viewers").notNull().default(0),
  status: streamStatus("status").notNull().default("idle"),
});

export const follows = pgTable(
  "follows",
  {
    followerUserId: uuid("follower_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.followerUserId, t.channelId] })],
);
