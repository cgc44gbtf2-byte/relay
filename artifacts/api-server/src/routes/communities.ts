import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  adminAuditLogsTable,
  categoriesTable,
  channelMembersTable,
  channelsTable,
  communitiesTable,
  communityMembersTable,
  db,
  moderationActionsTable,
  notificationsTable,
  serverAnnouncementsTable,
  userRolesTable,
  usersTable,
} from "@workspace/db";
import { ensureProfile, getUserId, requireAuth, type AuthenticatedRequest } from "../lib/auth";
import {
  communityForId,
  ensurePermissionCatalog,
  hasPermission,
  permissionsForUser,
  type PermissionKey,
} from "../lib/permissions";

const router: IRouter = Router();
const scopedCommunityPermissions = ["manage_community", "manage_community_members", "create_channel", "create_announcement"] as const;

async function writeCommunityAudit(actorId: string, action: string, communityId: number, details?: string): Promise<void> {
  await db.insert(adminAuditLogsTable).values({
    actorId,
    action,
    targetId: String(communityId),
    targetLabel: `community:${communityId}`,
    details,
  });
}

function param(req: AuthenticatedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

async function communityPermission(
  userId: string,
  communityId: number,
  permission: PermissionKey,
): Promise<boolean> {
  return hasPermission(userId, permission, { communityId });
}

async function canAccessBusiness(userId: string, communityId: number): Promise<boolean> {
  const [community] = await db.select({ isPrivate: communitiesTable.isPrivate })
    .from(communitiesTable)
    .where(eq(communitiesTable.id, communityId))
    .limit(1);
  const [membership] = await db.select({ userId: communityMembersTable.userId })
    .from(communityMembersTable)
    .where(and(
      eq(communityMembersTable.communityId, communityId),
      eq(communityMembersTable.userId, userId),
    ))
    .limit(1);
  return Boolean(
    membership
      || community?.isPrivate === false
      || await hasPermission(userId, "view_business", { communityId })
      || await hasPermission(userId, "manage_community", { communityId }),
  );
}

router.get("/permissions/me", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  await ensurePermissionCatalog();
  res.json(await permissionsForUser(getUserId(req)));
});

router.get("/permissions/catalog", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!(await hasPermission(getUserId(req), "manage_roles"))) {
    res.status(403).json({ error: "Role management permission required." });
    return;
  }
  res.json({
    roles: [
      { key: "admin", label: "Admin / Developer", scope: "platform" },
      { key: "moderator", label: "Moderator", scope: "platform or assigned community" },
      { key: "community_admin", label: "Community Admin", scope: "assigned community/category/channel" },
      { key: "member", label: "Member", scope: "own account and participation" },
      { key: "business_owner", label: "Business Owner", scope: "assigned business" },
      { key: "business_manager", label: "Business Manager", scope: "assigned business" },
      { key: "employee", label: "Employee", scope: "assigned channels and work" },
      { key: "contractor", label: "Contractor", scope: "assigned jobs and channels" },
    ],
    communityPermissions: scopedCommunityPermissions,
  });
});

router.get("/communities", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  const communities = await db.select().from(communitiesTable).orderBy(asc(communitiesTable.name));
  const memberships = await db.select({ communityId: communityMembersTable.communityId })
    .from(communityMembersTable)
    .where(eq(communityMembersTable.userId, userId));
  const memberIds = new Set(memberships.map((membership) => membership.communityId));
  const result = (await Promise.all(communities.map(async (community) => {
    const joined = memberIds.has(community.id);
    const canManage = await communityPermission(userId, community.id, "manage_community");
    if (
      community.isPrivate
      && !joined
      && !canManage
      && !(await hasPermission(userId, "view_business", { communityId: community.id }))
    ) return null;
    return { ...community, joined, canManage };
  }))).filter((community): community is NonNullable<typeof community> => community !== null);
  res.json(result);
});

