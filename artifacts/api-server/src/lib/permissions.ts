import { and, eq } from "drizzle-orm";
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

export const PRIMARY_ROLES = ["admin", "moderator", "community_admin", "member"] as const;
export type PrimaryRole = typeof PRIMARY_ROLES[number];

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
] as const;
export type PermissionKey = typeof PERMISSIONS[number];

const ROLE_PERMISSIONS: Record<PrimaryRole, readonly PermissionKey[]> = {
  admin: PERMISSIONS,
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
};

export async function ensurePermissionCatalog(): Promise<void> {
  await db.insert(permissionDefinitionsTable).values(
    PERMISSIONS.map((key) => ({ key, description: PERMISSION_DESCRIPTIONS[key] })),
  ).onConflictDoNothing();
  const definitions = await db.select({ id: permissionDefinitionsTable.id, key: permissionDefinitionsTable.key })
    .from(permissionDefinitionsTable);
  const ids = new Map(definitions.map((definition) => [definition.key, definition.id]));
  const links = PRIMARY_ROLES.flatMap((role) => ROLE_PERMISSIONS[role]
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
  return PRIMARY_ROLES.includes(role as PrimaryRole) && ROLE_PERMISSIONS[role as PrimaryRole].includes(permission);
}

function roleRank(role: string): number {
  return role === "admin" ? 4 : role === "moderator" ? 3 : role === "community_admin" ? 2 : 1;
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
  if (user.role === "moderator" && roleAllows("moderator", permission)) return true;

  const assignments = await db
    .select()
    .from(userRolesTable)
    .where(eq(userRolesTable.userId, userId));

  if (roleAllows(user.role, permission)) {
    const primaryAssignment = assignments.find((assignment) => assignment.role === user.role);
    if (user.role !== "community_admin" || (primaryAssignment && assignmentMatches(primaryAssignment, scope))) return true;
  }
  return assignments.some((assignment) => roleAllows(assignment.role, permission) && assignmentMatches(assignment, scope));
}

export async function permissionsForUser(userId: string): Promise<{
  role: string;
  permissions: PermissionKey[];
  assignments: Assignment[];
}> {
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.clerkId, userId));
  const assignments = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId));
  const permissionSet = new Set<PermissionKey>();
  if (user && PRIMARY_ROLES.includes(user.role as PrimaryRole)) {
    for (const permission of ROLE_PERMISSIONS[user.role as PrimaryRole]) permissionSet.add(permission);
  }
  for (const assignment of assignments) {
    if (PRIMARY_ROLES.includes(assignment.role as PrimaryRole)) {
      for (const permission of ROLE_PERMISSIONS[assignment.role as PrimaryRole]) permissionSet.add(permission);
    }
  }
  const effectiveRole = [user?.role ?? "member", ...assignments.map((assignment) => assignment.role)]
    .filter((role) => PRIMARY_ROLES.includes(role as PrimaryRole))
    .sort((left, right) => roleRank(right) - roleRank(left))[0] ?? "member";
  return { role: effectiveRole, permissions: [...permissionSet], assignments };
}

export async function communityForId(communityId: number) {
  const [community] = await db.select().from(communitiesTable).where(eq(communitiesTable.id, communityId));
  return community ?? null;
}