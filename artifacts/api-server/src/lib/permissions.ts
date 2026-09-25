import { and, eq, inArray } from "drizzle-orm";
import {
  channelsTable,
  categoriesTable,
  communitiesTable,
  customRolesTable,
  departmentsTable,
  db,
  permissionDefinitionsTable,
  rolePermissionsTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";
import { authorizationRoleRank } from "./role-grant-policy";

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
  "manage_organization",
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

// Platform-wide administration is never grantable through a scoped role.
export const CUSTOM_ROLE_PERMISSIONS = PERMISSIONS.filter((key) =>
  !["manage_users", "manage_roles", "manage_platform_settings", "manage_any_community",
    "view_system_logs", "push_application_updates", "create_community"].includes(key),
);

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
    "manage_organization",
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
    "manage_organization",
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
    "manage_organization",
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
    "manage_organization",
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
    "manage_organization",
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

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
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
  manage_organization: "Assign employees to departments, locations, and teams.",
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
  departmentId?: number;
  channelId?: number;
};

type Assignment = typeof userRolesTable.$inferSelect;
type PermissionDatabase = Pick<typeof db, "select">;

async function scopeFor(scope: PermissionScope, database: PermissionDatabase): Promise<PermissionScope> {
  if (scope.channelId !== undefined) {
    const [channel] = await database
      .select({ communityId: channelsTable.communityId, categoryId: channelsTable.categoryId })
      .from(channelsTable)
      .where(eq(channelsTable.id, scope.channelId));
    if (channel) return { ...scope, communityId: scope.communityId ?? channel.communityId ?? undefined, categoryId: scope.categoryId ?? channel.categoryId ?? undefined };
  }
  if (scope.categoryId !== undefined && scope.communityId === undefined) {
    const [category] = await database
      .select({ communityId: categoriesTable.communityId })
      .from(categoriesTable)
      .where(eq(categoriesTable.id, scope.categoryId));
    if (category) return { ...scope, communityId: category.communityId ?? undefined };
  }
  if (scope.departmentId !== undefined && scope.communityId === undefined) {
    const [department] = await database.select({ communityId: departmentsTable.communityId })
      .from(departmentsTable).where(eq(departmentsTable.id, scope.departmentId));
    if (department) return { ...scope, communityId: department.communityId };
  }
  return scope;
}

function assignmentMatches(assignment: Assignment, scope: PermissionScope): boolean {
  if (assignment.scopeType === "platform") return true;
  if (assignment.scopeType === "community") return assignment.communityId !== null && assignment.communityId === scope.communityId;
  if (assignment.scopeType === "category") return assignment.categoryId !== null && assignment.categoryId === scope.categoryId;
  if (assignment.scopeType === "department") return assignment.departmentId !== null && assignment.departmentId === scope.departmentId
    && assignment.communityId === scope.communityId;
  if (assignment.scopeType === "channel") return assignment.channelId !== null && assignment.channelId === scope.channelId;
  return false;
}

export type CommunityPermissionAssignment = Pick<
  Assignment,
  "role" | "scopeType" | "communityId"
>;
export type CommunityPermissionRow = {
  role: string;
  scopeType: string;
  key: string;
};
export type CommunityPermissionOperation =
  | "assignment-index"
  | "custom-permission-index"
  | "assignment-candidate"
  | "custom-permission-lookup";

