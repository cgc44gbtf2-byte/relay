const AUTHORIZATION_ROLE_RANK: Readonly<Record<string, number>> = {
  member: 1,
  employee: 1,
  contractor: 1,
  moderator: 2,
  manager: 3,
  business_manager: 3,
  department_admin: 4,
  community_admin: 4,
  workspace_admin: 5,
  workspace_owner: 6,
  business_owner: 6,
  platform_moderator: 7,
  admin: 8,
};

export function authorizationRoleRank(role: string): number {
  return AUTHORIZATION_ROLE_RANK[role] ?? 0;
}

export function canGrantWorkspaceRole(
  actorRoles: readonly string[],
  targetRole: string,
): boolean {
  const targetRank = authorizationRoleRank(targetRole);
  if (targetRank === 0 || targetRank > authorizationRoleRank("workspace_owner")) {
    return false;
  }
  const actorRank = Math.max(
    0,
    ...actorRoles.map((role) => authorizationRoleRank(role)),
  );
  return actorRank > targetRank;
}