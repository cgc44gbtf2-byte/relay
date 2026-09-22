import { and, eq, inArray } from "drizzle-orm";
import {
  channelsTable,
  categoriesTable,
  communitiesTable,
  db,
  permissionDefinitionsTable,
  rolePermissionsTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";

export const PRIMARY_ROLES = ["admin", "platform_moderator", "moderator", "community_admin", "member"] as const;
export type PrimaryRole = typeof PRIMARY_ROLES[number];
export const BUSINESS_ROLES = ["workspace_owner", "workspace_admin", "department_admin", "manager", "business_owner", "business_manager", "employee", "contractor"] as const;
export type BusinessRole = typeof BUSINESS_ROLES[number];
export type AuthorizationRole = PrimaryRole | BusinessRole;

export const PERMISSIONS = [
  "manage_users",
  "manage_roles",
  "manage_platform_settings",
  "manage_any_community",
  "view_system_logs",
  "push_application_updates",
  "view_users",
  "moderate_channel",
  "delete_message",
  "mute_user",
  "kick_user",
  "ban_user",
  "unban_user",
  "view_moderation_logs",
  "restrict_channel",
  "create_community",
  "manage_community",
  "create_channel",
  "manage_channel",
  "manage_community_members",
  "create_announcement",
  "view_business",
  "manage_business",
  "manage_business_members",
  "manage_leads",
  "manage_customers",
  "manage_jobs",
  "manage_appointments",
  "manage_ai",
  "view_analytics",
  "manage_integrations",
  "manage_billing",
  "view_business_reports",
  "update_assigned_job",
  "manage_assigned_appointments",
  "communicate",
] as const;
export type PermissionKey = typeof PERMISSIONS[number];

const ROLE_PERMISSIONS: Record<AuthorizationRole, readonly PermissionKey[]> = {
  admin: PERMISSIONS,
  platform_moderator: [
    "view_users",
    "moderate_channel",
    "delete_message",
    "mute_user",
    "kick_user",
    "ban_user",
    "unban_user",
    "view_moderation_logs",
    "restrict_channel",
    "manage_any_community",
  ],
  moderator: [
    "view_users",
    "moderate_channel",
    "delete_message",
    "mute_user",
    "kick_user",
    "ban_user",
    "unban_user",
    "view_moderation_logs",
    "restrict_channel",
  ],
  community_admin: [
    "create_channel",
    "manage_channel",
    "manage_community",
    "manage_community_members",
    "mute_user",
    "kick_user",
    "ban_user",
    "unban_user",
    "create_announcement",
    "view_moderation_logs",
  ],
  member: [],
  workspace_owner: [
    "view_business",
    "manage_business",
    "manage_business_members",
    "manage_community",
    "manage_community_members",
    "create_channel",
    "manage_channel",
    "create_announcement",
    "view_users",
    "moderate_channel",
    "view_moderation_logs",
    "manage_leads",
    "manage_customers",
    "manage_jobs",
    "manage_appointments",
    "manage_ai",
    "view_analytics",
    "manage_integrations",
    "manage_billing",
    "view_business_reports",
    "communicate",
  ],
  workspace_admin: [
    "view_business",
    "manage_business",
    "manage_business_members",
    "manage_community",
    "manage_community_members",
    "create_channel",
    "manage_channel",
    "create_announcement",
    "view_users",
    "moderate_channel",
    "view_moderation_logs",
    "view_analytics",
    "view_business_reports",
    "communicate",
  ],
  department_admin: [
    "view_business",
    "manage_community_members",
    "create_channel",
    "manage_channel",
    "create_announcement",
    "view_users",
    "moderate_channel",
    "view_moderation_logs",
    "communicate",
  ],
  manager: [
    "view_business",
    "view_users",
    "manage_community_members",
    "manage_channel",
    "create_announcement",
    "moderate_channel",
    "manage_jobs",
    "manage_appointments",
    "view_business_reports",
    "communicate",
  ],
  business_owner: [
    "view_business",
    "manage_business",
    "manage_business_members",
    "manage_community",
    "create_channel",
    "manage_channel",
    "create_announcement",
    "manage_leads",
    "manage_customers",
    "manage_jobs",
    "manage_appointments",
    "manage_ai",
    "view_analytics",
    "manage_integrations",
    "manage_billing",
    "view_business_reports",
    "communicate",
  ],
  business_manager: [
    "view_business",
    "view_users",
    "create_channel",
    "manage_channel",
    "manage_leads",
    "manage_customers",
    "manage_jobs",
    "manage_appointments",
    "manage_ai",
    "view_analytics",
    "view_business_reports",
    "communicate",
  ],
  employee: [
    "view_business",
    "view_users",
    "update_assigned_job",
    "manage_assigned_appointments",
    "communicate",
  ],
  contractor: [
    "view_business",
    "update_assigned_job",
    "communicate",
  ],
};

const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  manage_users: "Manage platform user accounts.",
  manage_roles: "Grant and revoke platform role assignments.",
  manage_platform_settings: "Change platform configuration.",
  manage_any_community: "Manage every community.",
  view_system_logs: "View platform system logs.",
  push_application_updates: "Manage application updates.",
  view_users: "View users within the permitted scope.",
  moderate_channel: "Apply moderation actions in the permitted scope.",
  delete_message: "Delete messages in the permitted scope.",
  mute_user: "Mute users in the permitted scope.",
  kick_user: "Remove users from the permitted scope.",
  ban_user: "Ban users in the permitted scope.",
  unban_user: "Lift bans in the permitted scope.",
  view_moderation_logs: "View moderation history in the permitted scope.",
  restrict_channel: "Restrict channel access in the permitted scope.",
  create_community: "Create communities.",
  manage_community: "Manage community settings and rules.",
  create_channel: "Create channels in the permitted scope.",
  manage_channel: "Manage channel settings in the permitted scope.",
  manage_community_members: "Manage members in the permitted scope.",
  create_announcement: "Publish announcements in the permitted scope.",
  view_business: "View the permitted private business workspace.",
  manage_business: "Manage the permitted business workspace.",
  manage_business_members: "Manage users in the permitted business workspace.",
  manage_leads: "Manage leads in the permitted business workspace.",
  manage_customers: "Manage customers in the permitted business workspace.",
  manage_jobs: "Manage jobs in the permitted business workspace.",
  manage_appointments: "Manage appointments in the permitted business workspace.",
  manage_ai: "Configure AI agents and conversations in the permitted business workspace.",
  view_analytics: "View analytics for the permitted business workspace.",
  manage_integrations: "Manage integrations for the permitted business workspace.",
  manage_billing: "Manage billing for the permitted business workspace.",
  view_business_reports: "View reports for the permitted business workspace.",
  update_assigned_job: "Update assigned jobs.",
  manage_assigned_appointments: "Manage assigned appointments.",
  communicate: "Communicate in authorized business channels.",
};

