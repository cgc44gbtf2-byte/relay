import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import {
  adminAuditLogsTable,
  categoriesTable,
  channelMembersTable,
  channelsTable,
  communitiesTable,
  communityMembersTable,
  communityUpgradeRequestsTable,
  db,
  messagesTable,
  notificationsTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";
import { ensureProfile, getUserId, requireAuth, verifiedEmailAddressesForUser, type AuthenticatedRequest } from "../lib/auth";
import { wsHub } from "../lib/ws";

const router: IRouter = Router();
const PRICE_CENTS = 1999;
const CURRENCY = "USD";

const publicRequest = (request: typeof communityUpgradeRequestsTable.$inferSelect) => ({
  id: request.id,
  status: request.status,
  createdAt: request.createdAt,
  reviewedAt: request.reviewedAt,
});

router.get("/community-upgrades/status", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  const [requests, communities] = await Promise.all([
    db.select().from(communityUpgradeRequestsTable)
      .where(eq(communityUpgradeRequestsTable.userId, userId))
      .orderBy(desc(communityUpgradeRequestsTable.createdAt)),
    db.select({ id: communitiesTable.id, name: communitiesTable.name, plan: communitiesTable.plan })
      .from(communitiesTable)
      .where(eq(communitiesTable.ownerId, userId)),
  ]);
  const pending = requests.find((item) => item.status === "pending");
  res.json({
    priceCents: PRICE_CENTS,
    currency: CURRENCY,
    approvedSlots: requests.filter((item) => item.status === "approved").length,
    usedSlots: communities.filter((item) => item.plan === "purchased_community").length,
    pendingRequest: pending ? publicRequest(pending) : null,
    ownedCommunities: communities.filter((item) =>
      item.plan === "free_community" || item.plan === "purchased_community"),
  });
});

router.post("/community-upgrades/request", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const profile = await ensureProfile(userId);
  const emails = await verifiedEmailAddressesForUser(userId);
  if (!emails.length) {
    res.status(400).json({ error: "Verify an email address on your account before requesting an upgrade." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: usersTable.clerkId }).from(usersTable)
      .where(eq(usersTable.clerkId, userId)).for("update");
    const [existing] = await tx.select().from(communityUpgradeRequestsTable)
      .where(and(eq(communityUpgradeRequestsTable.userId, userId),
        eq(communityUpgradeRequestsTable.status, "pending"))).limit(1);
    if (existing) return { request: existing, created: false } as const;
    const [admin] = await tx.select({ id: usersTable.clerkId }).from(usersTable)
      .where(eq(usersTable.role, "admin")).for("share").limit(1);
    if (!admin) return { request: null, created: false } as const;
    const [request] = await tx.insert(communityUpgradeRequestsTable).values({
      userId, email: emails[0], displayName: profile.displayName,
      priceCents: PRICE_CENTS, currency: CURRENCY,
    }).returning();
    const body = `Public community upgrade #${request.id} pending. User: ${profile.displayName} (${userId}). Verified email: ${emails[0]}. One permanent extra community: $19.99 USD. Confirm payment externally before approving in the admin console.`;
    await tx.insert(messagesTable).values({
      senderId: userId,
      recipientId: admin.id,
      threadKey: [userId, admin.id].sort().join(":"),
      body,
    });
    const [notification] = await tx.insert(notificationsTable).values({
      userId: admin.id,
      type: "direct_message",
      category: "direct_message",
      body: `New $19.99 community upgrade request from ${profile.displayName} (${emails[0]}).`,
      entityType: "community_upgrade_request",
      entityId: String(request.id),
      actionUrl: "/admin?section=upgrades",
    }).returning();
    return { request, created: true, adminId: admin.id, notification } as const;
  });
  if (!result.request) {
    res.status(503).json({ error: "Upgrade requests are unavailable until a platform administrator is assigned." });
    return;
  }
  if (result.created) {
    wsHub.broadcastUser(result.adminId, {
      type: "notification",
      notification: result.notification,
    });
  }
  res.status(result.created ? 201 : 200).json(publicRequest(result.request));
});

router.get("/admin/community-upgrades", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if ((await ensureProfile(getUserId(req))).role !== "admin") {
    res.status(403).json({ error: "Platform admin access required." });
    return;
  }
  res.json(await db.select().from(communityUpgradeRequestsTable)
    .orderBy(desc(communityUpgradeRequestsTable.createdAt)).limit(100));
});

