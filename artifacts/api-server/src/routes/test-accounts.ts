import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import {
  adminAuditLogsTable,
  communityMembersTable,
  communitiesTable,
  db,
  employeeProfilesTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, getUserId, type AuthenticatedRequest } from "../lib/auth";
import { FixedWindowLimiter, rateLimitKey } from "../lib/fixed-window-limiter";
import {
  isMarkedTestAccount,
  testAccountExternalId,
  testAccountMetadata,
  testAccountsAvailable,
  TEST_ACCOUNT_ROLES,
  type TestAccountRole,
} from "../lib/test-account-policy";

const router: IRouter = Router();
const loginTicketLimiter = new FixedWindowLimiter(10, 60_000);

function communityId(req: AuthenticatedRequest): number {
  const raw = req.params.communityId;
  return Number(Array.isArray(raw) ? raw[0] : raw);
}

async function ownedWorkspace(userId: string, id: number) {
  const [workspace] = await db.select().from(communitiesTable).where(and(
    eq(communitiesTable.id, id),
    eq(communitiesTable.ownerId, userId),
  ));
  return workspace;
}

async function audit(actorId: string, workspaceId: number, action: string, details: string) {
  await db.insert(adminAuditLogsTable).values({
    actorId, communityId: workspaceId, action, details,
    resourceType: "test_account", resourceId: String(workspaceId),
    targetId: String(workspaceId), targetLabel: `workspace:${workspaceId}`,
  });
}

router.use("/communities/:communityId/test-accounts", requireAuth);

router.get("/communities/:communityId/test-accounts", async (req: AuthenticatedRequest, res) => {
  if (!testAccountsAvailable(process.env)) { res.status(404).json({ error: "Development test accounts are unavailable." }); return; }
  const id = communityId(req);
  const workspace = await ownedWorkspace(getUserId(req), id);
  if (!workspace) { res.status(404).json({ error: "Workspace not found." }); return; }
  const users = await clerkClient.users.getUserList({
    externalId: TEST_ACCOUNT_ROLES.map((role) => testAccountExternalId(id, role)),
  });
  const marked = users.data.filter((user) => (
    isMarkedTestAccount(user.publicMetadata, id)
    && TEST_ACCOUNT_ROLES.includes((user.publicMetadata as Record<string, unknown>).role as TestAccountRole)
  ));
  res.json(marked.map((user) => ({
    id: user.id,
    role: (user.publicMetadata as Record<string, unknown>).role,
    displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.id,
    username: user.username,
  })));
});

router.post("/communities/:communityId/test-accounts/provision", async (req: AuthenticatedRequest, res) => {
  if (!testAccountsAvailable(process.env)) { res.status(404).json({ error: "Development test accounts are unavailable." }); return; }
  const creatorId = getUserId(req);
  const id = communityId(req);
  const workspace = await ownedWorkspace(creatorId, id);
  if (!workspace) { res.status(404).json({ error: "Workspace not found." }); return; }
  const allUsers = await clerkClient.users.getUserList({
    externalId: TEST_ACCOUNT_ROLES.map((role) => testAccountExternalId(id, role)),
  });
  const createdIds: string[] = [];
  try {
    const accounts = new Map<TestAccountRole, string>();
    for (const role of TEST_ACCOUNT_ROLES) {
      const externalId = testAccountExternalId(id, role);
      const existing = allUsers.data.find((user) => user.externalId === externalId);
      let user = existing;
      if (!user) {
        user = await clerkClient.users.createUser({
          externalId,
          username: `relay_test_${id}_${role}`,
          emailAddress: [`relay-test-${id}-${role}@relay.invalid`],
          emailAddressIdentificationStatus: ["reserved"],
          skipPasswordRequirement: true,
          publicMetadata: testAccountMetadata(id, role, creatorId),
        });
        createdIds.push(user.id);
      } else if (!isMarkedTestAccount(user.publicMetadata, id, role)) {
        throw new Error("A conflicting Clerk account uses the test account identifier.");
      }
      accounts.set(role, user.id);
    }
    await db.transaction(async (tx) => {
      for (const role of TEST_ACCOUNT_ROLES) {
        const userId = accounts.get(role)!;
        await tx.insert(usersTable).values({
          clerkId: userId,
          username: `relay_test_${id}_${role}`,
          displayName: `Test ${role.replaceAll("_", " ")}`,
          status: "offline",
        }).onConflictDoNothing({ target: usersTable.clerkId });
        await tx.insert(communityMembersTable).values({ communityId: id, userId, status: "member" }).onConflictDoNothing();
        await tx.insert(employeeProfilesTable).values({
          communityId: id, userId, employmentStatus: "active", onboardedAt: new Date(),
        }).onConflictDoNothing();
        await tx.insert(userRolesTable).values({
          userId, role, scopeType: "community", communityId: id, grantedBy: creatorId,
        }).onConflictDoNothing();
      }
    });
    await audit(creatorId, id, "provisioned_test_accounts", `Provisioned ${TEST_ACCOUNT_ROLES.length} Relay test accounts.`);
    res.status(200).json({ accounts: TEST_ACCOUNT_ROLES.map((role) => ({ role, userId: accounts.get(role) })) });
  } catch (error) {
    await Promise.allSettled(createdIds.map((userId) => clerkClient.users.deleteUser(userId)));
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to provision test accounts." });
  }
});

router.post("/communities/:communityId/test-accounts/:role/login", async (req: AuthenticatedRequest, res) => {
  if (!testAccountsAvailable(process.env)) { res.status(404).json({ error: "Development test accounts are unavailable." }); return; }
  const creatorId = getUserId(req);
  const id = communityId(req);
  const role = (Array.isArray(req.params.role) ? req.params.role[0] : req.params.role) as TestAccountRole;
  if (!TEST_ACCOUNT_ROLES.includes(role)) { res.status(400).json({ error: "Invalid test account role." }); return; }
  if (!(await ownedWorkspace(creatorId, id))) { res.status(404).json({ error: "Workspace not found." }); return; }
  const result = loginTicketLimiter.check(rateLimitKey(creatorId, req.ip ?? req.socket.remoteAddress ?? "unknown"));
  if (!result.allowed) {
    res.set("Retry-After", String(result.retryAfterSeconds)).status(429).json({ error: "Too many test account login requests." });
    return;
  }
  const users = await clerkClient.users.getUserList({ externalId: [testAccountExternalId(id, role)] });
  const user = users.data.find((candidate) => isMarkedTestAccount(candidate.publicMetadata, id, role));
  if (!user) { res.status(404).json({ error: "Test account not found. Provision it first." }); return; }
  const ticket = await clerkClient.signInTokens.createSignInToken({ userId: user.id, expiresInSeconds: 60 });
  await audit(creatorId, id, "issued_test_account_login_ticket", `Issued a short-lived login ticket for the ${role} test account.`);
  res.json({ ticket: ticket.token, expiresInSeconds: 60 });
});

export default router;