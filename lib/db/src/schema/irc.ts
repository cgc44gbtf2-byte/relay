import {
  boolean,
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
    accountStatus: text("account_status").notNull().default("active"),
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

export const communitiesTable = pgTable(
  "irc_communities",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    rules: text("rules").notNull().default(""),
    businessType: text("business_type").notNull().default("service_business"),
    services: text("services").notNull().default(""),
    serviceArea: text("service_area").notNull().default(""),
    businessHours: text("business_hours").notNull().default(""),
    contactEmail: text("contact_email").notNull().default(""),
    contactPhone: text("contact_phone").notNull().default(""),
    onboardingStep: integer("onboarding_step").notNull().default(1),
    status: text("status").notNull().default("active"),
    isPrivate: boolean("is_private").notNull().default(false),
    ownerId: text("owner_id").notNull().references(() => usersTable.clerkId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("irc_communities_slug_idx").on(table.slug)],
);

export const permissionDefinitionsTable = pgTable(
  "irc_permission_definitions",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    description: text("description").notNull().default(""),
  },
  (table) => [uniqueIndex("irc_permission_definitions_key_idx").on(table.key)],
);

export const customRolesTable = pgTable(
  "irc_custom_roles",
  {
    key: text("key").primaryKey(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    scopeType: text("scope_type").notNull().default("community"),
    createdBy: text("created_by").notNull().references(() => usersTable.clerkId),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const rolePermissionsTable = pgTable(
  "irc_role_permissions",
  {
    role: text("role").notNull(),
    permissionId: integer("permission_id").notNull().references(() => permissionDefinitionsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.role, table.permissionId] })],
);

export const userRolesTable = pgTable(
  "irc_user_roles",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
    role: text("role").notNull(),
    scopeType: text("scope_type").notNull().default("platform"),
    communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "cascade" }),
    categoryId: integer("category_id"),
    channelId: integer("channel_id").references(() => channelsTable.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").notNull().references(() => usersTable.clerkId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("irc_user_roles_scope_idx").on(table.userId, table.role, table.scopeType, table.communityId, table.categoryId, table.channelId),
  ],
);

export const communityMembersTable = pgTable(
  "irc_community_members",
  {
    communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
    status: text("status").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.communityId, table.userId] })],
);

export const channelsTable = pgTable(
  "irc_channels",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    topic: text("topic").notNull().default(""),
    description: text("description").notNull().default(""),
    ownerId: text("owner_id").notNull().references(() => usersTable.clerkId),
    communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "set null" }),
    categoryId: integer("category_id"),
    isPrivate: boolean("is_private").notNull().default(false),
    isInviteOnly: boolean("is_invite_only").notNull().default(false),
    passwordHash: text("password_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("irc_channels_community_name_idx").on(table.communityId, table.name)],
);

export const categoriesTable = pgTable(
  "irc_categories",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    ownerId: text("owner_id").notNull().references(() => usersTable.clerkId),
    communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("irc_categories_owner_name_idx").on(table.ownerId, table.name)],
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

export const channelJoinRequestsTable = pgTable(
  "irc_channel_join_requests",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id").notNull().references(() => channelsTable.id),
    userId: text("user_id").notNull().references(() => usersTable.clerkId),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by").references(() => usersTable.clerkId),
  },
  (table) => [uniqueIndex("irc_channel_join_requests_channel_user_idx").on(table.channelId, table.userId)],
);

export const channelInvitesTable = pgTable(
  "irc_channel_invites",
  {
    channelId: integer("channel_id").notNull().references(() => channelsTable.id),
    userId: text("user_id").notNull().references(() => usersTable.clerkId),
    invitedBy: text("invited_by").notNull().references(() => usersTable.clerkId),
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
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by").references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messageAttachmentsTable = pgTable("irc_message_attachments", {
  id: serial("id").primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id").notNull().references(() => usersTable.clerkId),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messageReactionsTable = pgTable(
  "irc_message_reactions",
  {
    messageId: uuid("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => usersTable.clerkId),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.userId, table.emoji] })],
);

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

export const serverAnnouncementsTable = pgTable("irc_server_announcements", {
  id: serial("id").primaryKey(),
  authorId: text("author_id").notNull().references(() => usersTable.clerkId),
  communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const moderationActionsTable = pgTable("irc_moderation_actions", {
  id: serial("id").primaryKey(),
  actorId: text("actor_id").notNull().references(() => usersTable.clerkId),
  targetUserId: text("target_user_id").references(() => usersTable.clerkId),
  communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "cascade" }),
  channelId: integer("channel_id").references(() => channelsTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminAuditLogsTable = pgTable("irc_admin_audit_logs", {
  id: serial("id").primaryKey(),
  actorId: text("actor_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  actorDisplayName: text("actor_display_name"),
  action: text("action").notNull(),
  targetId: text("target_id"),
  targetLabel: text("target_label"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const developerSettingsTable = pgTable("irc_developer_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedBy: text("updated_by").notNull().references(() => usersTable.clerkId),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const developerReleasesTable = pgTable("irc_developer_releases", {
  id: serial("id").primaryKey(),
  version: text("version").notNull(),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by").notNull().references(() => usersTable.clerkId),
  reviewedBy: text("reviewed_by").references(() => usersTable.clerkId),
  publishedBy: text("published_by").references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const insertUserSchema = createInsertSchema(usersTable);
export const insertChannelSchema = createInsertSchema(channelsTable);
export const insertMessageSchema = createInsertSchema(messagesTable);
export const insertCategorySchema = createInsertSchema(categoriesTable);
export const insertAdminAuditLogSchema = createInsertSchema(adminAuditLogsTable);
export const insertCommunitySchema = createInsertSchema(communitiesTable);
export const insertDeveloperReleaseSchema = createInsertSchema(developerReleasesTable);
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type Channel = typeof channelsTable.$inferSelect;
export type Category = typeof categoriesTable.$inferSelect;
export type Community = typeof communitiesTable.$inferSelect;
export type ChannelMember = typeof channelMembersTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type AdminAuditLog = typeof adminAuditLogsTable.$inferSelect;
export type DeveloperSetting = typeof developerSettingsTable.$inferSelect;
export type DeveloperRelease = typeof developerReleasesTable.$inferSelect;
export type CustomRole = typeof customRolesTable.$inferSelect;