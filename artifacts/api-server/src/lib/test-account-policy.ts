export const TEST_ACCOUNT_ROLES = ["workspace_admin", "department_admin", "manager", "moderator", "member"] as const;
export type TestAccountRole = typeof TEST_ACCOUNT_ROLES[number];
export const TEST_ACCOUNT_MARKER = "relay_test_account";

export function testAccountsAvailable(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== "production"
    && env.CLERK_SECRET_KEY?.startsWith("sk_test_") === true
    && env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") === true;
}

export function testAccountExternalId(workspaceId: number, role: TestAccountRole): string {
  return `relay-test:${workspaceId}:${role}`;
}

export function testAccountMetadata(workspaceId: number, role: TestAccountRole, creatorId: string) {
  return { relay: TEST_ACCOUNT_MARKER, workspaceId: String(workspaceId), role, createdBy: creatorId };
}

export function isMarkedTestAccount(metadata: unknown, workspaceId: number, role?: string): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const value = metadata as Record<string, unknown>;
  return value.relay === TEST_ACCOUNT_MARKER
    && String(value.workspaceId) === String(workspaceId)
    && (role === undefined || value.role === role)
    && (role === undefined || TEST_ACCOUNT_ROLES.includes(role as TestAccountRole));
}

export function exactWorkspaceOwner(ownerId: string, authenticatedUserId: string): boolean {
  return ownerId === authenticatedUserId;
}