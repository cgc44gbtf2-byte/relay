import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
  index,
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
    plan: text("plan").notNull().default("paid_workspace"),
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
  (table) => [
    uniqueIndex("irc_communities_slug_idx").on(table.slug),
    uniqueIndex("irc_communities_free_owner_idx")
      .on(table.ownerId)
      .where(sql`${table.plan} = 'free_community'`),
  ],
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
    index("irc_user_roles_community_role_idx").on(table.communityId, table.role, table.userId),
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
  (table) => [
    primaryKey({ columns: [table.communityId, table.userId] }),
    index("irc_community_members_user_idx").on(table.userId),
  ],
);

export const departmentsTable = pgTable("irc_departments", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  managerId: text("manager_id").references(() => usersTable.clerkId),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_departments_community_idx").on(table.communityId),
  index("irc_departments_community_name_idx").on(table.communityId, table.name),
]);

export const locationsTable = pgTable("irc_locations", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code").notNull().default(""),
  address: text("address").notNull().default(""),
  timezone: text("timezone").notNull().default("America/Chicago"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_locations_community_idx").on(table.communityId),
  index("irc_locations_community_name_idx").on(table.communityId, table.name),
]);

export const teamsTable = pgTable("irc_teams", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  managerId: text("manager_id").references(() => usersTable.clerkId),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_teams_community_idx").on(table.communityId),
  index("irc_teams_community_name_idx").on(table.communityId, table.name),
]);

export const teamMembersTable = pgTable("irc_team_members", {
  teamId: integer("team_id").notNull().references(() => teamsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.teamId, table.userId] })]);

export const employeeProfilesTable = pgTable("irc_employee_profiles", {
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  employeeNumber: text("employee_number").notNull().default(""),
  jobTitle: text("job_title").notNull().default(""),
  employmentStatus: text("employment_status").notNull().default("active"),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  managerId: text("manager_id").references(() => usersTable.clerkId),
  invitedAt: timestamp("invited_at", { withTimezone: true }),
  onboardingStartedAt: timestamp("onboarding_started_at", { withTimezone: true }),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  offboardingAt: timestamp("offboarding_at", { withTimezone: true }),
  offboardedAt: timestamp("offboarded_at", { withTimezone: true }),
  notes: text("notes").notNull().default(""),
}, (table) => [primaryKey({ columns: [table.communityId, table.userId] })]);

export const workspaceInvitationsTable = pgTable("irc_workspace_invitations", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  invitedUserId: text("invited_user_id").references(() => usersTable.clerkId, { onDelete: "set null" }),
  role: text("role").notNull().default("member"),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  teamId: integer("team_id").references(() => teamsTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  invitedBy: text("invited_by").notNull().references(() => usersTable.clerkId),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("irc_workspace_invitations_community_created_idx").on(table.communityId, table.createdAt),
]);

export const workspacePoliciesTable = pgTable("irc_workspace_policies", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("published"),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull().references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_workspace_policies_community_created_idx").on(table.communityId, table.createdAt),
]);

export const policyAcknowledgementsTable = pgTable("irc_policy_acknowledgements", {
  policyId: integer("policy_id").notNull().references(() => workspacePoliciesTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.policyId, table.userId] })]);

export const documentFoldersTable = pgTable("irc_document_folders", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  parentId: integer("parent_id"),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull().references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_document_folders_community_idx").on(table.communityId),
]);

export const businessDocumentsTable = pgTable("irc_business_documents", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  folderId: integer("folder_id").references(() => documentFoldersTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("company"),
  visibility: text("visibility").notNull().default("company"),
  targetUserId: text("target_user_id").references(() => usersTable.clerkId, { onDelete: "set null" }),
  requiresAcknowledgement: boolean("requires_acknowledgement").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  ownerId: text("owner_id").notNull().references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_business_documents_community_updated_idx").on(table.communityId, table.updatedAt),
]);

export const documentVersionsTable = pgTable("irc_document_versions", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => businessDocumentsTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  uploadedBy: text("uploaded_by").notNull().references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_document_versions_document_version_idx").on(table.documentId, table.version),
]);

export const documentPermissionsTable = pgTable("irc_document_permissions", {
  documentId: integer("document_id").notNull().references(() => businessDocumentsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  permission: text("permission").notNull().default("viewer"),
  grantedBy: text("granted_by").notNull().references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.documentId, table.userId] })]);

export const documentAcknowledgementsTable = pgTable("irc_document_acknowledgements", {
  documentId: integer("document_id").notNull().references(() => businessDocumentsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.documentId, table.userId] })]);

export const documentDownloadsTable = pgTable("irc_document_downloads", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => businessDocumentsTable.id, { onDelete: "cascade" }),
  versionId: integer("version_id").notNull().references(() => documentVersionsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  downloadedAt: timestamp("downloaded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_document_downloads_document_idx").on(table.documentId),
]);

export const workspaceTasksTable = pgTable("irc_workspace_tasks", {
  id: serial("id").primaryKey(),
  communityId: integer("community_id").notNull().references(() => communitiesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  assignedTo: text("assigned_to").references(() => usersTable.clerkId, { onDelete: "set null" }),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  priority: text("priority").notNull().default("medium"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  status: text("status").notNull().default("todo"),
  createdBy: text("created_by").notNull().references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("irc_workspace_tasks_community_updated_idx").on(table.communityId, table.updatedAt),
  index("irc_workspace_tasks_community_status_due_idx").on(table.communityId, table.status, table.dueDate),
]);

export const workspaceTaskCommentsTable = pgTable("irc_workspace_task_comments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => workspaceTasksTable.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => usersTable.clerkId),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_workspace_task_comments_task_created_idx").on(table.taskId, table.createdAt),
]);

