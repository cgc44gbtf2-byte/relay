import {
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable(
  "irc_users",
  {
    clerkId: text("clerk_id").primaryKey(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    status: text("status").notNull().default("offline"),
    role: text("role").notNull().default("member"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("irc_users_username_idx").on(table.username),
    uniqueIndex("irc_users_single_admin_idx")
      .on(table.role)
      .where(sql`${table.role} = 'admin'`),
  ],
);

export const channelsTable = pgTable(
  "irc_channels",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    topic: text("topic").notNull().default(""),
    ownerId: text("owner_id").notNull().references(() => usersTable.clerkId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("irc_channels_name_idx").on(table.name)],
);

export const channelMembersTable = pgTable(
  "irc_channel_members",
  {
    channelId: integer("channel_id").notNull().references(() => channelsTable.id),
    userId: text("user_id").notNull().references(() => usersTable.clerkId),
    role: text("role").notNull().default("member"),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

export const channelBansTable = pgTable(
  "irc_channel_bans",
  {
    channelId: integer("channel_id").notNull().references(() => channelsTable.id),
    userId: text("user_id").notNull().references(() => usersTable.clerkId),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

export const messagesTable = pgTable("irc_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelId: integer("channel_id").references(() => channelsTable.id),
  senderId: text("sender_id").notNull().references(() => usersTable.clerkId),
  recipientId: text("recipient_id").references(() => usersTable.clerkId),
  threadKey: text("thread_key"),
  body: text("body").notNull(),
  kind: text("kind").notNull().default("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const blocksTable = pgTable(
  "irc_blocks",
  {
    blockerId: text("blocker_id").notNull().references(() => usersTable.clerkId),
    blockedId: text("blocked_id").notNull().references(() => usersTable.clerkId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.blockerId, table.blockedId] })],
);

export const notificationsTable = pgTable("irc_notifications", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.clerkId),
  type: text("type").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable);
export const insertChannelSchema = createInsertSchema(channelsTable);
export const insertMessageSchema = createInsertSchema(messagesTable);
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type Channel = typeof channelsTable.$inferSelect;
export type ChannelMember = typeof channelMembersTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;