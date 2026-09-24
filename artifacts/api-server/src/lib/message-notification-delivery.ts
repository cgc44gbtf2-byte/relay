import { and, asc, eq, inArray, lte } from "drizzle-orm";
import {
  channelMembersTable,
  db,
  messagesTable,
} from "@workspace/db";
import { broadcastNotifications, insertNotifications } from "./notifications";
import { logger } from "./logger";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const WORKER_INTERVAL_MS = 5_000;
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;

type CreatedNotification = Parameters<typeof broadcastNotifications>[0][number];

export type MessageNotificationDeliveryResult = {
  processed: number;
  delivered: number;
  skipped: number;
  failed: number;
};

function safeDeliveryError(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") break;
    const wrapped = current as { code?: unknown; cause?: unknown };
    if (typeof wrapped.code === "string" && /^[0-9A-Z]{5}$/.test(wrapped.code)) {
      return `sqlstate:${wrapped.code}`;
    }
    current = wrapped.cause;
  }
  return "notification_insert_failed";
}

function retryAt(attempts: number): Date {
  const delay = Math.min(
    BASE_RETRY_DELAY_MS * (2 ** Math.max(0, attempts - 1)),
    MAX_RETRY_DELAY_MS,
  );
  return new Date(Date.now() + delay);
}

async function currentChannelRecipients(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  channelId: number,
  senderId: string,
  intendedRecipientIds: string[],
): Promise<string[]> {
  const recipientIds = [...new Set(intendedRecipientIds)]
    .filter((userId) => userId !== senderId);
  if (recipientIds.length === 0) return [];

  const rows = await tx
    .select({ userId: channelMembersTable.userId })
    .from(channelMembersTable)
    .where(and(
      eq(channelMembersTable.channelId, channelId),
      inArray(channelMembersTable.userId, recipientIds),
    ));

  return rows.map((row) => row.userId);
}

export async function processMessageNotificationDeliveries(
  options: { batchSize?: number } = {},
): Promise<MessageNotificationDeliveryResult> {
  const requestedBatchSize = Number.isFinite(options.batchSize)
    ? Math.floor(options.batchSize as number)
    : DEFAULT_BATCH_SIZE;
  const batchSize = Math.max(1, Math.min(
    requestedBatchSize,
    MAX_BATCH_SIZE,
  ));
  const broadcasts: Array<{ messageId: string; notifications: CreatedNotification[] }> = [];

  const result = await db.transaction(async (tx) => {
    const claimed = await tx
      .select()
      .from(messagesTable)
      .where(and(
        eq(messagesTable.notificationStatus, "pending"),
        lte(messagesTable.notificationNextAttemptAt, new Date()),
      ))
      .orderBy(asc(messagesTable.notificationNextAttemptAt), asc(messagesTable.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    const summary: MessageNotificationDeliveryResult = {
      processed: claimed.length,
      delivered: 0,
      skipped: 0,
      failed: 0,
    };

    for (const message of claimed) {
      try {
        const created = await tx.transaction(async (savepoint) => {
          if (message.deletedAt) {
            await savepoint.update(messagesTable).set({
              notificationStatus: "skipped",
              notificationLastError: null,
            }).where(eq(messagesTable.id, message.id));
            return [];
          }

          let recipients: string[] = [];
          let type: "mention" | "direct_message";
          let body: string;

          if (message.channelId !== null) {
            recipients = await currentChannelRecipients(
              savepoint,
              message.channelId,
              message.senderId,
              message.notificationRecipientIds ?? [],
            );
            type = "mention";
            body = "You were mentioned in a channel.";
          } else if (message.recipientId && (message.notificationRecipientIds?.length ?? 0) > 0) {
            recipients = [...new Set(message.notificationRecipientIds ?? [])]
              .filter((userId) => (
                userId === message.recipientId
                && userId !== message.senderId
              ));
            type = "direct_message";
            body = "You have a new direct message.";
          } else {
            await savepoint.update(messagesTable).set({
              notificationStatus: "skipped",
              notificationLastError: null,
            }).where(eq(messagesTable.id, message.id));
            return [];
          }

          if (recipients.length === 0) {
            await savepoint.update(messagesTable).set({
              notificationStatus: "skipped",
              notificationLastError: null,
            }).where(eq(messagesTable.id, message.id));
            return [];
          }

          const notifications = await insertNotifications(savepoint, recipients, {
            type,
            category: type,
            body,
            entityType: "message",
            entityId: message.id,
          });
          await savepoint.update(messagesTable).set({
            notificationStatus: "delivered",
            notificationLastError: null,
          }).where(eq(messagesTable.id, message.id));
          return notifications;
        });

        if (created.length > 0) {
          summary.delivered++;
          broadcasts.push({ messageId: message.id, notifications: created });
        } else {
          summary.skipped++;
        }
      } catch (error) {
        const attempts = message.notificationAttempts + 1;
        const terminal = attempts >= MAX_ATTEMPTS;
        const errorCode = safeDeliveryError(error);
        await tx.update(messagesTable).set({
          notificationStatus: terminal ? "failed" : "pending",
          notificationAttempts: attempts,
          notificationNextAttemptAt: terminal ? message.notificationNextAttemptAt : retryAt(attempts),
          notificationLastError: errorCode,
        }).where(eq(messagesTable.id, message.id));
        summary.failed++;
        logger.warn(
          { messageId: message.id, errorCode, attempts, terminal },
          "Message notification delivery failed.",
        );
      }
    }

    return summary;
  });

  for (const delivery of broadcasts) {
    try {
      broadcastNotifications(delivery.notifications);
    } catch {
      logger.warn(
        { messageId: delivery.messageId },
        "Committed message notifications could not be broadcast.",
      );
    }
  }

  return result;
}

let workerRunning = false;

export function startMessageNotificationWorker(
  options: { batchSize?: number; intervalMs?: number } = {},
): NodeJS.Timeout {
  const run = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const result = await processMessageNotificationDeliveries({
        batchSize: options.batchSize,
      });
      if (result.processed > 0) {
        logger.info(result, "Message notification delivery pass completed.");
      }
    } catch (error) {
      logger.error({ errorCode: safeDeliveryError(error) }, "Message notification delivery pass failed.");
    } finally {
      workerRunning = false;
    }
  };

  void run();
  const requestedIntervalMs = Number.isFinite(options.intervalMs)
    ? options.intervalMs as number
    : WORKER_INTERVAL_MS;
  const intervalMs = Math.max(1_000, requestedIntervalMs);
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return timer;
}