export function evaluateCommunityPermissions(
  profileRole: string,
  communityIds: readonly number[],
  assignments: readonly CommunityPermissionAssignment[],
  customPermissionRows: readonly CommunityPermissionRow[],
  requestedPermissions: readonly PermissionKey[],
  observeOperation?: (operation: CommunityPermissionOperation) => void,
): Map<number, Set<PermissionKey>> {
  const result = new Map<number, Set<PermissionKey>>(
    communityIds.map((communityId) => [communityId, new Set<PermissionKey>()]),
  );
  const requested = new Set(requestedPermissions);
  if (!communityIds.length || !requested.size) return result;

  if (profileRole === "admin") {
    for (const permissions of result.values()) {
      for (const permission of requested) permissions.add(permission);
    }
    return result;
  }

  const addRolePermissions = (
    permissions: Set<PermissionKey>,
    role: string,
  ): void => {
    if (role in ROLE_PERMISSIONS) {
      for (const permission of ROLE_PERMISSIONS[role as AuthorizationRole]) {
        if (requested.has(permission)) permissions.add(permission);
      }
    }
  };
  const customPermissionsByRoleScope = new Map<
    string,
    Map<string, Set<PermissionKey>>
  >();
  for (const row of customPermissionRows) {
    observeOperation?.("custom-permission-index");
    if (!requested.has(row.key as PermissionKey)) continue;
    let permissionsByScope = customPermissionsByRoleScope.get(row.role);
    if (!permissionsByScope) {
      permissionsByScope = new Map();
      customPermissionsByRoleScope.set(row.role, permissionsByScope);
    }
    let permissions = permissionsByScope.get(row.scopeType);
    if (!permissions) {
      permissions = new Set();
      permissionsByScope.set(row.scopeType, permissions);
    }
    permissions.add(row.key as PermissionKey);
  }

  const requestedCommunityIds = new Set(communityIds);
  const platformAssignments: CommunityPermissionAssignment[] = [];
  const assignmentsByCommunity = new Map<
    number,
    CommunityPermissionAssignment[]
  >();
  let primaryAssignment: CommunityPermissionAssignment | undefined;
  for (const assignment of assignments) {
    observeOperation?.("assignment-index");
    if (primaryAssignment === undefined && assignment.role === profileRole) {
      primaryAssignment = assignment;
    }
    if (assignment.scopeType === "platform") {
      platformAssignments.push(assignment);
    } else if (
      assignment.scopeType === "community"
      && assignment.communityId !== null
      && requestedCommunityIds.has(assignment.communityId)
    ) {
      const scopedAssignments =
        assignmentsByCommunity.get(assignment.communityId) ?? [];
      scopedAssignments.push(assignment);
      assignmentsByCommunity.set(assignment.communityId, scopedAssignments);
    }
  }

  const addAssignmentPermissions = (
    permissions: Set<PermissionKey>,
    assignment: CommunityPermissionAssignment,
  ): void => {
    observeOperation?.("custom-permission-lookup");
    addRolePermissions(permissions, assignment.role);
    const customPermissions = customPermissionsByRoleScope
      .get(assignment.role)
      ?.get(assignment.scopeType);
    if (customPermissions) {
      for (const permission of customPermissions) permissions.add(permission);
    }
  };

  const globalPermissions = new Set<PermissionKey>();
  if (profileRole === "platform_moderator" || profileRole === "moderator") {
    addRolePermissions(globalPermissions, profileRole);
  }
  if (
    PRIMARY_ROLES.includes(profileRole as PrimaryRole) &&
    profileRole !== "community_admin"
  ) {
    addRolePermissions(globalPermissions, profileRole);
  }
  for (const assignment of platformAssignments) {
    observeOperation?.("assignment-candidate");
    addAssignmentPermissions(globalPermissions, assignment);
  }

  for (const communityId of communityIds) {
    const permissions = new Set(globalPermissions);
    if (
      profileRole === "community_admin" &&
      primaryAssignment &&
      (primaryAssignment.scopeType === "platform" ||
        (primaryAssignment.scopeType === "community" &&
          primaryAssignment.communityId === communityId))
    ) {
      addRolePermissions(permissions, profileRole);
    }

    for (const assignment of assignmentsByCommunity.get(communityId) ?? []) {
      observeOperation?.("assignment-candidate");
      addAssignmentPermissions(permissions, assignment);
    }
    result.set(communityId, permissions);
  }

  return result;
}

function roleAllows(role: string, permission: PermissionKey): boolean {
  return role in ROLE_PERMISSIONS && ROLE_PERMISSIONS[role as AuthorizationRole].includes(permission);
}

export async function hasPermission(
  userId: string,
  permission: PermissionKey,
  rawScope: PermissionScope = {},
  database: PermissionDatabase = db,
  lockAuthorizationRows = false,
  userLockMode: "update" | "no key update" = "update",
): Promise<boolean> {
  const userQuery = database
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.clerkId, userId));
  const [user] = lockAuthorizationRows
    ? await userQuery.for(userLockMode)
    : await userQuery;
  if (!user) return false;
  if (user.role === "admin") return true;

  const scope = await scopeFor(rawScope, database);
  if (["platform_moderator", "moderator"].includes(user.role) && roleAllows(user.role, permission)) return true;

  const assignmentsQuery = database
    .select()
    .from(userRolesTable)
    .where(eq(userRolesTable.userId, userId));
  const assignments = lockAuthorizationRows
    ? await assignmentsQuery.for("update")
    : await assignmentsQuery;

  if (PRIMARY_ROLES.includes(user.role as PrimaryRole) && roleAllows(user.role, permission)) {
    const primaryAssignment = assignments.find((assignment) => assignment.role === user.role);
    if (user.role !== "community_admin" || (primaryAssignment && assignmentMatches(primaryAssignment, scope))) return true;
  }
  const matchingAssignments = assignments.filter((assignment) =>
    assignmentMatches(assignment, scope),
  );
  if (matchingAssignments.some((assignment) =>
    roleAllows(assignment.role, permission),
  )) {
    return true;
  }
  const customRoleNames = [
    ...new Set(
      matchingAssignments
        .map((assignment) => assignment.role)
        .filter((role) => !(role in ROLE_PERMISSIONS)),
    ),
  ];
  if (!customRoleNames.length) return false;
  const activeRolesQuery = database.select({ key: customRolesTable.key, scopeType: customRolesTable.scopeType })
    .from(customRolesTable)
    .where(and(inArray(customRolesTable.key, customRoleNames), eq(customRolesTable.isActive, true)));
  // A role definition is the authority-granting row: lock it before checking its
  // links so a concurrent retirement/edit cannot commit between check and write.
  const activeRoles = lockAuthorizationRows ? await activeRolesQuery.for("share") : await activeRolesQuery;
  const activeNames = activeRoles.filter((role) =>
    matchingAssignments.some((assignment) => assignment.role === role.key && assignment.scopeType === role.scopeType),
  ).map((role) => role.key);
  if (!activeNames.length) return false;
  const customRoleMatchesQuery = database
    .select({ role: rolePermissionsTable.role })
    .from(rolePermissionsTable)
    .innerJoin(
      permissionDefinitionsTable,
      eq(permissionDefinitionsTable.id, rolePermissionsTable.permissionId),
    )
    .where(and(
      inArray(rolePermissionsTable.role, activeNames),
      eq(permissionDefinitionsTable.key, permission),
    ));
  const customRoleMatches = lockAuthorizationRows
    ? await customRoleMatchesQuery.for("update")
    : await customRoleMatchesQuery;
  return customRoleMatches.length > 0;
}

