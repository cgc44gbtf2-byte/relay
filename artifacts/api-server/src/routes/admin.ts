import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq } from "drizzle-orm";
import {
  channelMembersTable,
  channelsTable,
  db,
  messagesTable,
  usersTable,
} from "@workspace/db";
import { ensureProfile, getUserId, requireAuth, type AuthenticatedRequest } from "../lib/auth";

const router: IRouter = Router();

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
    res.json({ ok: true, role: updated?.role ?? "admin" });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(403).json({ error: "An admin account has already been claimed." });
  }
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
  res.json({
    stats: {
      users: Number(userCount?.value ?? 0),
      channels: Number(channelCount?.value ?? 0),
      messages: Number(messageCount?.value ?? 0),
      online: Number(onlineCount?.value ?? 0),
    },
    users,
    channels,
    recentMessages,
  });
});

router.patch("/admin/users/:userId/role", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  const targetUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const role = req.body.role === "admin" ? "admin" : "member";
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
  res.json(updated);
});

export default router;