router.post("/communities", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 500) : "";
  const rules = typeof req.body?.rules === "string" ? req.body.rules.trim().slice(0, 5000) : "";
  const businessType = typeof req.body?.businessType === "string" ? req.body.businessType.trim().slice(0, 60) : "service_business";
  const services = typeof req.body?.services === "string" ? req.body.services.trim().slice(0, 2000) : "";
  const serviceArea = typeof req.body?.serviceArea === "string" ? req.body.serviceArea.trim().slice(0, 500) : "";
  const businessHours = typeof req.body?.businessHours === "string" ? req.body.businessHours.trim().slice(0, 1000) : "";
  const contactEmail = typeof req.body?.contactEmail === "string" ? req.body.contactEmail.trim().slice(0, 320) : "";
  const contactPhone = typeof req.body?.contactPhone === "string" ? req.body.contactPhone.trim().slice(0, 40) : "";
  const isPrivate = req.body?.isPrivate === true;
  const slug = slugify(typeof req.body?.slug === "string" ? req.body.slug : name);
  if (!name || !slug) {
    res.status(400).json({ error: "A community name is required." });
    return;
  }
  try {
    const community = await db.transaction(async (tx) => {
      const [created] = await tx.insert(communitiesTable).values({
        name,
        slug,
        description,
        rules,
        businessType,
        services,
        serviceArea,
        businessHours,
        contactEmail,
        contactPhone,
        isPrivate,
        ownerId: userId,
      }).returning();
      await tx.insert(communityMembersTable).values({ communityId: created.id, userId, status: "owner" });
      await tx.insert(userRolesTable).values({
        userId,
        role: "community_admin",
        scopeType: "community",
        communityId: created.id,
        grantedBy: userId,
      });
      await tx.insert(userRolesTable).values({
        userId,
        role: "business_owner",
        scopeType: "community",
        communityId: created.id,
        grantedBy: userId,
      });
      const defaultChannels = [
        ["#general", "The main business conversation."],
        ["#leads", "New and active lead conversations."],
        ["#appointments", "Scheduling and appointment coordination."],
        ["#jobs", "Active work and job updates."],
        ["#customers", "Customer conversations and service history."],
        ["#management", "Private business operations and decisions."],
      ];
      const createdChannels = await tx.insert(channelsTable).values(defaultChannels.map(([channelName, topic]) => ({
        name: channelName,
        topic,
        ownerId: userId,
        communityId: created.id,
        isPrivate: channelName === "#management",
      }))).returning({ id: channelsTable.id });
      if (createdChannels.length) {
        await tx.insert(channelMembersTable).values(createdChannels.map((channel) => ({
          channelId: channel.id,
          userId,
          role: "owner",
        })));
      }
      return created;
    });
    await writeCommunityAudit(userId, "created_community", community.id, `Created ${community.name}`);
    res.status(201).json({ ...community, joined: true, canManage: true, defaultChannelsCreated: 6 });
  } catch {
    res.status(409).json({ error: "That community slug is already in use." });
  }
});

router.get("/communities/:communityId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const community = Number.isInteger(communityId) ? await communityForId(communityId) : null;
  if (!community) {
    res.status(404).json({ error: "Community not found." });
    return;
  }
  if (!(await canAccessBusiness(userId, community.id))) {
    res.status(404).json({ error: "Business workspace not found." });
    return;
  }
  const [members, channels, categories, assignments, announcements] = await Promise.all([
    db.select({
      id: usersTable.clerkId,
      username: usersTable.username,
      displayName: usersTable.displayName,
      status: usersTable.status,
      joinedAt: communityMembersTable.joinedAt,
    }).from(communityMembersTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
      .where(eq(communityMembersTable.communityId, community.id))
      .orderBy(asc(usersTable.displayName)),
    db.select().from(channelsTable).where(eq(channelsTable.communityId, community.id)).orderBy(asc(channelsTable.name)),
    db.select().from(categoriesTable).where(eq(categoriesTable.communityId, community.id)).orderBy(asc(categoriesTable.name)),
    db.select().from(userRolesTable).where(eq(userRolesTable.communityId, community.id)),
    db.select({
      id: serverAnnouncementsTable.id,
      body: serverAnnouncementsTable.body,
      createdAt: serverAnnouncementsTable.createdAt,
      author: usersTable.displayName,
    }).from(serverAnnouncementsTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, serverAnnouncementsTable.authorId))
      .where(eq(serverAnnouncementsTable.communityId, community.id))
      .orderBy(desc(serverAnnouncementsTable.createdAt))
      .limit(20),
  ]);
  const visibleChannels = (await Promise.all(channels.map(async (channel) => {
    if (!channel.isPrivate) return channel;
    const [member] = await db.select({ userId: communityMembersTable.userId })
      .from(communityMembersTable)
      .where(and(
        eq(communityMembersTable.communityId, community.id),
        eq(communityMembersTable.userId, userId),
      ))
      .limit(1);
    return member || await communityPermission(userId, community.id, "manage_community")
      ? channel
      : null;
  }))).filter((channel): channel is typeof channels[number] => channel !== null);
  res.json({
    community,
    members,
    channels: visibleChannels.map((channel) => ({ ...channel, passwordHash: undefined })),
    categories,
    assignments: assignments.map((assignment) => ({ ...assignment, grantedBy: undefined })),
    announcements,
    canManage: await communityPermission(userId, community.id, "manage_community"),
  });
});

