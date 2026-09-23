import { clerkClient } from "@clerk/express";
import { and, eq, or } from "drizzle-orm";
import {
  blocksTable, channelBansTable, channelInvitesTable, channelJoinRequestsTable,
  channelMembersTable, communityMembersTable, db, employeeProfilesTable,
  messageReactionsTable, notificationsTable, teamMembersTable, userRolesTable,
  usersTable, workspaceInvitationsTable, teamsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { wsHub } from "./ws";

function clerkNotFound(error: unknown): boolean {
  const value = error as { status?: number; errors?: Array<{ code?: string; message?: string }> };
  return value?.status === 404 || !!value?.errors?.some((item) => item.code === "resource_not_found" || item.code === "user_not_found")
    || !!value?.errors?.some((item) => item.message?.toLowerCase().includes("not found"));
}

export async function finalizePendingAccountDeletion(
  userId: string,
  dependencies: { deleteClerkUser?: (userId: string) => Promise<unknown> } = {},
): Promise<"completed" | "retryable" | "not_pending"> {
  const [subject] = await db.select().from(usersTable).where(eq(usersTable.clerkId, userId));
  if (!subject || subject.deletionStatus !== "pending") return "not_pending";
  if (subject.clerkDeletionStatus !== "deleted") {
    try {
      await (dependencies.deleteClerkUser ?? ((id: string) => clerkClient.users.deleteUser(id)))(userId);
    } catch (error) {
      if (!clerkNotFound(error)) {
        await db.update(usersTable).set({
          clerkDeletionStatus: "failed",
          clerkDeletionAttempts: subject.clerkDeletionAttempts + 1,
          clerkDeletionLastError: error instanceof Error ? error.message : "Clerk deletion failed",
        }).where(and(eq(usersTable.clerkId, userId), eq(usersTable.deletionStatus, "pending")));
        return "retryable";
      }
    }
    await db.update(usersTable).set({
      clerkDeletionStatus: "deleted",
      clerkDeletionAttempts: subject.clerkDeletionAttempts + 1,
      clerkDeletionLastError: null,
    }).where(and(eq(usersTable.clerkId, userId), eq(usersTable.deletionStatus, "pending")));
  }
  await db.transaction(async (tx) => {
    await tx.delete(communityMembersTable).where(eq(communityMembersTable.userId, userId));
    await tx.delete(userRolesTable).where(eq(userRolesTable.userId, userId));
    await tx.delete(channelMembersTable).where(eq(channelMembersTable.userId, userId));
    await tx.delete(teamMembersTable).where(eq(teamMembersTable.userId, userId));
    await tx.delete(channelBansTable).where(eq(channelBansTable.userId, userId));
    await tx.delete(channelInvitesTable).where(or(eq(channelInvitesTable.userId, userId), eq(channelInvitesTable.invitedBy, userId)));
    await tx.delete(channelJoinRequestsTable).where(or(eq(channelJoinRequestsTable.userId, userId), eq(channelJoinRequestsTable.reviewedBy, userId)));
    await tx.delete(messageReactionsTable).where(eq(messageReactionsTable.userId, userId));
    await tx.delete(notificationsTable).where(eq(notificationsTable.userId, userId));
    await tx.delete(blocksTable).where(or(eq(blocksTable.blockerId, userId), eq(blocksTable.blockedId, userId)));
    await tx.update(employeeProfilesTable).set({ managerId: null }).where(eq(employeeProfilesTable.managerId, userId));
    await tx.update(teamsTable).set({ managerId: null }).where(eq(teamsTable.managerId, userId));
    await tx.update(workspaceInvitationsTable).set({ invitedUserId: null }).where(eq(workspaceInvitationsTable.invitedUserId, userId));
    await tx.update(usersTable).set({
      accountStatus: "suspended", deletionStatus: "completed", username: `deleted-${userId.slice(-16)}`,
      displayName: "[deleted user]", avatarUrl: null, status: "offline",
    }).where(and(eq(usersTable.clerkId, userId), eq(usersTable.clerkDeletionStatus, "deleted")));
  });
  wsHub.disconnectUser(userId, "Account deleted.");
  return "completed";
}

export async function rejectPendingDeletion(userId: string, database = db): Promise<boolean> {
  const [user] = await database.select({ deletionStatus: usersTable.deletionStatus })
    .from(usersTable).where(eq(usersTable.clerkId, userId));
  return user?.deletionStatus === "pending" || user?.deletionStatus === "completed";
}

export async function assertDeletionEligibleUser(userId: string, database: any = db): Promise<void> {
  const query = database.select({ deletionStatus: usersTable.deletionStatus }).from(usersTable)
    .where(eq(usersTable.clerkId, userId));
  const [user] = await query.for("update");
  if (!user || user.deletionStatus !== "none") throw new Error("This account is pending deletion and cannot receive access.");
}

let accountWorkerRunning = false;
export function startAccountDeletionWorker(): NodeJS.Timeout {
  const run = async () => {
    if (accountWorkerRunning) return;
    accountWorkerRunning = true;
    try {
      const rows = await db.select({ clerkId: usersTable.clerkId, attempts: usersTable.clerkDeletionAttempts }).from(usersTable)
        .where(eq(usersTable.deletionStatus, "pending")).limit(50);
      for (const row of rows) {
        try {
          const result = await finalizePendingAccountDeletion(row.clerkId);
          if (result === "retryable") logger.warn({ userId: row.clerkId }, "Account deletion will be retried");
        } catch (error) {
          await db.update(usersTable).set({
            clerkDeletionStatus: "failed",
            clerkDeletionAttempts: row.attempts + 1,
            clerkDeletionLastError: error instanceof Error ? error.message : "Account deletion worker failure",
          }).where(and(eq(usersTable.clerkId, row.clerkId), eq(usersTable.deletionStatus, "pending")));
          logger.error({ userId: row.clerkId, error }, "Account deletion finalizer failed");
        }
      }
    } catch (error) {
      logger.error({ error }, "Account deletion worker pass failed");
    } finally { accountWorkerRunning = false; }
  };
  void run();
  const timer = setInterval(() => void run(), 60_000);
  timer.unref();
  return timer;
}