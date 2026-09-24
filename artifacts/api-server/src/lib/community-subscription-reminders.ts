import { and, desc, eq, gt, isNull, lte, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { communityUpgradeRequestsTable, db, usersTable } from "@workspace/db";
import { broadcastNotifications, insertNotifications } from "./notifications";
import { logger } from "./logger";

const REMINDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 100;
const newerTerm = alias(communityUpgradeRequestsTable, "newer_subscription_term");
let running = false;

/** Run once, including after a restart. Only the latest live paid term for
 * each owner is eligible; permanent slots and ended terms are never selected. */
export async function sendCommunitySubscriptionReminders(now = new Date()): Promise<number> {
  const due = await db.select({
    id: communityUpgradeRequestsTable.id,
    userId: communityUpgradeRequestsTable.userId,
  }).from(communityUpgradeRequestsTable).where(and(
    eq(communityUpgradeRequestsTable.status, "approved"),
    isNull(communityUpgradeRequestsTable.reminderSentAt),
    gt(communityUpgradeRequestsTable.expiresAt, now),
    lte(communityUpgradeRequestsTable.expiresAt, new Date(now.getTime() + REMINDER_WINDOW_MS)),
    notExists(db.select({ id: newerTerm.id }).from(newerTerm).where(and(
      eq(newerTerm.userId, communityUpgradeRequestsTable.userId),
      eq(newerTerm.status, "approved"),
      gt(newerTerm.expiresAt, now),
      or(
        gt(newerTerm.expiresAt, communityUpgradeRequestsTable.expiresAt),
        and(eq(newerTerm.expiresAt, communityUpgradeRequestsTable.expiresAt), gt(newerTerm.id, communityUpgradeRequestsTable.id)),
      ),
    ))),
  )).orderBy(communityUpgradeRequestsTable.expiresAt, communityUpgradeRequestsTable.id).limit(BATCH_SIZE);

  let sent = 0;
  for (const candidate of due) {
    // Approval, cancellation and community creation lock this same owner.
    // Re-read after locking so renewal and two concurrent workers cannot send
    // a stale or duplicate alert. Notifications and the marker commit together.
    const created = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: usersTable.clerkId }).from(usersTable)
        .where(eq(usersTable.clerkId, candidate.userId)).for("update");
      if (!owner) return [];
      const checkTime = new Date(Math.max(now.getTime(), Date.now()));
      const [latest] = await tx.select().from(communityUpgradeRequestsTable).where(and(
        eq(communityUpgradeRequestsTable.userId, candidate.userId),
        eq(communityUpgradeRequestsTable.status, "approved"),
        gt(communityUpgradeRequestsTable.expiresAt, checkTime),
      )).orderBy(desc(communityUpgradeRequestsTable.expiresAt), desc(communityUpgradeRequestsTable.id)).limit(1);
      if (!latest || latest.id !== candidate.id || !latest.expiresAt ||
        latest.reminderSentAt || latest.expiresAt > new Date(checkTime.getTime() + REMINDER_WINDOW_MS)) return [];
      const [admin] = await tx.select({ id: usersTable.clerkId }).from(usersTable)
        .where(eq(usersTable.role, "admin")).limit(1);
      if (!admin) return []; // Retry when a platform administrator is available.
      const date = latest.expiresAt.toISOString();
      const notifications = [
        ...await insertNotifications(tx, [candidate.userId], {
          type: "administrative_action", category: "administrative_action",
          body: `Your public community subscription ends on ${date}. Request renewal before then to keep subscriber communities available.`,
          entityType: "community_subscription_reminder", entityId: latest.id,
          actionUrl: "/community-upgrades",
        }),
        ...await insertNotifications(tx, admin.id === candidate.userId ? [] : [admin.id], {
          type: "administrative_action", category: "administrative_action",
          body: `Public community subscription for ${latest.displayName} ends on ${date}. Confirm external renewal before access pauses.`,
          entityType: "community_subscription_reminder", entityId: latest.id,
          actionUrl: "/admin?section=upgrades",
        }),
      ];
      await tx.update(communityUpgradeRequestsTable).set({ reminderSentAt: now })
        .where(eq(communityUpgradeRequestsTable.id, latest.id));
      return notifications;
    });
    broadcastNotifications(created);
    if (created.length) sent++;
  }
  return sent;
}

export function startCommunitySubscriptionReminderWorker(): NodeJS.Timeout {
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await sendCommunitySubscriptionReminders();
      if (sent) logger.info({ sent }, "Community subscription reminders sent");
    } catch (error) {
      logger.error({ error }, "Community subscription reminder pass failed");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), REMINDER_INTERVAL_MS);
  timer.unref();
  return timer;
}