export async function permissionsForCommunities(
  userId: string,
  communityIds: number[],
  requestedPermissions: readonly PermissionKey[],
): Promise<Map<number, Set<PermissionKey>>> {
  const result = new Map<number, Set<PermissionKey>>(
    communityIds.map((communityId) => [communityId, new Set<PermissionKey>()]),
  );
  const requested = new Set(requestedPermissions);
  if (!communityIds.length || !requested.size) return result;

  const [user, assignments] = await Promise.all([
    db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.clerkId, userId)),
    db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId)),
  ]);
  const profile = user[0];
  if (!profile) return result;

  const addRolePermissions = (permissions: Set<PermissionKey>, role: string): void => {
    if (role in ROLE_PERMISSIONS) {
      for (const permission of ROLE_PERMISSIONS[role as AuthorizationRole]) {
        if (requested.has(permission)) permissions.add(permission);
      }
    }
  };

  if (profile.role === "admin") {
    for (const permissions of result.values()) {
      for (const permission of requested) permissions.add(permission);
    }
    return result;
  }

  const customRoleNames = [
    ...new Set(
      assignments
        .map((assignment) => assignment.role)
        .filter((role) => !(role in ROLE_PERMISSIONS)),
    ),
  ];
  const customPermissionRows = customRoleNames.length
    ? await db.select({
      role: rolePermissionsTable.role,
      scopeType: customRolesTable.scopeType,
      key: permissionDefinitionsTable.key,
    }).from(rolePermissionsTable)
      .innerJoin(permissionDefinitionsTable, eq(permissionDefinitionsTable.id, rolePermissionsTable.permissionId))
      .innerJoin(customRolesTable, and(eq(customRolesTable.key, rolePermissionsTable.role), eq(customRolesTable.isActive, true)))
      .where(inArray(rolePermissionsTable.role, customRoleNames))
    : [];
  return evaluateCommunityPermissions(
    profile.role,
    communityIds,
    assignments,
    customPermissionRows,
    requestedPermissions,
  );
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
    const customPermissions = await db.select({ key: permissionDefinitionsTable.key, role: rolePermissionsTable.role, scopeType: customRolesTable.scopeType })
      .from(rolePermissionsTable)
      .innerJoin(permissionDefinitionsTable, eq(permissionDefinitionsTable.id, rolePermissionsTable.permissionId))
      .innerJoin(customRolesTable, and(eq(customRolesTable.key, rolePermissionsTable.role), eq(customRolesTable.isActive, true)))
      .where(inArray(rolePermissionsTable.role, customRoleNames));
    for (const item of customPermissions) {
      if (assignments.some((assignment) => assignment.role === item.role && assignment.scopeType === item.scopeType)
        && PERMISSIONS.includes(item.key as PermissionKey)) permissionSet.add(item.key as PermissionKey);
    }
  }
  const effectiveRole = [user?.role ?? "member", ...assignments.map((assignment) => assignment.role)]
    .filter((role) => role in ROLE_PERMISSIONS)
    .sort(
      (left, right) =>
        authorizationRoleRank(right) - authorizationRoleRank(left),
    )[0] ?? "member";
  return { role: effectiveRole, permissions: [...permissionSet], assignments };
}

export async function communityForId(communityId: number) {
  const [community] = await db.select().from(communitiesTable).where(eq(communitiesTable.id, communityId));
  return community ?? null;
}