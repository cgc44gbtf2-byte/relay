import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, or } from "drizzle-orm";
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
import { subscriberPaidThrough } from "../lib/community-subscription";
import { wsHub } from "../lib/ws";

const router: IRouter = Router();

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
    approvedSlots: requests.filter((item) => item.status === "approved" && item.expiresAt === null).length,
    usedSlots: communities.filter((item) => item.plan === "purchased_community").length,
    subscriptionEndsAt: await subscriberPaidThrough(userId),
    pendingRequest: pending ? publicRequest(pending) : null,
    ownedCommunities: communities.filter((item) =>
      ["free_community", "purchased_community", "subscriber_community"].includes(item.plan)),
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
      // Subscription pricing is settled externally; zero means not recorded,
      // not a free purchase. Historical requests retain their original amount.
      priceCents: 0,
    }).returning();
    const body = `Public community subscription #${request.id} pending. User: ${profile.displayName} (${userId}). Verified email: ${emails[0]}. Confirm recurring payment externally and enter a paid-through date before approving.`;
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
       body: `New public community subscription request from ${profile.displayName} (${emails[0]}).`,
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
  // Reminders must remain actionable even if the active term is older than
  // the 100 most recent requests displayed in the administration panel.
  const [recent, current] = await Promise.all([
    db.select().from(communityUpgradeRequestsTable)
      .orderBy(desc(communityUpgradeRequestsTable.createdAt)).limit(100),
    db.select().from(communityUpgradeRequestsTable).where(or(
      eq(communityUpgradeRequestsTable.status, "pending"),
      and(eq(communityUpgradeRequestsTable.status, "approved"),
        gt(communityUpgradeRequestsTable.expiresAt, new Date())),
    )),
  ]);
  res.json([...new Map([...recent, ...current].map((request) => [request.id, request])).values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id));
});

