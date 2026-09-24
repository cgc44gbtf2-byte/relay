import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  adminAuditLogsTable,
  categoriesTable,
  channelMembersTable,
  channelsTable,
  communitiesTable,
  customRolesTable,
  db,
  messagesTable,
  permissionDefinitionsTable,
  rolePermissionsTable,
  serverAnnouncementsTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";
import { ensureProfile, getUserId, requireAuth, type AuthenticatedRequest } from "../lib/auth";
import { createNotifications } from "../lib/notifications";
import { channelNotFoundError } from "./errors";
import { ensurePermissionCatalog, PERMISSIONS, PRIMARY_ROLES } from "../lib/permissions";
import { isPositiveSafeInteger, isValidQuery } from "../lib/validation";
import { wsHub } from "../lib/ws";

const router: IRouter = Router();
const startedAt = Date.now();
const DEFAULT_ACTIVITY_LIMIT = 20;
const MAX_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_OFFSET = 10_000;
const MAX_ACTIVITY_CURSOR_LENGTH = 256;
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

function parseActivityFilter(value: unknown): string | null {
  if (value === undefined) return "";
  if (!isValidQuery(value)) return null;
  return value.trim();
}
function parseActivityCursor(value: unknown): ActivityCursor | null | false {
  if (value === undefined) return null;
  if (
    typeof value !== "string"
    || value.length > MAX_ACTIVITY_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ActivityCursor>;
    if (
      typeof parsed.createdAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.createdAt)
      || Number(parsed.createdAt.slice(0, 4)) < 1
      || !Number.isSafeInteger(parsed.id)
      || (parsed.id ?? 0) < 1
    ) {
      return false;
    }
    const timestamp = new Date(parsed.createdAt);
    if (
      Number.isNaN(timestamp.getTime())
      || timestamp.toISOString().slice(0, 19) !== parsed.createdAt.slice(0, 19)
    ) {
      return false;
    }
    return { createdAt: parsed.createdAt, id: parsed.id! };
  } catch {
    return false;
  }
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
  const activityCursor = parseActivityCursor(req.query.activityCursor);
  if (activityCursor === false) {
    res.status(400).json({ error: "Invalid activity cursor." });
    return;
  }

  const effectiveActivityOffset = activityCursor ? 0 : activityOffset;
  const activityActor = parseActivityFilter(req.query.activityActor);
  const activityAction = parseActivityFilter(req.query.activityAction);
  if (activityActor === null || activityAction === null) {
    res.status(400).json({ error: "Activity filters must be 200 characters or fewer." });
    return;
  }
  const [
    [userStats],
    [channelCount],
    [messageCount],
    users,
    channels,
    categories,
    recentMessages,
    activity,
  ] = await Promise.all([
    db
      .select({
        users: count(),
        online: sql<number>`count(*) filter (where ${usersTable.status} = ${"online"})`,
        admins: sql<number>`count(*) filter (where ${usersTable.role} = ${"admin"})`,
      })
      .from(usersTable),
    db.select({ value: count() }).from(channelsTable),
    db.select({ value: count() }).from(messagesTable),
    db
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
      .limit(50),
    db
      .select({
        id: channelsTable.id,
        name: channelsTable.name,
        topic: channelsTable.topic,
        ownerId: channelsTable.ownerId,
        communityId: channelsTable.communityId,
        categoryId: channelsTable.categoryId,
        communityName: communitiesTable.name,
        createdAt: channelsTable.createdAt,
        memberCount: count(channelMembersTable.userId),
      })
      .from(channelsTable)
      .leftJoin(channelMembersTable, eq(channelMembersTable.channelId, channelsTable.id))
      .leftJoin(communitiesTable, eq(communitiesTable.id, channelsTable.communityId))
      .groupBy(channelsTable.id, communitiesTable.name)
      .orderBy(asc(channelsTable.name)),
    db
      .select({
        id: categoriesTable.id,
        name: categoriesTable.name,
        description: categoriesTable.description,
        communityId: categoriesTable.communityId,
        communityName: communitiesTable.name,
        communityOwnerId: communitiesTable.ownerId,
      })
      .from(categoriesTable)
      .leftJoin(communitiesTable, eq(communitiesTable.id, categoriesTable.communityId))
      .orderBy(asc(categoriesTable.name)),
    db
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
      .limit(12),
    db
      .select({
        id: adminAuditLogsTable.id,
        actorId: adminAuditLogsTable.actorId,
        action: adminAuditLogsTable.action,
        targetId: adminAuditLogsTable.targetId,
        targetLabel: adminAuditLogsTable.targetLabel,
        details: adminAuditLogsTable.details,
        createdAt: adminAuditLogsTable.createdAt,
        actor: adminAuditLogsTable.actorDisplayName,
        cursorCreatedAt: sql<string>`to_char(${adminAuditLogsTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(adminAuditLogsTable)
      .where(and(
        activityActor
          ? ilike(adminAuditLogsTable.actorDisplayName, `%${escapeLikePattern(activityActor)}%`)
          : undefined,
        activityAction
          ? ilike(adminAuditLogsTable.action, `%${escapeLikePattern(activityAction)}%`)
          : undefined,
        activityCursor
          ? sql`(${adminAuditLogsTable.createdAt}, ${adminAuditLogsTable.id}) < (${activityCursor.createdAt}::timestamptz, ${activityCursor.id})`
          : undefined,
      ))
      .orderBy(desc(adminAuditLogsTable.createdAt), desc(adminAuditLogsTable.id))
      .limit(activityLimit + 1)
      .offset(effectiveActivityOffset),
  ]);
  const hasMoreActivity = activity.length > activityLimit;
  const visibleActivity = activity
    .slice(0, activityLimit)
    .map(({ cursorCreatedAt: _cursorCreatedAt, ...entry }) => entry);
  const lastActivity = activity[Math.min(activity.length, activityLimit) - 1];
  const nextActivityCursor = hasMoreActivity && lastActivity
    ? encodeActivityCursor({ createdAt: lastActivity.cursorCreatedAt, id: lastActivity.id })
    : null;

  res.json({
    stats: {
      users: Number(userStats?.users ?? 0),
      channels: Number(channelCount?.value ?? 0),
      messages: Number(messageCount?.value ?? 0),
      online: Number(userStats?.online ?? 0),
      admins: Number(userStats?.admins ?? 0),
    },
    users,
    channels,
    categories,
    recentMessages,
    activity: visibleActivity,
    activityPagination: {
      limit: activityLimit,
      offset: effectiveActivityOffset,
      hasMore: hasMoreActivity,
      nextOffset: hasMoreActivity && !activityCursor ? activityOffset + activityLimit : null,
      nextCursor: nextActivityCursor,
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
  const recipients = await db.select({ userId: usersTable.clerkId }).from(usersTable);
  await createNotifications(recipients.map(({ userId }) => userId), {
    type: "server_announcement",
    category: "announcement",
    body,
  });
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
  const rawQuery = req.query.q;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (typeof rawQuery === "string" && !isValidQuery(rawQuery)) {
    res.status(400).json({ error: "User search must be 200 characters or fewer." });
    return;
  }
  const requestedRole = typeof req.query.role === "string" ? req.query.role : "";
  const role = req.body?.role;
  const status = req.query.status === "online" || req.query.status === "offline" ? req.query.status : "";
  const accountStatus = req.body?.accountStatus;
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

router.get("/admin/custom-roles", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await adminProfile(req))) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  await ensurePermissionCatalog();
  const [roles, links] = await Promise.all([
    db.select().from(customRolesTable).where(eq(customRolesTable.isActive, true)).orderBy(asc(customRolesTable.label)),
    db.select({ role: rolePermissionsTable.role, permission: permissionDefinitionsTable.key })
      .from(rolePermissionsTable)
      .innerJoin(permissionDefinitionsTable, eq(permissionDefinitionsTable.id, rolePermissionsTable.permissionId)),
  ]);
  res.json({
    roles: roles.map((role) => ({ ...role, permissions: links.filter((link) => link.role === role.key).map((link) => link.permission) })),
    permissions: PERMISSIONS.map((key) => ({ key })),
  });
});

router.post("/admin/custom-roles", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actor = await adminProfile(req);
  if (!actor) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  await ensurePermissionCatalog();
  const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 60) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 240) : "";
  const scopeType = req.body?.scopeType;
  const requested = Array.isArray(req.body?.permissions) ? req.body.permissions.filter((value: unknown): value is string => typeof value === "string") : [];
  const permissions = [...new Set(requested)].filter((value): value is typeof PERMISSIONS[number] => PERMISSIONS.includes(value as typeof PERMISSIONS[number]));
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  const key = `custom_${slug}`;
  if (!label || !slug || !["community", "category", "channel"].includes(scopeType) || permissions.length === 0) {
    res.status(400).json({ error: "Name, scope, and at least one valid permission are required." });
    return;
  }
  try {
  const role = req.body?.role;
    await writeAudit(actor.clerkId, actor.displayName, "created_custom_role", key, label, permissions.join(", "));
    res.status(201).json({ ...role, permissions });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    res.status(409).json({ error: "A custom role with that name already exists." });
  }
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
  const categoryId = req.body.categoryId === null
    ? null
    : isPositiveSafeInteger(req.body.categoryId)
      ? req.body.categoryId
      : undefined;
  const channelId = Number(rawId);
  const [customRole] = typeof role === "string"
    ? await db.select().from(customRolesTable).where(and(eq(customRolesTable.key, role), eq(customRolesTable.isActive, true))).limit(1)
    : [];
  const builtInRole = ["platform_moderator", "workspace_owner", "workspace_admin", "department_admin", "manager", "moderator"].includes(role);
  if (!userId || (!builtInRole && !customRole) || !["platform", "community", "category", "channel"].includes(scopeType)) {
    res.status(400).json({ error: "A valid scoped role assignment is required." });
    return;
  }
  if (customRole && customRole.scopeType !== scopeType) {
    res.status(400).json({ error: `This custom role requires a ${customRole.scopeType} scope.` });
    return;
  }
  if (scopeType === "platform" && role !== "platform_moderator") {
    res.status(400).json({ error: "Only platform moderators may have a platform scope." });
    return;
  }
  if (["workspace_owner", "workspace_admin"].includes(role) && scopeType !== "community") {
    res.status(400).json({ error: "Workspace owners and admins must have a workspace scope." });
    return;
  }
  if (role === "department_admin" && !["community", "category"].includes(scopeType)) {
    res.status(400).json({ error: "Department admins must have a workspace or department scope." });
    return;
  }
  const scopedId = scopeType === "community" ? communityId : scopeType === "category" ? categoryId : scopeType === "channel" ? channelId : null;
  if (
    (scopeType !== "platform" && !isPositiveSafeInteger(scopedId))
    || [communityId, categoryId, channelId].some((id) => id !== null && !isPositiveSafeInteger(id))
  ) {
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
  const [channel] = await db
    .select({ id: channelsTable.id, name: channelsTable.name })
    .from(channelsTable)
    .where(eq(channelsTable.id, channelId));

  const deleted = await db
    .delete(messagesTable)
    .where(eq(messagesTable.channelId, channelId))
    .returning({ id: messagesTable.id });
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
  if (!isPositiveSafeInteger(assignmentId)) {
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
  if (req.body.confirm !== true) {
    res.status(400).json({ error: "Explicit confirmation is required to clear channel history." });
    return;
  }
  const rawId = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
  const channelId = Number(rawId);
  const topic = typeof req.body.topic === "string" ? req.body.topic.trim().slice(0, 160) : undefined;
  const hasCategoryId = Object.prototype.hasOwnProperty.call(req.body, "categoryId");
  const categoryId = req.body.categoryId === null
    ? null
    : isPositiveSafeInteger(req.body.categoryId)
      ? req.body.categoryId
      : undefined;
  if (
    !Number.isInteger(channelId)
    || (topic === undefined && !hasCategoryId)
    || (hasCategoryId && categoryId === undefined)
  ) {
    res.status(400).json({ error: "A valid channel update is required." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [currentActor] = await tx.select({ role: usersTable.role })
      .from(usersTable).where(eq(usersTable.clerkId, actor.clerkId)).for("update");
    if (currentActor?.role !== "admin") return { outcome: "forbidden" } as const;
    const [channel] = await tx.select().from(channelsTable)
      .where(eq(channelsTable.id, channelId)).for("update");
    if (!channel) return { outcome: "not_found" } as const;
    if (categoryId !== null && categoryId !== undefined) {
      const [category] = await tx
        .select({ communityId: categoriesTable.communityId })
        .from(categoriesTable)
        .where(eq(categoriesTable.id, categoryId))
        .for("share");
      if (!category || category.communityId !== channel.communityId) {
        return { outcome: "wrong_workspace" } as const;
      }
    }
    const [updated] = await tx
      .update(channelsTable)
      .set({
        ...(topic === undefined ? {} : { topic }),
        ...(hasCategoryId ? { categoryId } : {}),
      })
      .where(eq(channelsTable.id, channelId))
      .returning();
    return { outcome: "updated", updated } as const;
  });
  if (result.outcome === "forbidden") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  if (result.outcome === "not_found") {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (result.outcome === "wrong_workspace") {
    res.status(400).json({ error: "The selected room must belong to the same workspace as the channel." });
    return;
  }
  const { updated } = result;

  const auditDetails = hasCategoryId
    ? categoryId === null
      ? "Moved to unassigned channels"
      : `Moved to room ${categoryId}`
    : topic || "Cleared channel topic";
  const { passwordHash: _passwordHash, ...safeChannel } = updated;
  wsHub.broadcastChannel(channelId, { type: "channel", channel: safeChannel });
  if (hasCategoryId) wsHub.broadcastChannelListChanged();
  res.json(safeChannel);
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
  const result = await db.transaction(async (tx) => {
    const [currentActor] = await tx.select({ role: usersTable.role })
      .from(usersTable).where(eq(usersTable.clerkId, actor.clerkId)).for("update");
    if (currentActor?.role !== "admin") return { outcome: "forbidden" } as const;
    const [channel] = await tx.select().from(channelsTable)
      .where(eq(channelsTable.id, channelId)).for("update");
    if (!channel) return { outcome: "not_found" } as const;
    if (categoryId !== null && categoryId !== undefined) {
      const [category] = await tx
        .select({ communityId: categoriesTable.communityId })
        .from(categoriesTable)
        .where(eq(categoriesTable.id, categoryId))
        .for("share");
      if (!category || category.communityId !== channel.communityId) {
        return { outcome: "wrong_workspace" } as const;
      }
    }
    const [updated] = await tx
      .update(channelsTable)
      .set({
        ...(topic === undefined ? {} : { topic }),
        ...(hasCategoryId ? { categoryId } : {}),
      })
      .where(eq(channelsTable.id, channelId))
      .returning();
    return { outcome: "updated", updated } as const;
  });
export default router;
type ActivityCursor = { createdAt: string; id: number };
  const visibleActivity = activity
    .slice(0, activityLimit)
    .map(({ cursorCreatedAt: _cursorCreatedAt, ...entry }) => entry);
  const nextActivityCursor = hasMoreActivity && lastActivity
    ? encodeActivityCursor({ createdAt: lastActivity.cursorCreatedAt, id: lastActivity.id })
    : null;
function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
