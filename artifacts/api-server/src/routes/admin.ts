import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  adminAuditLogsTable,
  categoriesTable,
  channelMembersTable,
  channelsTable,
  communitiesTable,
  db,
  messagesTable,
  notificationsTable,
  serverAnnouncementsTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";
import { ensureProfile, getUserId, requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { channelNotFoundError } from "./errors";
import { PRIMARY_ROLES } from "../lib/permissions";

const router: IRouter = Router();
const startedAt = Date.now();
const DEFAULT_ACTIVITY_LIMIT = 20;
const MAX_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_OFFSET = 10_000;

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      current.code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" &&
      current !== null &&
      "cause" in current
        ? current.cause
        : undefined;
  }
  return false;
}

function parseActivityQueryInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  minimum = 0,
): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

async function adminProfile(req: AuthenticatedRequest) {
  const profile = await ensureProfile(getUserId(req));
  return profile.role === "admin" ? profile : null;
}

async function writeAudit(
  actorId: string,
  actorDisplayName: string,
  action: string,
  targetId?: string,
  targetLabel?: string,
  details?: string,
): Promise<void> {
  await db.insert(adminAuditLogsTable).values({
    actorId,
    actorDisplayName,
    action,
    targetId,
    targetLabel,
    details,
  });
}

router.get("/admin/status", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const profile = await ensureProfile(getUserId(req));
  res.json({
    isAdmin: profile.role === "admin",
    bootstrapAvailable: false,
    profile: {
      id: profile.clerkId,
      username: profile.username,
      displayName: profile.displayName,
    },
  });
});

router.post("/admin/claim", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  await ensureProfile(getUserId(req));
  res.status(403).json({ error: "Admin access is provisioned by the platform." });
});

router.get("/admin/health", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await adminProfile(req))) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const checkedAt = new Date();
  const databaseStarted = Date.now();
  let database = "operational";
  let databaseLatencyMs = 0;
  try {
    await db.execute(sql`select 1`);
    databaseLatencyMs = Date.now() - databaseStarted;
  } catch {
    database = "degraded";
  }
  res.json({
    api: "operational",
    database,
    databaseLatencyMs,
    environment: process.env.NODE_ENV ?? "development",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checkedAt,
  });
});

router.get("/admin/overview", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await adminProfile(req))) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const activityLimit = parseActivityQueryInteger(
    req.query.activityLimit,
    DEFAULT_ACTIVITY_LIMIT,
    MAX_ACTIVITY_LIMIT,
    1,
  );
  const activityOffset = parseActivityQueryInteger(
    req.query.activityOffset,
    0,
    MAX_ACTIVITY_OFFSET,
  );
  if (activityLimit === null || activityOffset === null) {
    res.status(400).json({
      error: `activityLimit must be between 1 and ${MAX_ACTIVITY_LIMIT}, and activityOffset must be between 0 and ${MAX_ACTIVITY_OFFSET}.`,
    });
    return;
  }
  const activityActor = typeof req.query.activityActor === "string" ? req.query.activityActor.trim() : "";
  const activityAction = typeof req.query.activityAction === "string" ? req.query.activityAction.trim() : "";
  const [[userCount], [channelCount], [messageCount], [onlineCount]] = await Promise.all([
    db.select({ value: count() }).from(usersTable),
    db.select({ value: count() }).from(channelsTable),
    db.select({ value: count() }).from(messagesTable),
    db.select({ value: count() }).from(usersTable).where(eq(usersTable.status, "online")),
  ]);
  const [adminCount] = await db
    .select({ value: count() })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));
  const users = await db
    .select({
      id: usersTable.clerkId,
      username: usersTable.username,
      displayName: usersTable.displayName,
      role: usersTable.role,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      lastSeenAt: usersTable.lastSeenAt,
      accountStatus: usersTable.accountStatus,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.createdAt))
    .limit(50);
  const channels = await db
    .select({
      id: channelsTable.id,
      name: channelsTable.name,
      topic: channelsTable.topic,
      ownerId: channelsTable.ownerId,
      createdAt: channelsTable.createdAt,
      memberCount: count(channelMembersTable.userId),
    })
    .from(channelsTable)
    .leftJoin(channelMembersTable, eq(channelMembersTable.channelId, channelsTable.id))
    .groupBy(channelsTable.id)
    .orderBy(asc(channelsTable.name));
  const recentMessages = await db
    .select({
      id: messagesTable.id,
      body: messagesTable.body,
      kind: messagesTable.kind,
      createdAt: messagesTable.createdAt,
      sender: usersTable.displayName,
      channelId: messagesTable.channelId,
    })
    .from(messagesTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, messagesTable.senderId))
    .orderBy(desc(messagesTable.createdAt))
    .limit(12);
  const activity = await db
    .select({
      id: adminAuditLogsTable.id,
      actorId: adminAuditLogsTable.actorId,
      action: adminAuditLogsTable.action,
      targetId: adminAuditLogsTable.targetId,
      targetLabel: adminAuditLogsTable.targetLabel,
      details: adminAuditLogsTable.details,
      createdAt: adminAuditLogsTable.createdAt,
      actor: adminAuditLogsTable.actorDisplayName,
    })
    .from(adminAuditLogsTable)
    .where(and(
      activityActor ? ilike(adminAuditLogsTable.actorDisplayName, `%${activityActor}%`) : undefined,
      activityAction ? eq(adminAuditLogsTable.action, activityAction) : undefined,
    ))
    .orderBy(desc(adminAuditLogsTable.createdAt), desc(adminAuditLogsTable.id))
    .limit(activityLimit + 1)
    .offset(activityOffset);
  const hasMoreActivity = activity.length > activityLimit;
  if (hasMoreActivity) activity.pop();
  res.json({
    stats: {
      users: Number(userCount?.value ?? 0),
      channels: Number(channelCount?.value ?? 0),
      messages: Number(messageCount?.value ?? 0),
      online: Number(onlineCount?.value ?? 0),
      admins: Number(adminCount?.value ?? 0),
    },
    users,
    channels,
    recentMessages,
    activity,
    activityPagination: {
      limit: activityLimit,
      offset: activityOffset,
      hasMore: hasMoreActivity,
      nextOffset: hasMoreActivity ? activityOffset + activityLimit : null,
    },
  });
});