async function reviewRequest(req: AuthenticatedRequest, res: import("express").Response, decision: "approved" | "declined") {
  const adminId = getUserId(req);
  await ensureProfile(adminId);
  const rawId = req.params.id;
  const id = Number(Array.isArray(rawId) ? rawId[0] : rawId);
  const paymentReference = typeof req.body?.paymentReference === "string" ? req.body.paymentReference.trim() : "";
  if (!Number.isSafeInteger(id) || id < 1 || (decision === "approved" && (paymentReference.length < 4 || paymentReference.length > 120))) {
    res.status(400).json({ error: "A valid request and a verified payment reference are required." });
    return;
  }
  let result: { outcome: string; request?: typeof communityUpgradeRequestsTable.$inferSelect;
    notification?: typeof notificationsTable.$inferSelect } ;
  try {
    result = await db.transaction(async (tx) => {
      const [admin] = await tx.select({ role: usersTable.role, displayName: usersTable.displayName }).from(usersTable)
        .where(eq(usersTable.clerkId, adminId)).for("share");
      if (admin?.role !== "admin") return { outcome: "forbidden" };
      const [request] = await tx.select().from(communityUpgradeRequestsTable)
        .where(eq(communityUpgradeRequestsTable.id, id)).for("update");
      if (!request || request.status !== "pending") return { outcome: "conflict" };
      const [updated] = await tx.update(communityUpgradeRequestsTable)
        .set({
          status: decision,
          paymentReference: decision === "approved" ? paymentReference : null,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        }).where(eq(communityUpgradeRequestsTable.id, id)).returning();
      const [notification] = await tx.insert(notificationsTable).values({
        userId: request.userId,
        type: "administrative_action",
        category: "administrative_action",
        body: decision === "approved"
          ? "Your community upgrade is approved. You can now create one additional public community."
          : "Your community upgrade request was declined.",
        entityType: "community_upgrade_request",
        entityId: String(request.id),
        actionUrl: "/community-upgrades",
      }).returning();
      await tx.insert(adminAuditLogsTable).values({
        actorId: adminId,
        actorDisplayName: admin.displayName,
        action: decision === "approved" ? "approved_community_upgrade" : "declined_community_upgrade",
        targetId: String(request.id),
        targetLabel: request.displayName,
        details: `One $19.99 USD permanent public-community slot ${decision}.`,
      });
      return { outcome: "ok", request: updated, notification };
    });
  } catch (error) {
    const cause = typeof error === "object" && error !== null && "cause" in error ? error.cause : error;
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505") {
      res.status(409).json({ error: "That payment reference has already been used." });
      return;
    }
    throw error;
  }
  if (result.outcome === "forbidden") {
    res.status(403).json({ error: "Platform admin access required." });
    return;
  }
  if (result.outcome !== "ok" || !result.request || !result.notification) {
    res.status(409).json({ error: "This request is no longer pending." });
    return;
  }
  wsHub.broadcastUser(result.request.userId, {
    type: "notification", notification: result.notification,
  });
  res.json(result.request);
}

router.post("/admin/community-upgrades/:id/approve", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  await reviewRequest(req, res, "approved");
});
router.post("/admin/community-upgrades/:id/decline", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  await reviewRequest(req, res, "declined");
});

router.post("/public-communities", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  if (!name) {
    res.status(400).json({ error: "A community name is required." });
    return;
  }
  await ensureProfile(userId);
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: usersTable.clerkId }).from(usersTable)
      .where(eq(usersTable.clerkId, userId)).for("update");
    const [approved] = await tx.select({ value: count() }).from(communityUpgradeRequestsTable)
      .where(and(eq(communityUpgradeRequestsTable.userId, userId), eq(communityUpgradeRequestsTable.status, "approved")));
    const [used] = await tx.select({ value: count() }).from(communitiesTable)
      .where(and(eq(communitiesTable.ownerId, userId), eq(communitiesTable.plan, "purchased_community")));
    if (used.value >= approved.value) return null;
    const [community] = await tx.insert(communitiesTable).values({
      name, slug: `relay-public-${randomUUID()}`, ownerId: userId,
      plan: "purchased_community", businessType: "community",
      isPrivate: false, onboardingStep: 9,
    }).returning();
    await tx.insert(communityMembersTable).values({ communityId: community.id, userId, status: "owner" });
    await tx.insert(userRolesTable).values({
      userId, role: "community_admin", scopeType: "community",
      communityId: community.id, grantedBy: userId,
    });
    const [category] = await tx.insert(categoriesTable).values({
      name: "community", description: "Shared rooms for the community.",
      ownerId: userId, communityId: community.id,
    }).returning({ id: categoriesTable.id });
    const channels = await tx.insert(channelsTable).values(["#welcome", "#general"].map((channelName) => ({
      name: channelName, ownerId: userId, communityId: community.id,
      categoryId: category.id, isPrivate: false,
    }))).returning({ id: channelsTable.id });
    await tx.insert(channelMembersTable).values(channels.map((channel) => ({
      channelId: channel.id, userId, role: "owner",
    })));
    return community;
  });
  if (!result) {
    res.status(403).json({ error: "No paid community slot is available. Request another upgrade." });
    return;
  }
  res.status(201).json(result);
});

export default router;