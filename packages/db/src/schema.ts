import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  primaryKey,
} from "drizzle-orm/pg-core";

// Relational schema (§6.1). svc-core is the logical owner of this data.

export const streamStatus = pgEnum("stream_status", ["idle", "live", "ended"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Null for OAuth-only accounts (e.g. Twitch); password login is unavailable
  // for them until they set one.
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  // External identity, e.g. "twitch:12345". Unique so repeat OAuth logins map
  // to the same account.
  providerId: text("provider_id").unique(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  isAdmin: boolean("is_admin").notNull().default(false),
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
  // Chat messages sent during this broadcast, persisted at stop (benchmark G-13).
  chatMessages: integer("chat_messages").notNull().default(0),
  // Set by svc-media once the broadcast recording is playable (benchmark G-15).
  vodReadyAt: timestamp("vod_ready_at", { withTimezone: true }),
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

// Chat moderators appointed by the channel owner (benchmark G-09).
export const channelModerators = pgTable(
  "channel_moderators",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);
