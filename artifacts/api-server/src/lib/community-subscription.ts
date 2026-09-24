import { and, desc, eq, gt } from "drizzle-orm";
import { communitiesTable, communityUpgradeRequestsTable, db } from "@workspace/db";

export async function subscriberPaidThrough(userId: string): Promise<Date | null> {
  const [term] = await db.select({ expiresAt: communityUpgradeRequestsTable.expiresAt })
    .from(communityUpgradeRequestsTable)
    .where(and(eq(communityUpgradeRequestsTable.userId, userId),
      eq(communityUpgradeRequestsTable.status, "approved"),
      gt(communityUpgradeRequestsTable.expiresAt, new Date())))
    .orderBy(desc(communityUpgradeRequestsTable.expiresAt)).limit(1);
  return term?.expiresAt ?? null;
}

export async function isPublicCommunityAvailable(community: Pick<typeof communitiesTable.$inferSelect, "plan" | "ownerId">): Promise<boolean> {
  return community.plan !== "subscriber_community" || Boolean(await subscriberPaidThrough(community.ownerId));
}