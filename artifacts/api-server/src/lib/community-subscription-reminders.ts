import { and, desc, eq, gt, isNull, lte, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { communityUpgradeRequestsTable, db, usersTable } from "@workspace/db";
import { verifiedEmailAddressesForUser } from "./auth";
import {
  sendCommunitySubscriptionReminderEmail,
  type CommunitySubscriptionReminderEmail,
  type InvitationEmailDelivery,
} from "./invitation-email";
import { broadcastNotifications, insertNotifications } from "./notifications";
import { logger } from "./logger";

const REMINDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 100;
const newerTerm = alias(communityUpgradeRequestsTable, "newer_subscription_term");
let running = false;

type ReminderDependencies = {
  getVerifiedEmails: (userId: string) => Promise<string[]>;
  sendEmail: (reminder: CommunitySubscriptionReminderEmail) => Promise<InvitationEmailDelivery>;
};

/** Run once, including after a restart. Only the latest live paid term for
 * each owner is eligible; permanent slots and ended terms are never selected.
 * In-app alerts and email use separate markers so either delivery can retry
 * without repeating the other. */
export async function sendCommunitySubscriptionReminders(
  now = new Date(),
  dependencies: Partial<ReminderDependencies> = {},
): Promise<number> {
  const getVerifiedEmails = dependencies.getVerifiedEmails ?? verifiedEmailAddressesForUser;
  const sendEmail = dependencies.sendEmail ?? sendCommunitySubscriptionReminderEmail;
  const emailRetryBefore = new Date(now.getTime() - REMINDER_INTERVAL_MS);
  const due = await db.select({
    id: communityUpgradeRequestsTable.id,
    userId: communityUpgradeRequestsTable.userId,
    reminderSentAt: communityUpgradeRequestsTable.reminderSentAt,
    reminderEmailAttemptedAt: communityUpgradeRequestsTable.reminderEmailAttemptedAt,
    reminderEmailSentAt: communityUpgradeRequestsTable.reminderEmailSentAt,
  }).from(communityUpgradeRequestsTable).where(and(
    eq(communityUpgradeRequestsTable.status, "approved"),
    or(
      isNull(communityUpgradeRequestsTable.reminderSentAt),
      and(
        isNull(communityUpgradeRequestsTable.reminderEmailSentAt),
        or(
          isNull(communityUpgradeRequestsTable.reminderEmailAttemptedAt),
          lte(communityUpgradeRequestsTable.reminderEmailAttemptedAt, emailRetryBefore),
        ),
      ),
    ),
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
    let verifiedEmail: string | undefined;
    const emailRetryDue = !candidate.reminderEmailSentAt
      && (!candidate.reminderEmailAttemptedAt || candidate.reminderEmailAttemptedAt <= emailRetryBefore);
    if (emailRetryDue) {
      try {
        verifiedEmail = (await getVerifiedEmails(candidate.userId))[0];
      } catch {
        logger.warn({ termId: candidate.id }, "Verified email lookup for subscription reminder failed");
      }
    }

    // Approval, cancellation and community creation lock this same owner.
    // Re-read after locking so renewal and concurrent workers cannot send a
    // stale alert or claim the same term email at the same time.
    const outcome = await db.transaction(async (tx) => {
      const [owner] = await tx.select({ id: usersTable.clerkId }).from(usersTable)
        .where(eq(usersTable.clerkId, candidate.userId)).for("update");
      if (!owner) return { notifications: [], email: null };
      const checkTime = new Date(Math.max(now.getTime(), Date.now()));
      const [latest] = await tx.select().from(communityUpgradeRequestsTable).where(and(
        eq(communityUpgradeRequestsTable.userId, candidate.userId),
        eq(communityUpgradeRequestsTable.status, "approved"),
        gt(communityUpgradeRequestsTable.expiresAt, checkTime),
      )).orderBy(desc(communityUpgradeRequestsTable.expiresAt), desc(communityUpgradeRequestsTable.id)).limit(1);
      if (!latest || latest.id !== candidate.id || !latest.expiresAt ||
        latest.expiresAt > new Date(checkTime.getTime() + REMINDER_WINDOW_MS)) {
        return { notifications: [], email: null };
      }

      let notifications: Awaited<ReturnType<typeof insertNotifications>> = [];
      if (!latest.reminderSentAt) {
        const [admin] = await tx.select({ id: usersTable.clerkId }).from(usersTable)
          .where(eq(usersTable.role, "admin")).limit(1);
        if (admin) {
          const date = latest.expiresAt.toISOString();
          notifications = [
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
        }
      }

      const retryDue = !latest.reminderEmailAttemptedAt
        || latest.reminderEmailAttemptedAt <= emailRetryBefore;
      let email: CommunitySubscriptionReminderEmail | null = null;
      if (!latest.reminderEmailSentAt && retryDue && verifiedEmail) {
        await tx.update(communityUpgradeRequestsTable).set({ reminderEmailAttemptedAt: checkTime })
          .where(eq(communityUpgradeRequestsTable.id, latest.id));
        email = { email: verifiedEmail, termId: latest.id, expiresAt: latest.expiresAt };
      }
      return { notifications, email };
    });
    broadcastNotifications(outcome.notifications);
    let delivered = outcome.notifications.length > 0;
    if (outcome.email) {
      try {
        const delivery = await sendEmail(outcome.email);
        if (delivery.status === "sent") {
          await db.update(communityUpgradeRequestsTable)
            .set({ reminderEmailSentAt: new Date() })
            .where(eq(communityUpgradeRequestsTable.id, outcome.email.termId));
          delivered = true;
        } else {
          logger.warn({ termId: outcome.email.termId, status: delivery.status },
            "Community subscription reminder email delivery failed");
        }
      } catch {
        // Keep the committed in-app alerts and retry this email on a later worker pass.
        logger.warn({ termId: outcome.email.termId }, "Community subscription reminder email delivery failed");
      }
    }
    if (delivered) sent++;
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