async function reviewRequest(req: AuthenticatedRequest, res: import("express").Response, decision: "approved" | "declined") {
  const adminId = getUserId(req);
  await ensureProfile(adminId);
  const rawId = req.params.id;
  const id = Number(Array.isArray(rawId) ? rawId[0] : rawId);
  const paymentReference = typeof req.body?.paymentReference === "string" ? req.body.paymentReference.trim() : "";
  const paidThrough = typeof req.body?.paidThrough === "string" ? new Date(req.body.paidThrough) : new Date(NaN);
  if (!Number.isSafeInteger(id) || id < 1 || (decision === "approved"
    && (paymentReference.length < 4 || paymentReference.length > 120
      || !Number.isFinite(paidThrough.getTime()) || paidThrough <= new Date()))) {
    res.status(400).json({ error: "A verified payment reference and a future paid-through date are required." });
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
      // Serialize approval, cancellation and creation for the same subscriber.
      await tx.select({ id: usersTable.clerkId }).from(usersTable)
        .where(eq(usersTable.clerkId, request.userId)).for("update");
      const [latest] = await tx.select({ expiresAt: communityUpgradeRequestsTable.expiresAt })
        .from(communityUpgradeRequestsTable).where(and(
          eq(communityUpgradeRequestsTable.userId, request.userId),
          eq(communityUpgradeRequestsTable.status, "approved"),
          gt(communityUpgradeRequestsTable.expiresAt, new Date()),
        )).orderBy(desc(communityUpgradeRequestsTable.expiresAt)).limit(1);
      if (decision === "approved" && latest?.expiresAt && paidThrough <= latest.expiresAt) {
        return { outcome: "invalid_term" };
      }
      const [updated] = await tx.update(communityUpgradeRequestsTable)
        .set({
          status: decision,
          paymentReference: decision === "approved" ? paymentReference : null,
          expiresAt: decision === "approved" ? paidThrough : null,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        }).where(eq(communityUpgradeRequestsTable.id, id)).returning();
      const [notification] = await tx.insert(notificationsTable).values({
        userId: request.userId,
        type: "administrative_action",
        category: "administrative_action",
        body: decision === "approved"
          ? `Your public community subscription is active until ${paidThrough.toISOString()}.`
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
        details: decision === "approved" ? `Public community subscription paid through ${paidThrough.toISOString()}.` : "Public community subscription declined.",
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
  if (result.outcome === "invalid_term") {
    res.status(400).json({ error: "The new paid-through date must extend the current subscription." });
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

router.post("/admin/community-upgrades/:id/end", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const adminId = getUserId(req);
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid subscription request." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [admin] = await tx.select({ role: usersTable.role, displayName: usersTable.displayName })
      .from(usersTable).where(eq(usersTable.clerkId, adminId)).for("share");
    if (admin?.role !== "admin") return { outcome: "forbidden" } as const;
    const [request] = await tx.select().from(communityUpgradeRequestsTable)
      .where(eq(communityUpgradeRequestsTable.id, id));
    if (!request || request.expiresAt === null) return { outcome: "not_found" } as const;
    await tx.select({ id: usersTable.clerkId }).from(usersTable)
      .where(eq(usersTable.clerkId, request.userId)).for("update");
    const active = await tx.update(communityUpgradeRequestsTable).set({ status: "ended" })
      .where(and(eq(communityUpgradeRequestsTable.userId, request.userId),
        eq(communityUpgradeRequestsTable.status, "approved"),
        gt(communityUpgradeRequestsTable.expiresAt, new Date()))).returning({ id: communityUpgradeRequestsTable.id });
    if (!active.length) return { outcome: "not_found" } as const;
    await tx.insert(adminAuditLogsTable).values({
      actorId: adminId, actorDisplayName: admin.displayName,
      action: "ended_community_subscription", targetId: String(id),
      targetLabel: request.displayName,
      details: `Ended ${active.length} active subscription term(s); communities retained for renewal.`,
    });
    const [notification] = await tx.insert(notificationsTable).values({
      userId: request.userId, type: "administrative_action", category: "administrative_action",
      body: "Your public community subscription has ended. Subscriber communities are paused until renewal.",
      entityType: "community_upgrade_request", entityId: String(id), actionUrl: "/community-upgrades",
    }).returning();
    return { outcome: "ok", requesterId: request.userId, notification } as const;
  });
  if (result.outcome === "forbidden") res.status(403).json({ error: "Platform admin access required." });
  else if (result.outcome === "not_found") res.status(409).json({ error: "No active subscription to end." });
  else {
    await wsHub.revokeExpiredCommunitySubscriptions(result.requesterId);
    wsHub.broadcastUser(result.requesterId, {
      type: "notification", notification: result.notification,
    });
    res.json({ ok: true });
  }
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
    const [active] = await tx.select({ id: communityUpgradeRequestsTable.id })
      .from(communityUpgradeRequestsTable)
      .where(and(eq(communityUpgradeRequestsTable.userId, userId),
        eq(communityUpgradeRequestsTable.status, "approved"),
        gt(communityUpgradeRequestsTable.expiresAt, new Date()))).limit(1);
    const [approved] = await tx.select({ value: count() }).from(communityUpgradeRequestsTable)
      .where(and(eq(communityUpgradeRequestsTable.userId, userId), eq(communityUpgradeRequestsTable.status, "approved"),
        isNull(communityUpgradeRequestsTable.expiresAt)));
    const [used] = await tx.select({ value: count() }).from(communitiesTable)
      .where(and(eq(communitiesTable.ownerId, userId), eq(communitiesTable.plan, "purchased_community")));
    if (!active && used.value >= approved.value) return null;
    const [community] = await tx.insert(communitiesTable).values({
      name, slug: `relay-public-${randomUUID()}`, ownerId: userId,
      plan: active ? "subscriber_community" : "purchased_community", businessType: "community",
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
    res.status(403).json({ error: "No active subscription or permanent community slot is available. Request or renew an upgrade." });
    return;
  }
  res.status(201).json(result);
});

export default router;