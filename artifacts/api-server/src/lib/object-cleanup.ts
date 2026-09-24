import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, notInArray, or } from "drizzle-orm";
import { db, workspaceObjectDeletionJobsTable } from "@workspace/db";
import { signedObjectUrlForPath } from "../routes/storage";
import { logger } from "./logger";

const OBJECT_CLEANUP_INTERVAL_MS = 60_000;
// The DELETE attempt is bounded well below the lease so a live worker does not
// normally overlap a recovery worker. Tokens fence off late/stale completions.
const DELETE_TIMEOUT_MS = 60_000;
const CLAIM_LEASE_MS = 120_000;
let cleanupRunning = false;

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
        lastError: null, claimToken: null, leaseExpiresAt: null,
      }).where(and(
        eq(workspaceObjectDeletionJobsTable.id, job.id),
        eq(workspaceObjectDeletionJobsTable.status, "processing"),
        eq(workspaceObjectDeletionJobsTable.claimToken, job.claimToken),
      )).returning({ id: workspaceObjectDeletionJobsTable.id });
      if (updated.length) processed++;
    } catch (error) {
      const updated = await db.update(workspaceObjectDeletionJobsTable).set({
        status: "failed", attempts: job.attempts + 1, updatedAt: new Date(),
        claimToken: null, leaseExpiresAt: null,
        lastError: error instanceof Error ? error.message : "Unknown object deletion failure",
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