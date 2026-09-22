import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  adminAuditLogsTable,
  categoriesTable,
  channelMembersTable,
  channelsTable,
  communitiesTable,
  communityMembersTable,
  departmentsTable,
  db,
  employeeProfilesTable,
  locationsTable,
  moderationActionsTable,
  notificationsTable,
  serverAnnouncementsTable,
  teamsTable,
  teamMembersTable,
  userRolesTable,
  usersTable,
  workspaceInvitationsTable,
  workspacePoliciesTable,
  policyAcknowledgementsTable,
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
const workspaceRoleRank: Record<string, number> = {
  member: 0,
  moderator: 1,
  manager: 2,
  department_admin: 3,
  workspace_admin: 4,
  workspace_owner: 5,
  community_admin: 3,
  business_manager: 2,
  business_owner: 5,
};

async function requireWorkspaceManager(userId: string, communityId: number): Promise<boolean> {
  return communityPermission(userId, communityId, "manage_community");
}

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
      { key: "admin", label: "Platform Admin", scope: "platform" },
      { key: "platform_moderator", label: "Platform Moderator", scope: "platform" },
      { key: "workspace_owner", label: "Workspace Owner", scope: "assigned workspace" },
      { key: "workspace_admin", label: "Workspace Admin", scope: "assigned workspace" },
      { key: "department_admin", label: "Community / Department Admin", scope: "assigned workspace or department" },
      { key: "manager", label: "Manager", scope: "assigned workspace, department, or channel" },
      { key: "moderator", label: "Moderator", scope: "assigned workspace, department, or channel" },
      { key: "member", label: "Member", scope: "own account and participation" },
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
      await tx.insert(employeeProfilesTable).values({ communityId: created.id, userId, employmentStatus: "active", onboardedAt: new Date() });
      await tx.insert(userRolesTable).values({
        userId,
        role: "community_admin",
        scopeType: "community",
        communityId: created.id,
        grantedBy: userId,
      });
      await tx.insert(userRolesTable).values({
        userId,
        role: "workspace_owner",
        scopeType: "community",
        communityId: created.id,
        grantedBy: userId,
      });
      const [corporateCategory] = await tx.insert(categoriesTable).values({
        name: "corporate",
        description: "Company-wide communication and leadership.",
        ownerId: userId,
        communityId: created.id,
      }).returning({ id: categoriesTable.id });
      const defaultChannels = [
        ["#announcements", "Company-wide announcements and updates."],
        ["#hr", "People operations, policies, and employee support."],
        ["#management", "Leadership planning and company operations."],
      ];
      const createdChannels = await tx.insert(channelsTable).values(defaultChannels.map(([channelName, topic]) => ({
        name: channelName,
        topic,
        ownerId: userId,
        communityId: created.id,
        categoryId: corporateCategory.id,
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
  const [members, channels, categories, assignments, announcements, departments, locations, teams, employees, invitations, policies] = await Promise.all([
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
    db.select().from(departmentsTable).where(eq(departmentsTable.communityId, community.id)).orderBy(asc(departmentsTable.name)),
    db.select().from(locationsTable).where(eq(locationsTable.communityId, community.id)).orderBy(asc(locationsTable.name)),
    db.select().from(teamsTable).where(eq(teamsTable.communityId, community.id)).orderBy(asc(teamsTable.name)),
    db.select({
      communityId: employeeProfilesTable.communityId,
      userId: employeeProfilesTable.userId,
      employeeNumber: employeeProfilesTable.employeeNumber,
      jobTitle: employeeProfilesTable.jobTitle,
      employmentStatus: employeeProfilesTable.employmentStatus,
      departmentId: employeeProfilesTable.departmentId,
      locationId: employeeProfilesTable.locationId,
      managerId: employeeProfilesTable.managerId,
      onboardedAt: employeeProfilesTable.onboardedAt,
      offboardedAt: employeeProfilesTable.offboardedAt,
      username: usersTable.username,
      displayName: usersTable.displayName,
    }).from(employeeProfilesTable).innerJoin(usersTable, eq(usersTable.clerkId, employeeProfilesTable.userId))
      .where(eq(employeeProfilesTable.communityId, community.id)),
    db.select().from(workspaceInvitationsTable).where(eq(workspaceInvitationsTable.communityId, community.id)).orderBy(desc(workspaceInvitationsTable.createdAt)).limit(50),
    db.select().from(workspacePoliciesTable).where(eq(workspacePoliciesTable.communityId, community.id)).orderBy(desc(workspacePoliciesTable.createdAt)),
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
    departments,
    locations,
    teams,
    employees,
    invitations: invitations.map(({ tokenHash: _tokenHash, ...invitation }) => invitation),
    policies,
    canManage: await communityPermission(userId, community.id, "manage_community"),
  });
});

router.post("/communities/:communityId/departments", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage departments in this workspace." });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 300) : "";
  if (!name) {
    res.status(400).json({ error: "A department name is required." });
    return;
  }
  const [department] = await db.insert(departmentsTable).values({ communityId, name, description }).returning();
  await writeCommunityAudit(userId, "created_workspace_department", communityId, name);
  res.status(201).json(department);
});

router.post("/communities/:communityId/locations", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage locations in this workspace." });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  const code = typeof req.body?.code === "string" ? req.body.code.trim().slice(0, 20) : "";
  const address = typeof req.body?.address === "string" ? req.body.address.trim().slice(0, 240) : "";
  const timezone = typeof req.body?.timezone === "string" ? req.body.timezone.trim().slice(0, 80) : "America/Chicago";
  if (!name) {
    res.status(400).json({ error: "A location name is required." });
    return;
  }
  const [location] = await db.insert(locationsTable).values({ communityId, name, code, address, timezone }).returning();
  const [locationCategory] = await db.insert(categoriesTable).values({
    communityId,
    name: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `location-${location.id}`,
    description: `${name} location channels.`,
    ownerId: userId,
  }).returning({ id: categoriesTable.id });
  const locationChannels = [
    ["#general", `General conversation for ${name}.`],
    ["#managers", `Managers and supervisors at ${name}.`],
    ["#staff", `Staff conversation for ${name}.`],
  ];
  const createdChannels = await db.insert(channelsTable).values(locationChannels.map(([channelName, topic]) => ({
    communityId,
    categoryId: locationCategory.id,
    name: channelName,
    topic,
    ownerId: userId,
    isPrivate: channelName !== "#general",
  }))).returning({ id: channelsTable.id });
  if (createdChannels.length) {
    await db.insert(channelMembersTable).values(createdChannels.map((channel) => ({ channelId: channel.id, userId, role: "owner" })));
  }
  await writeCommunityAudit(userId, "created_workspace_location", communityId, name);
  res.status(201).json({ ...location, categoryId: locationCategory.id, defaultChannelsCreated: createdChannels.length });
});