router.post("/admin/announcements", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 500) : "";
  if (!body) {
    res.status(400).json({ error: "Announcement text is required." });
    return;
  }
  const [announcement] = await db.insert(serverAnnouncementsTable).values({ authorId: actor.clerkId, body }).returning();
  const recipients = await db.select({ clerkId: usersTable.clerkId }).from(usersTable);
  if (recipients.length) {
    await db.insert(notificationsTable).values(recipients.map((user) => ({
      userId: user.clerkId,
      type: "server_announcement",
      body,
    })));
  }
  await writeAudit(
    actor.clerkId,
    actor.displayName,
    "published_server_announcement",
    String(announcement.id),
    "server announcement",
    body,
  );
  res.status(201).json(announcement);
});

router.get("/admin/users", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await adminProfile(req))) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const requestedRole = typeof req.query.role === "string" ? req.query.role : "";
  const role = PRIMARY_ROLES.includes(requestedRole as typeof PRIMARY_ROLES[number])
    ? requestedRole as typeof PRIMARY_ROLES[number]
    : "";
  const status = req.query.status === "online" || req.query.status === "offline" ? req.query.status : "";
  const accountStatus = req.query.accountStatus === "active" || req.query.accountStatus === "suspended" ? req.query.accountStatus : "";
  const filters = [
    query
      ? or(
          ilike(usersTable.username, `%${query}%`),
          ilike(usersTable.displayName, `%${query}%`),
        )
      : undefined,
    role ? eq(usersTable.role, role) : undefined,
    status ? eq(usersTable.status, status) : undefined,
      accountStatus ? eq(usersTable.accountStatus, accountStatus) : undefined,
  ].filter((filter): filter is NonNullable<typeof filter> => Boolean(filter));
  const users = await db
    .select({
      id: usersTable.clerkId,
      username: usersTable.username,
      displayName: usersTable.displayName,
      role: usersTable.role,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      lastSeenAt: usersTable.lastSeenAt,
      accountStatus: usersTable.accountStatus,
    })
    .from(usersTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(usersTable.createdAt))
    .limit(100);
  res.json(users);
});

