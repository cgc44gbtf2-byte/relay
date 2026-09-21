import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  adminAuditLogsTable,
  channelMembersTable,
  channelsTable,
  db,
  messagesTable,
  usersTable,
} from "@workspace/db";
import { ensureProfile, getUserId, requireAuth, type AuthenticatedRequest } from "../lib/auth";

const router: IRouter = Router();
const startedAt = Date.now();

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

async function adminProfile(req: AuthenticatedRequest) {
  const profile = await ensureProfile(getUserId(req));
  return profile.role === "admin" ? profile : null;
}

async function writeAudit(
  actorId: string,
  action: string,
  targetId?: string,
  targetLabel?: string,
  details?: string,
): Promise<void> {
  await db.insert(adminAuditLogsTable).values({
    actorId,
    action,
    targetId,
    targetLabel,
    details,
  });
}

router.get("/admin/status", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const profile = await ensureProfile(getUserId(req));
  const [admin] = await db
    .select({ id: usersTable.clerkId })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"))
    .limit(1);
  res.json({
    isAdmin: profile.role === "admin",
    bootstrapAvailable: !admin,
    profile: {
      id: profile.clerkId,
      username: profile.username,
      displayName: profile.displayName,
    },
  });
});

router.post("/admin/claim", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const profile = await ensureProfile(userId);
  if (profile.role === "admin") {
    res.json({ ok: true, role: "admin" });
    return;
  }
  const [admin] = await db
    .select({ id: usersTable.clerkId })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"))
    .limit(1);
  if (admin) {
    res.status(403).json({ error: "An admin account has already been claimed." });
    return;
  }
  try {
    const [updated] = await db
      .update(usersTable)
      .set({ role: "admin" })
      .where(eq(usersTable.clerkId, userId))
      .returning({ role: usersTable.role });
    await writeAudit(userId, "claimed_admin", userId, profile.displayName, "Initial admin seat claimed");
    res.json({ ok: true, role: updated?.role ?? "admin" });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(403).json({ error: "An admin account has already been claimed." });
  }
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
      action: adminAuditLogsTable.action,
      targetId: adminAuditLogsTable.targetId,
      targetLabel: adminAuditLogsTable.targetLabel,
      details: adminAuditLogsTable.details,
      createdAt: adminAuditLogsTable.createdAt,
      actor: usersTable.displayName,
    })
    .from(adminAuditLogsTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, adminAuditLogsTable.actorId))
    .orderBy(desc(adminAuditLogsTable.createdAt))
    .limit(20);
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
  });
});

router.get("/admin/users", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await adminProfile(req))) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const role = req.query.role === "admin" || req.query.role === "member" ? req.query.role : "";
  const status = req.query.status === "online" || req.query.status === "offline" ? req.query.status : "";
  const filters = [
    query
      ? or(
          ilike(usersTable.username, `%${query}%`),
          ilike(usersTable.displayName, `%${query}%`),
        )
      : undefined,
    role ? eq(usersTable.role, role) : undefined,
    status ? eq(usersTable.status, status) : undefined,
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
    })
    .from(usersTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(usersTable.createdAt))
    .limit(100);
  res.json(users);
});

router.patch("/admin/users/:userId/role", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const targetUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const role = req.body?.role;
  if (role !== "admin" && role !== "member") {
    res.status(400).json({ error: "Role must be either admin or member." });
    return;
  }
  if (targetUserId === actor.clerkId && role !== "admin") {
    res.status(400).json({ error: "You cannot remove your own admin access." });
    return;
  }
  let updated;
  try {
    [updated] = await db
      .update(usersTable)
      .set({ role })
      .where(eq(usersTable.clerkId, targetUserId))
      .returning({ id: usersTable.clerkId, role: usersTable.role });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(409).json({ error: "Only one admin account is allowed." });
    return;
  }
  if (!updated) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  await writeAudit(
    actor.clerkId,
    role === "admin" ? "promoted_user" : "demoted_user",
    updated.id,
    targetUserId,
    `Role changed to ${role}`,
  );
  res.json(updated);
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
    res.status(404).json({ error: "Channel not found." });
    return;
  }
  await writeAudit(actor.clerkId, "updated_channel_topic", String(channelId), updated.name, topic || "Cleared channel topic");
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
    res.status(404).json({ error: "Channel not found." });
    return;
  }
  const deleted = await db
    .delete(messagesTable)
    .where(eq(messagesTable.channelId, channelId))
    .returning({ id: messagesTable.id });
  await writeAudit(actor.clerkId, "cleared_channel_history", String(channelId), channel.name, `${deleted.length} messages deleted`);
  res.json({ ok: true, deleted: deleted.length });
});

export default router;