router.post("/communities/:communityId/categories", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await communityPermission(userId, communityId, "manage_community"))) {
    res.status(403).json({ error: "You cannot manage categories in this community." });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim().toLowerCase() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 240) : "";
  if (!/^[a-z0-9][a-z0-9 _-]{1,39}$/.test(name)) {
    res.status(400).json({ error: "Category names must be 2–40 lowercase characters." });
    return;
  }
  const [category] = await db.insert(categoriesTable).values({ name, description, ownerId: userId, communityId }).returning();
  await writeCommunityAudit(userId, "created_community_category", communityId, name);
  res.status(201).json(category);
});

router.patch("/communities/:communityId/categories/:categoryId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const categoryId = Number(param(req, "categoryId"));
  if (!Number.isInteger(communityId) || !Number.isInteger(categoryId) || !(await hasPermission(userId, "manage_community", { communityId, categoryId }))) {
    res.status(403).json({ error: "You cannot manage categories in this community." });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim().toLowerCase() : undefined;
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 240) : undefined;
  const [updated] = await db.update(categoriesTable).set({
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  }).where(and(eq(categoriesTable.id, categoryId), eq(categoriesTable.communityId, communityId))).returning();
  if (!updated) {
    res.status(404).json({ error: "Category not found." });
    return;
  }
  await writeCommunityAudit(userId, "updated_community_category", communityId, updated.name);
  res.json(updated);
});

router.patch("/communities/:communityId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await communityPermission(userId, communityId, "manage_community"))) {
    res.status(403).json({ error: "You do not manage this community." });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : undefined;
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 500) : undefined;
  const rules = typeof req.body?.rules === "string" ? req.body.rules.trim().slice(0, 5000) : undefined;
  const businessType = typeof req.body?.businessType === "string" ? req.body.businessType.trim().slice(0, 60) : undefined;
  const services = typeof req.body?.services === "string" ? req.body.services.trim().slice(0, 2000) : undefined;
  const serviceArea = typeof req.body?.serviceArea === "string" ? req.body.serviceArea.trim().slice(0, 500) : undefined;
  const businessHours = typeof req.body?.businessHours === "string" ? req.body.businessHours.trim().slice(0, 1000) : undefined;
  const contactEmail = typeof req.body?.contactEmail === "string" ? req.body.contactEmail.trim().slice(0, 320) : undefined;
  const contactPhone = typeof req.body?.contactPhone === "string" ? req.body.contactPhone.trim().slice(0, 40) : undefined;
  const [updated] = await db.update(communitiesTable).set({
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(rules === undefined ? {} : { rules }),
    ...(businessType === undefined ? {} : { businessType }),
    ...(services === undefined ? {} : { services }),
    ...(serviceArea === undefined ? {} : { serviceArea }),
    ...(businessHours === undefined ? {} : { businessHours }),
    ...(contactEmail === undefined ? {} : { contactEmail }),
    ...(contactPhone === undefined ? {} : { contactPhone }),
    onboardingStep: 9,
  }).where(eq(communitiesTable.id, communityId)).returning();
  if (!updated) {
    res.status(404).json({ error: "Community not found." });
    return;
  }
  await writeCommunityAudit(userId, "updated_community_settings", communityId);
  res.json(updated);
});