router.post("/communities/:communityId/teams", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage teams in this workspace." });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 300) : "";
  const departmentId = req.body?.departmentId ? Number(req.body.departmentId) : null;
  const locationId = req.body?.locationId ? Number(req.body.locationId) : null;
  if (!name) {
    res.status(400).json({ error: "A team name is required." });
    return;
  }
  const [team] = await db.insert(teamsTable).values({ communityId, name, description, departmentId, locationId }).returning();
  await writeCommunityAudit(userId, "created_workspace_team", communityId, name);
  res.status(201).json(team);
});

router.patch("/communities/:communityId/employees/:employeeId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const employeeId = param(req, "employeeId");
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage employees in this workspace." });
    return;
  }
  const employmentStatus = typeof req.body?.employmentStatus === "string" ? req.body.employmentStatus : undefined;
  const allowedStatuses = ["invited", "onboarding", "active", "leave", "offboarding", "terminated"];
  if (employmentStatus !== undefined && !allowedStatuses.includes(employmentStatus)) {
    res.status(400).json({ error: "Invalid employee status." });
    return;
  }
  const now = new Date();
  const [updated] = await db.update(employeeProfilesTable).set({
    ...(employmentStatus === undefined ? {} : { employmentStatus }),
    ...(employmentStatus === "onboarding" ? { onboardingStartedAt: now } : {}),
    ...(employmentStatus === "active" ? { onboardedAt: now } : {}),
    ...(employmentStatus === "offboarding" ? { offboardingAt: now } : {}),
    ...(employmentStatus === "terminated" ? { offboardedAt: now } : {}),
  }).where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.userId, employeeId))).returning();
  if (!updated) {
    res.status(404).json({ error: "Employee profile not found." });
    return;
  }
  if (employmentStatus === "terminated") {
    await db.delete(teamMembersTable).where(eq(teamMembersTable.userId, employeeId));
    await db.delete(userRolesTable).where(and(eq(userRolesTable.userId, employeeId), eq(userRolesTable.communityId, communityId)));
  }
  await writeCommunityAudit(userId, "updated_employee_status", communityId, `${employeeId} → ${employmentStatus ?? "updated"}`);
  res.json(updated);
});

