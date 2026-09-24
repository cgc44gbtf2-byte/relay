import { and, eq } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { wsHub } from "./ws";

export type NotificationCategory =
  | "direct_message"
  | "mention"
  | "task_assigned"
  | "task_updated"
  | "task_deadline"
  | "announcement"
  | "document_acknowledgement"
  | "join_request"
  | "report"
  | "administrative_action"
  | "general";

const categoryByType: Record<string, NotificationCategory> = {
  direct_message: "direct_message",
  mention: "mention",
  task_assigned: "task_assigned",
  task_updated: "task_updated",
  task_deadline: "task_deadline",
  community_announcement: "announcement",
  server_announcement: "announcement",
  document_acknowledgement: "document_acknowledgement",
  channel_join_request: "join_request",
  channel_join_approved: "join_request",
  channel_join_rejected: "join_request",
  channel_invite: "join_request",
  report: "report",
  administrative_action: "administrative_action",
};

export function categoryForNotification(type: string, category?: string | null): NotificationCategory {
  if (category && category !== "general") return category as NotificationCategory;
  return categoryByType[type] ?? "general";
}

export type NotificationInput = {
  userId: string;
  type: string;
  body: string;
  category?: NotificationCategory;
  communityId?: number | null;
  entityType?: string | null;
  entityId?: string | number | null;
  actionUrl?: string | null;
};

export async function createNotification(input: NotificationInput): Promise<void> {
  const [created] = await db.insert(notificationsTable).values({
    userId: input.userId,
    type: input.type,
    category: input.category ?? categoryForNotification(input.type),
    body: input.body,
    communityId: input.communityId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
    actionUrl: input.actionUrl ?? null,
  }).returning();
  if (created) {
    wsHub.broadcastUser(input.userId, {
      type: "notification",
      notification: { ...created, category: categoryForNotification(created.type, created.category) },
    });
  }
}

export async function createNotifications(userIds: string[], input: Omit<NotificationInput, "userId">): Promise<void> {
  broadcastNotifications(await insertNotifications(db, userIds, input));
}

type NotificationExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertNotifications(executor: NotificationExecutor, userIds: string[], input: Omit<NotificationInput, "userId">): Promise<typeof notificationsTable.$inferSelect[]> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return [];
  return executor.insert(notificationsTable).values(uniqueUserIds.map((userId) => ({
    userId,
    type: input.type,
    category: input.category ?? categoryForNotification(input.type),
    body: input.body,
    communityId: input.communityId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
    actionUrl: input.actionUrl ?? null,
  }))).returning();
}

export function broadcastNotifications(created: typeof notificationsTable.$inferSelect[]): void {
  for (const notification of created) {
    wsHub.broadcastUser(notification.userId, {
      type: "notification",
      notification: { ...notification, category: categoryForNotification(notification.type, notification.category) },
    });
  }
}

export async function hasNotificationForEntity(userId: string, type: string, entityType: string, entityId: string | number): Promise<boolean> {
  const [existing] = await db.select({ id: notificationsTable.id }).from(notificationsTable).where(and(
    eq(notificationsTable.userId, userId),
    eq(notificationsTable.type, type),
    eq(notificationsTable.entityType, entityType),
    eq(notificationsTable.entityId, String(entityId)),
  )).limit(1);
  return Boolean(existing);
}