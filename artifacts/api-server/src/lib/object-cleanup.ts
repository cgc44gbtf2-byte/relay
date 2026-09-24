import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lt, lte, notInArray, or } from "drizzle-orm";
import { db, notificationsTable, usersTable, workspaceObjectDeletionJobsTable } from "@workspace/db";
import { signedObjectUrlForPath } from "../routes/storage";
import { logger } from "./logger";
import { broadcastNotifications, insertNotifications } from "./notifications";

const OBJECT_CLEANUP_INTERVAL_MS = 60_000;
// The DELETE attempt is bounded well below the lease so a live worker does not
// normally overlap a recovery worker. Tokens fence off late/stale completions.
const DELETE_TIMEOUT_MS = 60_000;
const CLAIM_LEASE_MS = 120_000;
const ALERT_AFTER_ATTEMPTS = 3;
const ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
let cleanupRunning = false;

/** Only job metadata crosses into operator-visible notifications. Never include
 * object paths, signed URLs, or arbitrary storage error messages. */
export async function alertFailedObjectDeletionJobs(now = new Date()): Promise<number> {
  const candidates = await db.select({ id: workspaceObjectDeletionJobsTable.id })
    .from(workspaceObjectDeletionJobsTable).where(and(
      eq(workspaceObjectDeletionJobsTable.status, "failed"),
      isNull(workspaceObjectDeletionJobsTable.alertedAt),
      or(
        lte(workspaceObjectDeletionJobsTable.createdAt, new Date(now.getTime() - ALERT_AFTER_MS)),
        gte(workspaceObjectDeletionJobsTable.attempts, ALERT_AFTER_ATTEMPTS),
      ),
    )).orderBy(asc(workspaceObjectDeletionJobsTable.createdAt), asc(workspaceObjectDeletionJobsTable.id))
    .limit(100);
  let sent = 0;
  for (const candidate of candidates) {
    // Serialize with claims/completions; the marker and notification commit together.
    const created = await db.transaction(async (tx) => {
      const [job] = await tx.select({
        id: workspaceObjectDeletionJobsTable.id,
        status: workspaceObjectDeletionJobsTable.status,
        attempts: workspaceObjectDeletionJobsTable.attempts,
        createdAt: workspaceObjectDeletionJobsTable.createdAt,
        alertedAt: workspaceObjectDeletionJobsTable.alertedAt,
      }).from(workspaceObjectDeletionJobsTable)
        .where(eq(workspaceObjectDeletionJobsTable.id, candidate.id)).for("update");
      if (!job || job.status !== "failed" || job.alertedAt ||
        (job.attempts < ALERT_AFTER_ATTEMPTS && job.createdAt > new Date(now.getTime() - ALERT_AFTER_MS))) return [];
      const [admin] = await tx.select({ id: usersTable.clerkId }).from(usersTable)
        .where(eq(usersTable.role, "admin")).limit(1);
      if (!admin) return []; // Keep eligible for a later pass when an operator exists.
      const notifications = await insertNotifications(tx, [admin.id], {
        type: "administrative_action",
        category: "administrative_action",
        body: `Storage cleanup job #${job.id} has failed ${job.attempts} times (queued ${job.createdAt.toISOString()}). Check object storage access and review this job in the deletion queue; retries continue automatically.`,
        entityType: "object_deletion_job",
        entityId: job.id,
      });
      await tx.update(workspaceObjectDeletionJobsTable).set({ alertedAt: now })
        .where(eq(workspaceObjectDeletionJobsTable.id, job.id));
      return notifications;
    });
    broadcastNotifications(created);
    if (created.length) {
      sent++;
      logger.error({ jobId: candidate.id }, "Storage cleanup job needs operator attention");
    }
  }
  return sent;
}

async function claimNextJob(excludedIds: number[]) {
  return db.transaction(async (tx) => {
    const eligible = or(
      inArray(workspaceObjectDeletionJobsTable.status, ["pending", "failed"]),
      and(
        eq(workspaceObjectDeletionJobsTable.status, "processing"),
        lt(workspaceObjectDeletionJobsTable.leaseExpiresAt, new Date()),
      ),
    );
    const [candidate] = await tx.select().from(workspaceObjectDeletionJobsTable)
      .where(excludedIds.length
        ? and(eligible, notInArray(workspaceObjectDeletionJobsTable.id, excludedIds))
        : eligible)
      .orderBy(asc(workspaceObjectDeletionJobsTable.createdAt), asc(workspaceObjectDeletionJobsTable.id))
      .limit(1).for("update", { skipLocked: true });
    if (!candidate) return null;
    const claimToken = randomUUID();
    await tx.update(workspaceObjectDeletionJobsTable).set({
      status: "processing",
      claimToken,
      leaseExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS),
      updatedAt: new Date(),
    }).where(eq(workspaceObjectDeletionJobsTable.id, candidate.id));
    return { ...candidate, claimToken };
  });
}