export const workspaceTaskAttachmentsTable = pgTable("irc_workspace_task_attachments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => workspaceTasksTable.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id").notNull().references(() => usersTable.clerkId),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_workspace_task_attachments_task_idx").on(table.taskId),
]);

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
  (table) => [
    uniqueIndex("irc_channels_community_category_name_idx").on(table.communityId, table.categoryId, table.name),
    index("irc_channels_community_name_idx").on(table.communityId, table.name),
  ],
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
  (table) => [
    uniqueIndex("irc_categories_owner_name_idx").on(table.ownerId, table.name),
    index("irc_categories_community_idx").on(table.communityId),
    index("irc_categories_community_name_idx").on(table.communityId, table.name),
  ],
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
  (table) => [
    primaryKey({ columns: [table.channelId, table.userId] }),
    index("irc_channel_members_user_idx").on(table.userId),
  ],
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
  (table) => [
    uniqueIndex("irc_channel_join_requests_channel_user_idx").on(table.channelId, table.userId),
    index("irc_channel_join_requests_user_status_idx").on(table.userId, table.status),
  ],
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
  replyToId: uuid("reply_to_id"),
  body: text("body").notNull(),
  kind: text("kind").notNull().default("message"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by").references(() => usersTable.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_messages_channel_created_idx").on(table.channelId, table.createdAt),
  index("irc_messages_recipient_created_idx").on(table.recipientId, table.createdAt),
  index("irc_messages_sender_created_idx").on(table.senderId, table.createdAt),
  index("irc_messages_thread_created_idx").on(table.threadKey, table.createdAt),
]);

export const messageAttachmentsTable = pgTable("irc_message_attachments", {
  id: serial("id").primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id").notNull().references(() => usersTable.clerkId),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_message_attachments_message_idx").on(table.messageId),
]);

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
  category: text("category").notNull().default("general"),
  body: text("body").notNull(),
  communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "cascade" }),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  actionUrl: text("action_url"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_notifications_user_created_idx").on(table.userId, table.createdAt),
]);

export const serverAnnouncementsTable = pgTable("irc_server_announcements", {
  id: serial("id").primaryKey(),
  authorId: text("author_id").notNull().references(() => usersTable.clerkId),
  communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Announcement"),
  body: text("body").notNull(),
  audienceType: text("audience_type").notNull().default("company"),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  teamId: integer("team_id").references(() => teamsTable.id, { onDelete: "set null" }),
  recipientId: text("recipient_id").references(() => usersTable.clerkId, { onDelete: "set null" }),
  requiresAcknowledgement: boolean("requires_acknowledgement").notNull().default(false),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status").notNull().default("published"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_announcements_community_created_idx").on(table.communityId, table.createdAt),
  index("irc_announcements_community_status_scheduled_idx").on(table.communityId, table.status, table.scheduledAt),
]);

export const announcementReadReceiptsTable = pgTable("irc_announcement_read_receipts", {
  announcementId: integer("announcement_id").notNull().references(() => serverAnnouncementsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.announcementId, table.userId] })]);

export const announcementAcknowledgementsTable = pgTable("irc_announcement_acknowledgements", {
  announcementId: integer("announcement_id").notNull().references(() => serverAnnouncementsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => usersTable.clerkId, { onDelete: "cascade" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.announcementId, table.userId] })]);

export const announcementAttachmentsTable = pgTable("irc_announcement_attachments", {
  id: serial("id").primaryKey(),
  announcementId: integer("announcement_id").notNull().references(() => serverAnnouncementsTable.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id").notNull().references(() => usersTable.clerkId),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_announcement_attachments_announcement_idx").on(table.announcementId),
]);

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
  communityId: integer("community_id").references(() => communitiesTable.id, { onDelete: "cascade" }),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  locationId: integer("location_id").references(() => locationsTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  targetId: text("target_id"),
  targetLabel: text("target_label"),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("irc_admin_audit_logs_community_created_idx").on(table.communityId, table.createdAt, table.id),
  index("irc_admin_audit_logs_legacy_target_created_idx").on(table.targetId, table.targetLabel, table.createdAt, table.id),
]);

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
  announcementId: integer("announcement_id").references(() => serverAnnouncementsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("irc_developer_releases_announcement_idx").on(table.announcementId),
]);

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
export type Department = typeof departmentsTable.$inferSelect;
export type Location = typeof locationsTable.$inferSelect;
export type Team = typeof teamsTable.$inferSelect;
export type EmployeeProfile = typeof employeeProfilesTable.$inferSelect;
export type WorkspaceInvitation = typeof workspaceInvitationsTable.$inferSelect;
export type WorkspacePolicy = typeof workspacePoliciesTable.$inferSelect;
export type DocumentFolder = typeof documentFoldersTable.$inferSelect;
export type BusinessDocument = typeof businessDocumentsTable.$inferSelect;
export type DocumentVersion = typeof documentVersionsTable.$inferSelect;
export type DocumentPermission = typeof documentPermissionsTable.$inferSelect;
export type DocumentAcknowledgement = typeof documentAcknowledgementsTable.$inferSelect;
export type DocumentDownload = typeof documentDownloadsTable.$inferSelect;
export type WorkspaceTask = typeof workspaceTasksTable.$inferSelect;
export type WorkspaceTaskComment = typeof workspaceTaskCommentsTable.$inferSelect;
export type WorkspaceTaskAttachment = typeof workspaceTaskAttachmentsTable.$inferSelect;
export type AnnouncementReadReceipt = typeof announcementReadReceiptsTable.$inferSelect;
export type AnnouncementAcknowledgement = typeof announcementAcknowledgementsTable.$inferSelect;
export type AnnouncementAttachment = typeof announcementAttachmentsTable.$inferSelect;