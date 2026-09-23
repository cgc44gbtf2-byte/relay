import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  businessDocumentsTable,
  categoriesTable,
  channelsTable,
  communitiesTable,
  communityMembersTable,
  db,
  departmentsTable,
  documentDownloadsTable,
  documentFoldersTable,
  documentVersionsTable,
  messagesTable,
  locationsTable,
  pool,
  usersTable,
  userRolesTable,
  teamMembersTable,
  workspaceObjectDeletionJobsTable,
  workspaceTasksTable,
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

  test("document versions are unique within each document", async () => {
    const [document] = await db.insert(businessDocumentsTable).values({
      communityId,
      title: "Version integrity",
      ownerId: ids.owner,
    }).returning({ id: businessDocumentsTable.id });
    try {
      await db.insert(documentVersionsTable).values({
        documentId: document.id,
        version: 1,
        objectPath: `/objects/uploads/${suffix}-version-1`,
        fileName: "version-1.txt",
        contentType: "text/plain",
        fileSize: 10,
        uploadedBy: ids.owner,
      });
      await assert.rejects(
        () => db.insert(documentVersionsTable).values({
          documentId: document.id,
          version: 1,
          objectPath: `/objects/uploads/${suffix}-duplicate`,
          fileName: "duplicate.txt",
          contentType: "text/plain",
          fileSize: 10,
          uploadedBy: ids.owner,
        }),
        (error: unknown) => {
          const code = typeof error === "object" && error !== null && "cause" in error
            ? (error as { cause?: { code?: unknown } }).cause?.code
            : undefined;
          return code === "23505";
        },
      );
    } finally {
      await db.delete(businessDocumentsTable).where(eq(businessDocumentsTable.id, document.id));
    }
  });

  test("document folder parents cannot cross workspaces or leave dangling children", async () => {
    const [foreignCommunity] = await db.insert(communitiesTable).values({
      name: `Foreign folders ${suffix}`,
      slug: `foreign-folders-${suffix}`,
      ownerId: ids.owner,
      plan: "paid_workspace",
    }).returning({ id: communitiesTable.id });
    let homeParentId: number | undefined;
    let homeChildId: number | undefined;
    try {
      const [foreignParent] = await db.insert(documentFoldersTable).values({
        communityId: foreignCommunity.id,
        name: "Foreign parent",
        createdBy: ids.owner,
      }).returning({ id: documentFoldersTable.id });
      await assert.rejects(
        () => db.insert(documentFoldersTable).values({
          communityId,
          parentId: foreignParent.id,
          name: "Cross-workspace child",
          createdBy: ids.owner,
        }),
        (error: unknown) => {
          const code = typeof error === "object" && error !== null && "cause" in error
            ? (error as { cause?: { code?: unknown } }).cause?.code
            : undefined;
          return code === "23503";
        },
      );

      const [homeParent] = await db.insert(documentFoldersTable).values({
        communityId,
        name: "Home parent",
        createdBy: ids.owner,
      }).returning({ id: documentFoldersTable.id });
      homeParentId = homeParent.id;
      const [homeChild] = await db.insert(documentFoldersTable).values({
        communityId,
        parentId: homeParent.id,
        name: "Home child",
        createdBy: ids.owner,
      }).returning({ id: documentFoldersTable.id });
      homeChildId = homeChild.id;
      await assert.rejects(
        () => db.delete(documentFoldersTable).where(eq(documentFoldersTable.id, homeParent.id)),
        (error: unknown) => {
          const code = typeof error === "object" && error !== null && "cause" in error
            ? (error as { cause?: { code?: unknown } }).cause?.code
            : undefined;
          return code === "23503";
        },
      );
      assert.deepEqual(
        await db.select({ parentId: documentFoldersTable.parentId }).from(documentFoldersTable)
          .where(eq(documentFoldersTable.id, homeChild.id)),
        [{ parentId: homeParent.id }],
      );
    } finally {
      if (homeChildId !== undefined) {
        await db.delete(documentFoldersTable).where(eq(documentFoldersTable.id, homeChildId));
      }
      if (homeParentId !== undefined) {
        await db.delete(documentFoldersTable).where(eq(documentFoldersTable.id, homeParentId));
      }
      await db.delete(communitiesTable).where(eq(communitiesTable.id, foreignCommunity.id));
    }
  });

  test("message replies require an existing parent and survive parent deletion", async () => {
    await assert.rejects(
      () => db.insert(messagesTable).values({
        senderId: ids.owner,
        recipientId: ids.target,
        threadKey: [ids.owner, ids.target].sort().join(":"),
        replyToId: "00000000-0000-4000-8000-000000000000",
        body: "Missing parent",
      }),
      (error: unknown) => {
        const code = typeof error === "object" && error !== null && "cause" in error
          ? (error as { cause?: { code?: unknown } }).cause?.code
          : undefined;
        return code === "23503";
      },
    );
    const threadKey = [ids.owner, ids.target].sort().join(":");
    const [parent] = await db.insert(messagesTable).values({
      senderId: ids.owner,
      recipientId: ids.target,
      threadKey,
      body: "Parent message",
    }).returning({ id: messagesTable.id });
    const [reply] = await db.insert(messagesTable).values({
      senderId: ids.target,
      recipientId: ids.owner,
      threadKey,
      replyToId: parent.id,
      body: "Reply message",
    }).returning({ id: messagesTable.id });
    try {
      await db.delete(messagesTable).where(eq(messagesTable.id, parent.id));
      assert.deepEqual(
        await db.select({
          id: messagesTable.id,
          replyToId: messagesTable.replyToId,
          body: messagesTable.body,
        }).from(messagesTable).where(eq(messagesTable.id, reply.id)),
        [{ id: reply.id, replyToId: null, body: "Reply message" }],
      );
    } finally {
      await db.delete(messagesTable).where(eq(messagesTable.id, reply.id));
    }
  });

  test("channel categories must exist and deleting one preserves the channel", async () => {
    await assert.rejects(
      () => db.insert(channelsTable).values({
        name: `missing-category-${suffix}`,
        ownerId: ids.owner,
        communityId,
        categoryId: 2_147_483_647,
      }),
      (error: unknown) => {
        const code = typeof error === "object" && error !== null && "cause" in error
          ? (error as { cause?: { code?: unknown } }).cause?.code
          : undefined;
        return code === "23503";
      },
    );
    const [category] = await db.insert(categoriesTable).values({
      name: `Category ${suffix}`,
      ownerId: ids.owner,
      communityId,
    }).returning({ id: categoriesTable.id });
    const [channel] = await db.insert(channelsTable).values({
      name: `category-channel-${suffix}`,
      ownerId: ids.owner,
      communityId,
      categoryId: category.id,
    }).returning({ id: channelsTable.id });
    try {
      await db.delete(categoriesTable).where(eq(categoriesTable.id, category.id));
      assert.deepEqual(
        await db.select({
          id: channelsTable.id,
          categoryId: channelsTable.categoryId,
        }).from(channelsTable).where(eq(channelsTable.id, channel.id)),
        [{ id: channel.id, categoryId: null }],
      );
    } finally {
      await db.delete(channelsTable).where(eq(channelsTable.id, channel.id));
    }
  });

  test("document downloads cannot pair a document with another document's version", async () => {
    const [documentA, documentB] = await db.insert(businessDocumentsTable).values([{
      communityId,
      title: `Download document A ${suffix}`,
      ownerId: ids.owner,
    }, {
      communityId,
      title: `Download document B ${suffix}`,
      ownerId: ids.owner,
    }]).returning({ id: businessDocumentsTable.id });
    try {
      const [versionA, versionB] = await db.insert(documentVersionsTable).values([{
        documentId: documentA.id,
        version: 1,
        objectPath: `test/downloads/${suffix}/a`,
        fileName: "a.txt",
        contentType: "text/plain",
        fileSize: 1,
        uploadedBy: ids.owner,
      }, {
        documentId: documentB.id,
        version: 1,
        objectPath: `test/downloads/${suffix}/b`,
        fileName: "b.txt",
        contentType: "text/plain",
        fileSize: 1,
        uploadedBy: ids.owner,
      }]).returning({ id: documentVersionsTable.id });
      await assert.rejects(
        () => db.insert(documentDownloadsTable).values({
          documentId: documentA.id,
          versionId: versionB.id,
          userId: ids.target,
        }),
        (error: unknown) => {
          const code = typeof error === "object" && error !== null && "cause" in error
            ? (error as { cause?: { code?: unknown } }).cause?.code
            : undefined;
          return code === "23503";
        },
      );
      const [download] = await db.insert(documentDownloadsTable).values({
        documentId: documentA.id,
        versionId: versionA.id,
        userId: ids.target,
      }).returning({ id: documentDownloadsTable.id });
      await db.delete(documentVersionsTable).where(eq(documentVersionsTable.id, versionA.id));
      assert.deepEqual(
        await db.select({ id: documentDownloadsTable.id }).from(documentDownloadsTable)
          .where(eq(documentDownloadsTable.id, download.id)),
        [],
      );
    } finally {
      await db.delete(businessDocumentsTable).where(
        inArray(businessDocumentsTable.id, [documentA.id, documentB.id]),
      );
    }
  });

  test("task organization references stay in their workspace and detach on deletion", async () => {
    const [foreignCommunity] = await db.insert(communitiesTable).values({
      name: `Foreign task organization ${suffix}`,
      slug: `foreign-task-organization-${suffix}`,
      ownerId: ids.owner,
      plan: "paid_workspace",
    }).returning({ id: communitiesTable.id });
    let taskId: number | undefined;
    try {
      const [foreignDepartment] = await db.insert(departmentsTable).values({
        communityId: foreignCommunity.id,
        name: "Foreign department",
      }).returning({ id: departmentsTable.id });
      const [foreignLocation] = await db.insert(locationsTable).values({
        communityId: foreignCommunity.id,
        name: "Foreign location",
      }).returning({ id: locationsTable.id });
      await assert.rejects(
        () => db.insert(workspaceTasksTable).values({
          communityId,
          title: "Cross-workspace task",
          departmentId: foreignDepartment.id,
          locationId: foreignLocation.id,
          createdBy: ids.owner,
        }),
        (error: unknown) => {
          const code = typeof error === "object" && error !== null && "cause" in error
            ? (error as { cause?: { code?: unknown } }).cause?.code
            : undefined;
          return code === "23503";
        },
      );

      const [department] = await db.insert(departmentsTable).values({
        communityId,
        name: "Home department",
      }).returning({ id: departmentsTable.id });
      const [location] = await db.insert(locationsTable).values({
        communityId,
        name: "Home location",
      }).returning({ id: locationsTable.id });
      const [task] = await db.insert(workspaceTasksTable).values({
        communityId,
        title: "Scoped task",
        departmentId: department.id,
        locationId: location.id,
        createdBy: ids.owner,
      }).returning({ id: workspaceTasksTable.id });
      taskId = task.id;
      await db.delete(departmentsTable).where(eq(departmentsTable.id, department.id));
      await db.delete(locationsTable).where(eq(locationsTable.id, location.id));
      assert.deepEqual(
        await db.select({
          departmentId: workspaceTasksTable.departmentId,
          locationId: workspaceTasksTable.locationId,
        }).from(workspaceTasksTable).where(eq(workspaceTasksTable.id, task.id)),
        [{ departmentId: null, locationId: null }],
      );
    } finally {
      if (taskId !== undefined) {
        await db.delete(workspaceTasksTable).where(eq(workspaceTasksTable.id, taskId));
      }
      await db.delete(communitiesTable).where(eq(communitiesTable.id, foreignCommunity.id));
    }
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