router.post("/communities/:communityId/invitations", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot invite employees to this workspace." });
    return;
  }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 320) : "";
  const role = typeof req.body?.role === "string" ? req.body.role.trim().slice(0, 60) : "member";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "A valid employee email is required." });
    return;
  }
  const rawToken = randomUUID();
  const [invitation] = await db.insert(workspaceInvitationsTable).values({
    communityId,
    email,
    role,
    invitedBy: userId,
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  }).returning();
  await writeCommunityAudit(userId, "invited_workspace_employee", communityId, email);
  res.status(201).json({ ...invitation, tokenHash: undefined });
});

router.post("/communities/:communityId/policies", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage policies in this workspace." });
    return;
  }
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 120) : "";
  const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 8000) : "";
  if (!title || !body) {
    res.status(400).json({ error: "A policy title and body are required." });
    return;
  }
  const [previous] = await db.select({ version: workspacePoliciesTable.version }).from(workspacePoliciesTable)
    .where(eq(workspacePoliciesTable.communityId, communityId)).orderBy(desc(workspacePoliciesTable.version)).limit(1);
  const [policy] = await db.insert(workspacePoliciesTable).values({
    communityId, title, body, version: (previous?.version ?? 0) + 1, createdBy: userId,
  }).returning();
  await writeCommunityAudit(userId, "published_workspace_policy", communityId, title);
  res.status(201).json(policy);
});

router.post("/communities/:communityId/policies/:policyId/acknowledge", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const policyId = Number(param(req, "policyId"));
  const [policy] = await db.select({ id: workspacePoliciesTable.id }).from(workspacePoliciesTable)
    .where(and(eq(workspacePoliciesTable.id, policyId), eq(workspacePoliciesTable.communityId, communityId)));
  if (!policy) {
    res.status(404).json({ error: "Policy not found." });
    return;
  }
  const [member] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
    .where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, userId)));
  if (!member) {
    res.status(403).json({ error: "You are not a workspace member." });
    return;
  }
  const [acknowledgement] = await db.insert(policyAcknowledgementsTable).values({ policyId, userId })
    .onConflictDoUpdate({ target: [policyAcknowledgementsTable.policyId, policyAcknowledgementsTable.userId], set: { acknowledgedAt: new Date() } }).returning();
  res.json(acknowledgement);
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
  if (!Number.isInteger(communityId) || !["member", "workspace_owner", "workspace_admin", "department_admin", "manager", "moderator"].includes(role)) {
    res.status(400).json({ error: "Invalid community role assignment." });
    return;
  }
  if (!(await communityPermission(userId, communityId, "manage_community_members"))) {
    res.status(403).json({ error: "You cannot manage members in this community." });
    return;
  }
  const actor = await ensureProfile(userId);
  if (actor.role !== "admin") {
    const actorAssignments = await db.select({ role: userRolesTable.role })
      .from(userRolesTable)
      .where(and(
        eq(userRolesTable.userId, userId),
        eq(userRolesTable.communityId, communityId),
      ));
    const actorRank = Math.max(0, ...actorAssignments.map((assignment) => workspaceRoleRank[assignment.role] ?? 0));
    if (actorRank <= (workspaceRoleRank[role] ?? 0)) {
      res.status(403).json({ error: "You can only assign roles below your own workspace role." });
      return;
    }
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