export async function ensurePermissionCatalog(): Promise<void> {
  await db.insert(permissionDefinitionsTable).values(
    PERMISSIONS.map((key) => ({ key, description: PERMISSION_DESCRIPTIONS[key] })),
  ).onConflictDoNothing();
  const definitions = await db.select({ id: permissionDefinitionsTable.id, key: permissionDefinitionsTable.key })
    .from(permissionDefinitionsTable);
  const ids = new Map(definitions.map((definition) => [definition.key, definition.id]));
  const links = [...PRIMARY_ROLES, ...BUSINESS_ROLES].flatMap((role) => ROLE_PERMISSIONS[role]
    .map((permission) => ids.get(permission))
    .filter((permissionId): permissionId is number => permissionId !== undefined)
    .map((permissionId) => ({ role, permissionId })));
  if (links.length) await db.insert(rolePermissionsTable).values(links).onConflictDoNothing();
}

export type PermissionScope = {
  communityId?: number;
  categoryId?: number;
  channelId?: number;
};

type Assignment = typeof userRolesTable.$inferSelect;

async function scopeFor(scope: PermissionScope): Promise<PermissionScope> {
  if (scope.channelId !== undefined) {
    const [channel] = await db
      .select({ communityId: channelsTable.communityId, categoryId: channelsTable.categoryId })
      .from(channelsTable)
      .where(eq(channelsTable.id, scope.channelId));
    if (channel) return { ...scope, communityId: scope.communityId ?? channel.communityId ?? undefined, categoryId: scope.categoryId ?? channel.categoryId ?? undefined };
  }
  if (scope.categoryId !== undefined && scope.communityId === undefined) {
    const [category] = await db
      .select({ communityId: categoriesTable.communityId })
      .from(categoriesTable)
      .where(eq(categoriesTable.id, scope.categoryId));
    if (category) return { ...scope, communityId: category.communityId ?? undefined };
  }
  return scope;
}