router.post("/communities/:communityId/channels", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const name = typeof req.body?.name === "string" ? req.body.name.trim().toLowerCase() : "";
  const categoryId = req.body?.categoryId === undefined || req.body.categoryId === null || req.body.categoryId === "" ? null : Number(req.body.categoryId);
  const isPrivate = req.body?.isPrivate === true;
  if (!Number.isInteger(communityId) || !(await hasPermission(userId, "create_channel", {
    communityId,
    categoryId: categoryId ?? undefined,
  }))) {
    res.status(403).json({ error: "You cannot create channels in this community." });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "A channel name is required." });
    return;
  }
  if (categoryId !== null) {
    const [category] = await db.select({ id: categoriesTable.id }).from(categoriesTable)
      .where(and(eq(categoriesTable.id, categoryId), eq(categoriesTable.communityId, communityId)));
    if (!category) {
      res.status(400).json({ error: "Category must belong to this community." });
      return;
    }
  }
  const [channel] = await db.insert(channelsTable).values({
    name: name.startsWith("#") ? name : `#${name}`,
    topic: typeof req.body?.topic === "string" ? req.body.topic.trim().slice(0, 160) : "",
    description: typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 240) : "",
    ownerId: userId,
    communityId,
    categoryId,
    isPrivate,
  }).returning();
  await db.insert(channelMembersTable).values({ channelId: channel.id, userId, role: "owner" });
  await writeCommunityAudit(userId, "created_community_channel", communityId, channel.name);
  res.status(201).json({ ...channel, passwordHash: undefined });
});

router.patch("/communities/:communityId/members/:memberId/role", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const memberId = param(req, "memberId");
  const role = req.body?.role;
  if (!Number.isInteger(communityId) || !["member", "community_admin", "moderator", "business_owner", "business_manager", "employee", "contractor"].includes(role)) {
    res.status(400).json({ error: "Invalid community role assignment." });
    return;
  }
  if (!(await communityPermission(userId, communityId, "manage_community_members"))) {
    res.status(403).json({ error: "You cannot manage members in this community." });
    return;
  }
  if (role === "moderator" && !(await hasPermission(userId, "manage_roles"))) {
    res.status(403).json({ error: "Only platform administrators can assign moderators." });
    return;
  }
  const member = await db.query.communityMembersTable.findFirst({
    where: and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, memberId)),
  });
  if (!member) {
    res.status(404).json({ error: "Community member not found." });
    return;
  }
  await db.delete(userRolesTable).where(and(
    eq(userRolesTable.userId, memberId),
    eq(userRolesTable.communityId, communityId),
    eq(userRolesTable.scopeType, "community"),
  ));
  if (role !== "member") {
    await db.insert(userRolesTable).values({
      userId: memberId,
      role,
      scopeType: "community",
      communityId,
      grantedBy: userId,
    });
  }
  await writeCommunityAudit(userId, "changed_community_role", communityId, `${memberId} → ${role}`);
  res.json({ ok: true, userId: memberId, role, communityId });
});

router.post("/communities/:communityId/announcements", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await communityPermission(userId, communityId, "create_announcement"))) {
    res.status(403).json({ error: "You cannot announce in this community." });
    return;
  }
  const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 500) : "";
  if (!body) {
    res.status(400).json({ error: "Announcement text is required." });
    return;
  }
  const [announcement] = await db.insert(serverAnnouncementsTable).values({ authorId: userId, communityId, body }).returning();
  const recipients = await db.select({ userId: communityMembersTable.userId })
    .from(communityMembersTable)
    .where(eq(communityMembersTable.communityId, communityId));
  if (recipients.length) {
    await db.insert(notificationsTable).values(recipients.map((recipient) => ({
      userId: recipient.userId,
      type: "community_announcement",
      body,
    })));
  }
  await writeCommunityAudit(userId, "published_community_announcement", communityId, body);
  res.status(201).json(announcement);
});

router.get("/communities/:communityId/moderation-logs", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await communityPermission(userId, communityId, "view_moderation_logs"))) {
    res.status(403).json({ error: "Moderation-log access required." });
    return;
  }
  res.json(await db.select().from(moderationActionsTable)
    .where(eq(moderationActionsTable.communityId, communityId))
    .orderBy(desc(moderationActionsTable.createdAt))
    .limit(100));
});

export default router;