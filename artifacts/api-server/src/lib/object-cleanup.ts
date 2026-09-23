import { asc, eq, inArray } from "drizzle-orm";
import { db, workspaceObjectDeletionJobsTable } from "@workspace/db";
import { signedObjectUrlForPath } from "../routes/storage";
import { logger } from "./logger";

const OBJECT_CLEANUP_INTERVAL_MS = 60_000;
let cleanupRunning = false;

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

export async function processObjectDeletionJobs(limit = 50): Promise<{ processed: number; failed: number }> {
  const jobs = await db.select().from(workspaceObjectDeletionJobsTable)
    .where(inArray(workspaceObjectDeletionJobsTable.status, ["pending", "failed"]))
    .orderBy(asc(workspaceObjectDeletionJobsTable.createdAt)).limit(limit);
  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const url = await signedObjectUrlForPath(job.objectPath, "DELETE");
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`Object storage returned ${response.status}`);
      await db.update(workspaceObjectDeletionJobsTable).set({ status: "completed", processedAt: new Date(), updatedAt: new Date(), lastError: null })
        .where(eq(workspaceObjectDeletionJobsTable.id, job.id));
      processed++;
    } catch (error) {
      failed++;
      await db.update(workspaceObjectDeletionJobsTable).set({
        status: "failed", attempts: job.attempts + 1, updatedAt: new Date(),
        lastError: error instanceof Error ? error.message : "Unknown object deletion failure",
      }).where(eq(workspaceObjectDeletionJobsTable.id, job.id));
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