function assignmentMatches(assignment: Assignment, scope: PermissionScope): boolean {
  if (assignment.scopeType === "platform") return true;
  if (assignment.scopeType === "community") return assignment.communityId !== null && assignment.communityId === scope.communityId;
  if (assignment.scopeType === "category") return assignment.categoryId !== null && assignment.categoryId === scope.categoryId;
  if (assignment.scopeType === "channel") return assignment.channelId !== null && assignment.channelId === scope.channelId;
  return false;
}

function roleAllows(role: string, permission: PermissionKey): boolean {
  return role in ROLE_PERMISSIONS && ROLE_PERMISSIONS[role as AuthorizationRole].includes(permission);
}

async function customRoleAllows(role: string, permission: PermissionKey): Promise<boolean> {
  const [match] = await db.select({ role: rolePermissionsTable.role })
    .from(rolePermissionsTable)
    .innerJoin(permissionDefinitionsTable, eq(permissionDefinitionsTable.id, rolePermissionsTable.permissionId))
    .where(and(eq(rolePermissionsTable.role, role), eq(permissionDefinitionsTable.key, permission)))
    .limit(1);
  return Boolean(match);
}

function roleRank(role: string): number {
  return role === "admin" ? 8
    : role === "platform_moderator" ? 7
      : ["workspace_owner", "business_owner"].includes(role) ? 6
        : role === "workspace_admin" ? 5
          : ["department_admin", "community_admin"].includes(role) ? 4
            : ["manager", "business_manager"].includes(role) ? 3
              : role === "moderator" ? 2
            : 1;
}

export async function hasPermission(
  userId: string,
  permission: PermissionKey,
  rawScope: PermissionScope = {},
): Promise<boolean> {
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.clerkId, userId));
  if (!user) return false;
  if (user.role === "admin") return true;

  const scope = await scopeFor(rawScope);
  if (["platform_moderator", "moderator"].includes(user.role) && roleAllows(user.role, permission)) return true;

  const assignments = await db
    .select()
    .from(userRolesTable)
    .where(eq(userRolesTable.userId, userId));

  if (PRIMARY_ROLES.includes(user.role as PrimaryRole) && roleAllows(user.role, permission)) {
    const primaryAssignment = assignments.find((assignment) => assignment.role === user.role);
    if (user.role !== "community_admin" || (primaryAssignment && assignmentMatches(primaryAssignment, scope))) return true;
  }
  for (const assignment of assignments) {
    if (assignmentMatches(assignment, scope) && (roleAllows(assignment.role, permission) || await customRoleAllows(assignment.role, permission))) return true;
  }
  return false;
}

export async function permissionsForUser(userId: string): Promise<{
  role: string;
  permissions: PermissionKey[];
  assignments: Assignment[];
}> {
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.clerkId, userId));
  const assignments = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId));
  const permissionSet = new Set<PermissionKey>();
  if (user && user.role in ROLE_PERMISSIONS) {
    for (const permission of ROLE_PERMISSIONS[user.role as AuthorizationRole]) permissionSet.add(permission);
  }
  for (const assignment of assignments) {
    if (assignment.role in ROLE_PERMISSIONS) {
      for (const permission of ROLE_PERMISSIONS[assignment.role as AuthorizationRole]) permissionSet.add(permission);
    }
  }
  const customRoleNames = assignments.map((assignment) => assignment.role).filter((role) => !(role in ROLE_PERMISSIONS));
  if (customRoleNames.length) {
    const customPermissions = await db.select({ key: permissionDefinitionsTable.key })
      .from(rolePermissionsTable)
      .innerJoin(permissionDefinitionsTable, eq(permissionDefinitionsTable.id, rolePermissionsTable.permissionId))
      .where(inArray(rolePermissionsTable.role, customRoleNames));
    for (const item of customPermissions) {
      if (PERMISSIONS.includes(item.key as PermissionKey)) permissionSet.add(item.key as PermissionKey);
    }
  }
  const effectiveRole = [user?.role ?? "member", ...assignments.map((assignment) => assignment.role)]
    .filter((role) => role in ROLE_PERMISSIONS)
    .sort((left, right) => roleRank(right) - roleRank(left))[0] ?? "member";
  return { role: effectiveRole, permissions: [...permissionSet], assignments };
}

export async function communityForId(communityId: number) {
  const [community] = await db.select().from(communitiesTable).where(eq(communitiesTable.id, communityId));
  return community ?? null;
}