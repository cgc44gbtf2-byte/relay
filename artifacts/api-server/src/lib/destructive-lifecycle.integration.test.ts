import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  communitiesTable,
  communityMembersTable,
  db,
  pool,
  usersTable,
  userRolesTable,
  teamMembersTable,
  workspaceObjectDeletionJobsTable,
} from "@workspace/db";
import { assertDeletionEligibleUser, finalizePendingAccountDeletion } from "./account-deletion";
import { exactCommunityOwner } from "./destructive-policy";
import { processObjectDeletionJobs } from "./object-cleanup";

if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
  throw new Error("Destructive lifecycle integration tests require TEST_DATABASE_URL and refuse DATABASE_URL.");
}

const suffix = `integration_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const ids = {
  owner: `test_owner_${suffix}`,
  target: `test_target_${suffix}`,
  replacement: `test_replacement_${suffix}`,
};
let communityId: number;

async function insertUser(clerkId: string, displayName = clerkId): Promise<void> {
  await db.insert(usersTable).values({
    clerkId,
    username: clerkId,
    displayName,
  });
}

describe("destructive lifecycle PostgreSQL integration", () => {
  before(async () => {
    await Promise.all(Object.values(ids).map((id) => insertUser(id)));
    const [community] = await db.insert(communitiesTable).values({
      name: `Integration ${suffix}`,
      slug: `integration-${suffix}`,
      ownerId: ids.owner,
      plan: "paid_workspace",
    }).returning({ id: communitiesTable.id });
    communityId = community.id;
    await db.insert(communityMembersTable).values([
      { communityId, userId: ids.owner, status: "owner" },
      { communityId, userId: ids.target, status: "member" },
    ]);
  });

  after(async () => {
    await db.delete(communitiesTable).where(eq(communitiesTable.id, communityId));
    await db.delete(usersTable).where(eq(usersTable.clerkId, ids.owner));
    await db.delete(usersTable).where(eq(usersTable.clerkId, ids.target));
    await db.delete(usersTable).where(eq(usersTable.clerkId, ids.replacement));
    await pool.end();
  });

  test("ownership transfer cannot race a pending account deletion into an owned workspace", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await first.query("SELECT clerk_id FROM irc_users WHERE clerk_id = $1 FOR UPDATE", [ids.target]);
      await first.query("SELECT id FROM irc_communities WHERE id = $1 FOR UPDATE", [communityId]);
      await first.query("UPDATE irc_communities SET owner_id = $1 WHERE id = $2", [ids.target, communityId]);

      await second.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const lock = second.query(
        "SELECT clerk_id FROM irc_users WHERE clerk_id = $1 FOR UPDATE",
        [ids.target],
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await first.query("COMMIT");
      let transferObserved = false;
      let serializationRejected = false;
      try {
        await lock;
        const owned = await second.query(
          "SELECT id FROM irc_communities WHERE owner_id = $1 FOR UPDATE",
          [ids.target],
        );
        transferObserved = owned.rows.length === 1;
        if (!transferObserved) {
          await second.query(
            "UPDATE irc_users SET deletion_status = 'pending', account_status = 'suspended' WHERE clerk_id = $1",
            [ids.target],
          );
        }
        await second.query("COMMIT");
      } catch (error) {
        assert.equal((error as { code?: string }).code, "40001");
        serializationRejected = true;
      }
      assert.ok(transferObserved || serializationRejected);
      assert.equal(exactCommunityOwner(ids.owner, ids.target), false);
      assert.equal(exactCommunityOwner(ids.owner, ids.owner), true);
      await second.query("ROLLBACK");

      const [target] = await db.select({ deletionStatus: usersTable.deletionStatus })
        .from(usersTable).where(eq(usersTable.clerkId, ids.target));
      assert.equal(target.deletionStatus, "none");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
      await db.update(communitiesTable).set({ ownerId: ids.owner }).where(eq(communitiesTable.id, communityId));
    }
  });

  test("pending deletion blocks membership, role, and team access creation under a row lock", async () => {
    await db.update(usersTable).set({ deletionStatus: "pending", accountStatus: "suspended" })
      .where(eq(usersTable.clerkId, ids.target));
    await assert.rejects(
      () => assertDeletionEligibleUser(ids.target),
      /pending deletion/,
    );
    const memberships = await db.select().from(communityMembersTable)
      .where(eq(communityMembersTable.userId, ids.target));
    const roles = await db.select().from(userRolesTable)
      .where(eq(userRolesTable.userId, ids.target));
    const teams = await db.select().from(teamMembersTable)
      .where(eq(teamMembersTable.userId, ids.target));
    assert.equal(memberships.length, 1);
    assert.equal(roles.length, 0);
    assert.equal(teams.length, 0);
    await db.update(usersTable).set({ deletionStatus: "none", accountStatus: "active" })
      .where(eq(usersTable.clerkId, ids.target));
  });

  test("finalization cannot complete after Clerk transient failure and is idempotent on retry/404", async () => {
    await db.update(usersTable).set({
      deletionStatus: "pending",
      accountStatus: "suspended",
      clerkDeletionStatus: "pending",
      clerkDeletionAttempts: 0,
    }).where(eq(usersTable.clerkId, ids.target));
    let calls = 0;
    const failed = await finalizePendingAccountDeletion(ids.target, {
      deleteClerkUser: async () => {
        calls++;
        throw new Error("transient Clerk outage");
      },
    });
    assert.equal(failed, "retryable");
    assert.equal(calls, 1);
    const [pending] = await db.select({
      deletionStatus: usersTable.deletionStatus,
      clerkDeletionStatus: usersTable.clerkDeletionStatus,
    }).from(usersTable).where(eq(usersTable.clerkId, ids.target));
    assert.deepEqual(pending, { deletionStatus: "pending", clerkDeletionStatus: "failed" });

    const completed = await finalizePendingAccountDeletion(ids.target, {
      deleteClerkUser: async () => {
        calls++;
      },
    });
    assert.equal(completed, "completed");
    assert.equal(calls, 2);
    const [deleted] = await db.select({
      deletionStatus: usersTable.deletionStatus,
      clerkDeletionStatus: usersTable.clerkDeletionStatus,
      displayName: usersTable.displayName,
    }).from(usersTable).where(eq(usersTable.clerkId, ids.target));
    assert.deepEqual(deleted, {
      deletionStatus: "completed",
      clerkDeletionStatus: "deleted",
      displayName: "[deleted user]",
    });
    assert.equal(await finalizePendingAccountDeletion(ids.target, {
      deleteClerkUser: async () => { throw new Error("must not retry completed deletion"); },
    }), "not_pending");

    await db.update(usersTable).set({
      deletionStatus: "pending",
      clerkDeletionStatus: "pending",
      displayName: "404 target",
    }).where(eq(usersTable.clerkId, ids.target));
    assert.equal(await finalizePendingAccountDeletion(ids.target, {
      deleteClerkUser: async () => { throw Object.assign(new Error("missing"), { status: 404 }); },
    }), "completed");
  });

  test("object deletion retries transient signed DELETE failure and eventually completes", async () => {
    const objectPath = `/objects/integration/${suffix}`;
    await db.insert(workspaceObjectDeletionJobsTable).values({ objectPath, context: "integration" });
    let attempts = 0;
    const first = await processObjectDeletionJobs(10, {
      signObjectUrl: async () => "https://storage.test/object",
      fetchImpl: async () => {
        attempts++;
        return new Response("", { status: 503 });
      },
    });
    assert.deepEqual(first, { processed: 0, failed: 1 });
    const second = await processObjectDeletionJobs(10, {
      signObjectUrl: async () => "https://storage.test/object",
      fetchImpl: async () => {
        attempts++;
        return new Response(null, { status: 204 });
      },
    });
    assert.deepEqual(second, { processed: 1, failed: 0 });
    assert.equal(attempts, 2);
    await db.delete(workspaceObjectDeletionJobsTable)
      .where(eq(workspaceObjectDeletionJobsTable.objectPath, objectPath));
  });
});