router.patch("/admin/users/:userId/account-status", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const targetUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const accountStatus = req.body?.accountStatus;
  if (accountStatus !== "active" && accountStatus !== "suspended") {
    res.status(400).json({ error: "Account status must be active or suspended." });
    return;
  }
  if (targetUserId === actor.clerkId) {
    res.status(400).json({ error: "You cannot suspend your own account." });
    return;
  }
  const [updated] = await db
    .update(usersTable)
    .set({ accountStatus, status: accountStatus === "suspended" ? "offline" : undefined })
    .where(eq(usersTable.clerkId, targetUserId))
    .returning({
      id: usersTable.clerkId,
      accountStatus: usersTable.accountStatus,
      status: usersTable.status,
    });
  if (!updated) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  await writeAudit(
    actor.clerkId,
    actor.displayName,
    accountStatus === "suspended" ? "suspended_user" : "restored_user",
    updated.id,
    targetUserId,
    `Account status changed to ${accountStatus}`,
  );
  res.json(updated);
});

router.patch("/admin/users/:userId/role", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const targetUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const role = req.body?.role;
  if (!PRIMARY_ROLES.includes(role)) {
    res.status(400).json({ error: "Role must be one of admin, moderator, community_admin, or member." });
    return;
  }
  if (targetUserId === actor.clerkId && role !== "admin") {
    res.status(400).json({ error: "You cannot remove your own admin access." });
    return;
  }
  let updated;
  try {
    updated = await db.transaction(async (tx) => {
      const [changedUser] = await tx
        .update(usersTable)
        .set({ role })
        .where(eq(usersTable.clerkId, targetUserId))
        .returning({ id: usersTable.clerkId, role: usersTable.role });

      if (!changedUser) {
        return undefined;
      }

      await tx.insert(adminAuditLogsTable).values({
        actorId: actor.clerkId,
        actorDisplayName: actor.displayName,
        action: role === "admin" ? "promoted_user" : "demoted_user",
        targetId: changedUser.id,
        targetLabel: targetUserId,
        details: `Role changed to ${role}`,
      });

      return changedUser;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(409).json({ error: "Only one admin account is allowed." });
    return;
  }
  if (!updated) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  res.json(updated);
});

router.get("/admin/role-assignments", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await adminProfile(req))) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const assignments = await db
    .select({
      id: userRolesTable.id,
      userId: userRolesTable.userId,
      username: usersTable.username,
      displayName: usersTable.displayName,
      role: userRolesTable.role,
      scopeType: userRolesTable.scopeType,
      communityId: userRolesTable.communityId,
      communityName: communitiesTable.name,
      categoryId: userRolesTable.categoryId,
      categoryName: categoriesTable.name,
      channelId: userRolesTable.channelId,
      channelName: channelsTable.name,
      createdAt: userRolesTable.createdAt,
    })
    .from(userRolesTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, userRolesTable.userId))
    .leftJoin(communitiesTable, eq(communitiesTable.id, userRolesTable.communityId))
    .leftJoin(categoriesTable, eq(categoriesTable.id, userRolesTable.categoryId))
    .leftJoin(channelsTable, eq(channelsTable.id, userRolesTable.channelId))
    .orderBy(desc(userRolesTable.createdAt));
  res.json(assignments);
});

router.get("/admin/scope-options", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await adminProfile(req))) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const [communities, categories, channels] = await Promise.all([
    db.select({ id: communitiesTable.id, name: communitiesTable.name }).from(communitiesTable).orderBy(asc(communitiesTable.name)),
    db.select({ id: categoriesTable.id, name: categoriesTable.name, communityId: categoriesTable.communityId }).from(categoriesTable).orderBy(asc(categoriesTable.name)),
    db.select({ id: channelsTable.id, name: channelsTable.name, communityId: channelsTable.communityId, categoryId: channelsTable.categoryId }).from(channelsTable).orderBy(asc(channelsTable.name)),
  ]);
  res.json({ communities, categories, channels });
});