export async function enqueueObjectDeletionJobs(
  tx: { insert: typeof db.insert },
  paths: readonly string[],
  context: string,
): Promise<void> {
  const unique = [...new Set(paths)].filter(Boolean);
  if (!unique.length) return;
  await tx.insert(workspaceObjectDeletionJobsTable).values(unique.map((objectPath) => ({ objectPath, context })))
    .onConflictDoNothing({ target: workspaceObjectDeletionJobsTable.objectPath });
}

export async function processObjectDeletionJobs(
  limit = 50,
  dependencies: {
    signObjectUrl?: typeof signedObjectUrlForPath;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ processed: number; failed: number }> {
  const signObjectUrl = dependencies.signObjectUrl ?? signedObjectUrlForPath;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let processed = 0;
  let failed = 0;
  const seenIds: number[] = [];
  while (seenIds.length < limit) {
    const job = await claimNextJob(seenIds);
    if (!job) break;
    seenIds.push(job.id);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Object deletion timed out"));
        }, DELETE_TIMEOUT_MS);
      });
      const response = await Promise.race([
        (async () => {
          const url = await signObjectUrl(job.objectPath, "DELETE");
          return fetchImpl(url, { method: "DELETE", signal: controller.signal });
        })(),
        timedOut,
      ]);
      if (!response.ok && response.status !== 404) throw new Error(`Object storage returned ${response.status}`);
      const updated = await db.update(workspaceObjectDeletionJobsTable).set({
        status: "completed", processedAt: new Date(), updatedAt: new Date(),
        lastError: null, alertedAt: null, claimToken: null, leaseExpiresAt: null,
      }).where(and(
        eq(workspaceObjectDeletionJobsTable.id, job.id),
        eq(workspaceObjectDeletionJobsTable.status, "processing"),
        eq(workspaceObjectDeletionJobsTable.claimToken, job.claimToken),
      )).returning({ id: workspaceObjectDeletionJobsTable.id });
      if (updated.length) {
        processed++;
        // An old unread alert must not continue to appear as an active incident.
        try {
          await db.update(notificationsTable).set({ archivedAt: new Date() }).where(and(
            eq(notificationsTable.entityType, "object_deletion_job"),
            eq(notificationsTable.entityId, String(job.id)),
            isNull(notificationsTable.archivedAt),
          ));
        } catch {
          logger.error({ jobId: job.id }, "Could not archive recovered storage cleanup alert");
        }
      }
    } catch (error) {
      const updated = await db.update(workspaceObjectDeletionJobsTable).set({
        status: "failed", attempts: job.attempts + 1, updatedAt: new Date(),
        claimToken: null, leaseExpiresAt: null,
        // An exception from a signer or fetch may contain a signed URL or path.
        lastError: error instanceof Error && /^Object storage returned \d{3}$/.test(error.message)
          ? error.message : "Object deletion failed (storage request or signing error)",
      }).where(and(
        eq(workspaceObjectDeletionJobsTable.id, job.id),
        eq(workspaceObjectDeletionJobsTable.status, "processing"),
        eq(workspaceObjectDeletionJobsTable.claimToken, job.claimToken),
      )).returning({ id: workspaceObjectDeletionJobsTable.id });
      if (updated.length) failed++;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  try {
    await alertFailedObjectDeletionJobs();
  } catch {
    // Alerting must not prevent subsequent cleanup passes or alter the lease.
    logger.error("Storage cleanup alert pass failed");
  }
  return { processed, failed };
}

export function startObjectDeletionWorker(): NodeJS.Timeout {
  const run = async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      const result = await processObjectDeletionJobs();
      if (result.processed || result.failed) logger.info(result, "Object deletion cleanup pass completed");
    } catch (error) {
      logger.error({ error }, "Object deletion cleanup pass failed");
    } finally {
      cleanupRunning = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), OBJECT_CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}