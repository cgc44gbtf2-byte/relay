import { and, eq, or, sql } from "drizzle-orm";
import { db, workspaceInvitationsTable } from "@workspace/db";
import type { DeliveryEvent } from "./invitation-webhook-signature";

// Terminal outcomes never regress to "delivered" if Resend retries out of order.
const priority = sql`CASE ${workspaceInvitationsTable.emailDeliveryStatus}
  WHEN 'complained' THEN 4 WHEN 'bounced' THEN 3 WHEN 'failed' THEN 2
  WHEN 'delivered' THEN 1 ELSE 0 END`;
const rank = { delivered: 1, failed: 2, bounced: 3, complained: 4 };

export async function recordDeliveryEvent(event: DeliveryEvent): Promise<void> {
  await db.update(workspaceInvitationsTable).set({
    emailProviderId: event.providerId,
    emailDeliveryStatus: event.status,
    emailDeliveryUpdatedAt: event.createdAt,
  }).where(and(
    eq(workspaceInvitationsTable.emailAttemptId, event.attemptId),
    or(sql`${workspaceInvitationsTable.emailProviderId} IS NULL`, eq(workspaceInvitationsTable.emailProviderId, event.providerId)),
    sql`(${priority} < ${rank[event.status]} OR (${priority} = ${rank[event.status]} AND ${workspaceInvitationsTable.emailDeliveryUpdatedAt} < ${event.createdAt}))`,
  ));
}

export async function finishInvitationSend(invitationId: number, attemptId: string, outcome: {
  status: "sent" | "not_configured" | "failed"; providerId?: string;
}): Promise<void> {
  // The webhook may have arrived while the POST to Resend was still pending.
  await db.update(workspaceInvitationsTable).set({
    emailDeliveryStatus: outcome.status,
    emailDeliveryUpdatedAt: new Date(),
    ...(outcome.providerId ? { emailProviderId: outcome.providerId } : {}),
  }).where(and(
    eq(workspaceInvitationsTable.id, invitationId),
    eq(workspaceInvitationsTable.emailAttemptId, attemptId),
    eq(workspaceInvitationsTable.emailDeliveryStatus, "queued"),
    ...(outcome.providerId
      ? [or(sql`${workspaceInvitationsTable.emailProviderId} IS NULL`, eq(workspaceInvitationsTable.emailProviderId, outcome.providerId))!]
      : []),
  ));
}