router.post("/admin/role-assignments", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const userId = typeof req.body?.userId === "string" ? req.body.userId : "";
  const role = req.body?.role;
  const scopeType = req.body?.scopeType;
  const communityId = req.body?.communityId === undefined || req.body.communityId === null ? null : Number(req.body.communityId);
  const categoryId = req.body?.categoryId === undefined || req.body.categoryId === null ? null : Number(req.body.categoryId);
  const channelId = req.body?.channelId === undefined || req.body.channelId === null ? null : Number(req.body.channelId);
  if (!userId || !["moderator", "community_admin", "business_owner", "business_manager", "employee", "contractor"].includes(role) || !["platform", "community", "category", "channel"].includes(scopeType)) {
    res.status(400).json({ error: "A valid scoped role assignment is required." });
    return;
  }
  if (scopeType === "platform" && role !== "moderator") {
    res.status(400).json({ error: "Only moderators may have a platform scope." });
    return;
  }
  if (role === "business_owner" && scopeType !== "community") {
    res.status(400).json({ error: "Business owners must have a business workspace scope." });
    return;
  }
  const scopedId = scopeType === "community" ? communityId : scopeType === "category" ? categoryId : scopeType === "channel" ? channelId : null;
  if (scopeType !== "platform" && !Number.isInteger(scopedId)) {
    res.status(400).json({ error: "The selected scope is required." });
    return;
  }
  if (scopeType === "platform" && (communityId !== null || categoryId !== null || channelId !== null)) {
    res.status(400).json({ error: "Platform assignments cannot include a community, category, or channel." });
    return;
  }
  if (scopeType === "community") {
    const [community] = await db.select({ id: communitiesTable.id }).from(communitiesTable).where(eq(communitiesTable.id, communityId!));
    if (!community) {
      res.status(404).json({ error: "Community not found." });
      return;
    }
  }
  if (scopeType === "category") {
    const [category] = await db.select({ id: categoriesTable.id, communityId: categoriesTable.communityId }).from(categoriesTable).where(eq(categoriesTable.id, categoryId!));
    if (!category || (communityId !== null && category.communityId !== communityId)) {
      res.status(400).json({ error: "Category does not match the selected community." });
      return;
    }
  }
  if (scopeType === "channel") {
    const [channel] = await db.select({ id: channelsTable.id, communityId: channelsTable.communityId, categoryId: channelsTable.categoryId }).from(channelsTable).where(eq(channelsTable.id, channelId!));
    if (!channel || (communityId !== null && channel.communityId !== communityId) || (categoryId !== null && channel.categoryId !== categoryId)) {
      res.status(400).json({ error: "Channel does not match the selected scope." });
      return;
    }
  }
  const target = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkId, userId) });
  if (!target) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  const [assignment] = await db.insert(userRolesTable).values({
    userId,
    role,
    scopeType,
    communityId,
    categoryId,
    channelId,
    grantedBy: actor.clerkId,
  }).returning();
  await writeAudit(actor.clerkId, actor.displayName, "granted_scoped_role", userId, target.displayName, `${role} on ${scopeType}`);
  res.status(201).json(assignment);
});

router.delete("/admin/role-assignments/:assignmentId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const assignmentId = Number(Array.isArray(req.params.assignmentId) ? req.params.assignmentId[0] : req.params.assignmentId);
  if (!Number.isInteger(assignmentId)) {
    res.status(400).json({ error: "Invalid role assignment." });
    return;
  }
  const [removed] = await db.delete(userRolesTable).where(eq(userRolesTable.id, assignmentId)).returning();
  if (!removed) {
    res.status(404).json({ error: "Role assignment not found." });
    return;
  }
  await writeAudit(actor.clerkId, actor.displayName, "revoked_scoped_role", removed.userId, removed.role, `Assignment ${assignmentId}`);
  res.json({ ok: true });
});

router.patch("/admin/channels/:channelId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const rawId = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
  const channelId = Number(rawId);
  const topic = typeof req.body.topic === "string" ? req.body.topic.trim().slice(0, 160) : undefined;
  if (!Number.isInteger(channelId) || topic === undefined) {
    res.status(400).json({ error: "A valid channel and topic are required." });
    return;
  }
  const [updated] = await db
    .update(channelsTable)
    .set({ topic })
    .where(eq(channelsTable.id, channelId))
    .returning();
  if (!updated) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  await writeAudit(actor.clerkId, actor.displayName, "updated_channel_topic", String(channelId), updated.name, topic || "Cleared channel topic");
  res.json(updated);
});

router.delete("/admin/channels/:channelId/messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  if (req.body.confirm !== true) {
    res.status(400).json({ error: "Explicit confirmation is required to clear channel history." });
    return;
  }
  const rawId = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
  const channelId = Number(rawId);
  if (!Number.isInteger(channelId)) {
    res.status(400).json({ error: "Invalid channel." });
    return;
  }
  const [channel] = await db
    .select({ id: channelsTable.id, name: channelsTable.name })
    .from(channelsTable)
    .where(eq(channelsTable.id, channelId));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const deleted = await db
    .delete(messagesTable)
    .where(eq(messagesTable.channelId, channelId))
    .returning({ id: messagesTable.id });
  await writeAudit(actor.clerkId, actor.displayName, "cleared_channel_history", String(channelId), channel.name, `${deleted.length} messages deleted`);
  res.json({ ok: true, deleted: deleted.length });
});

export default router;