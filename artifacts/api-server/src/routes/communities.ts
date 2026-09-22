import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, ilike, inArray, lte, notInArray, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  adminAuditLogsTable,
  announcementAcknowledgementsTable,
  announcementAttachmentsTable,
  announcementReadReceiptsTable,
  categoriesTable,
  channelMembersTable,
  channelJoinRequestsTable,
  channelsTable,
  communitiesTable,
  communityMembersTable,
  departmentsTable,
  documentAcknowledgementsTable,
  documentDownloadsTable,
  documentFoldersTable,
  documentPermissionsTable,
  documentVersionsTable,
  businessDocumentsTable,
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
  workspaceTasksTable,
  workspaceTaskCommentsTable,
  workspaceTaskAttachmentsTable,
} from "@workspace/db";
import { signedObjectUrlForPath } from "./storage";
import {
  ensureProfile,
  getUserId,
  requireAuth,
  verifiedEmailAddressesForUser,
  type AuthenticatedRequest,
} from "../lib/auth";
import {
  communityForId,
  ensurePermissionCatalog,
  hasPermission,
  permissionsForCommunities,
  permissionsForUser,
  type PermissionKey,
} from "../lib/permissions";
import { createNotification, createNotifications } from "../lib/notifications";

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
const invitationRoles = ["member", "employee", "contractor"] as const;

async function requireWorkspaceManager(userId: string, communityId: number): Promise<boolean> {
  return communityPermission(userId, communityId, "manage_community");
}

type CommunityAuditMetadata = {
  details?: string;
  resourceType?: string;
  resourceId?: string | number;
  resourceLabel?: string;
  departmentId?: number | null;
  locationId?: number | null;
  targetId?: string;
  targetLabel?: string;
};

async function writeCommunityAudit(
  actorId: string,
  action: string,
  communityId: number,
  metadata?: string | CommunityAuditMetadata,
): Promise<void> {
  const audit = typeof metadata === "string" ? { details: metadata } : (metadata ?? {});
  const [actor] = await db.select({ displayName: usersTable.displayName })
    .from(usersTable)
    .where(eq(usersTable.clerkId, actorId))
    .limit(1);
  await db.insert(adminAuditLogsTable).values({
    actorId,
    actorDisplayName: actor?.displayName,
    communityId,
    action,
    departmentId: audit.departmentId ?? null,
    locationId: audit.locationId ?? null,
    resourceType: audit.resourceType ?? "workspace",
    resourceId: audit.resourceId === undefined ? String(communityId) : String(audit.resourceId),
    targetId: audit.targetId ?? String(communityId),
    targetLabel: audit.targetLabel ?? audit.resourceLabel ?? `community:${communityId}`,
    details: audit.details,
  });
  const managers = await db.select({ userId: userRolesTable.userId }).from(userRolesTable).where(and(
    eq(userRolesTable.communityId, communityId),
    inArray(userRolesTable.role, ["workspace_owner", "workspace_admin", "community_admin", "department_admin"]),
  ));
  await createNotifications(managers.map((manager) => manager.userId), {
    type: "administrative_action",
    category: "administrative_action",
    body: audit.details ? `${action.replaceAll("_", " ")}: ${audit.details}` : action.replaceAll("_", " "),
    communityId,
    entityType: "community",
    entityId: communityId,
    actionUrl: `/communities/${communityId}`,
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

async function announcementRecipients(announcement: typeof serverAnnouncementsTable.$inferSelect, communityId: number): Promise<Array<{ userId: string }>> {
  if (announcement.audienceType === "department" && announcement.departmentId) {
    return db.select({ userId: employeeProfilesTable.userId }).from(employeeProfilesTable)
      .where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.departmentId, announcement.departmentId)));
  }
  if (announcement.audienceType === "location" && announcement.locationId) {
    return db.select({ userId: employeeProfilesTable.userId }).from(employeeProfilesTable)
      .where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.locationId, announcement.locationId)));
  }
  if (announcement.audienceType === "team" && announcement.teamId) {
    return db.select({ userId: teamMembersTable.userId }).from(teamMembersTable)
      .innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId))
      .where(and(eq(teamsTable.communityId, communityId), eq(teamMembersTable.teamId, announcement.teamId)));
  }
  if (announcement.audienceType === "individual" && announcement.recipientId) {
    return [{ userId: announcement.recipientId }];
  }
  return db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
    .where(eq(communityMembersTable.communityId, communityId));
}

async function activateDueAnnouncements(communityId: number): Promise<void> {
  const due = await db.select().from(serverAnnouncementsTable).where(and(
    eq(serverAnnouncementsTable.communityId, communityId),
    eq(serverAnnouncementsTable.status, "scheduled"),
    lte(serverAnnouncementsTable.scheduledAt, new Date()),
  ));
  for (const announcement of due) {
    const [activated] = await db.update(serverAnnouncementsTable).set({ status: "published" })
      .where(and(eq(serverAnnouncementsTable.id, announcement.id), eq(serverAnnouncementsTable.status, "scheduled"))).returning();
    if (!activated) continue;
    const recipients = await announcementRecipients(announcement, communityId);
    await createNotifications(recipients.map((recipient) => recipient.userId), {
      type: "community_announcement",
      category: "announcement",
      body: `${announcement.title}: ${announcement.body}`,
      communityId,
      entityType: "announcement",
      entityId: announcement.id,
      actionUrl: `/communities/${communityId}`,
    });
  }
}

const documentCategories = ["policies", "procedures", "training", "forms", "employee", "company"] as const;
const documentVisibilities = ["company", "managers", "employee", "private"] as const;

async function documentForUser(documentId: number, communityId: number, userId: string) {
  const [document] = await db.select().from(businessDocumentsTable).where(and(
    eq(businessDocumentsTable.id, documentId),
    eq(businessDocumentsTable.communityId, communityId),
  ));
  if (!document) return null;
  const manager = await communityPermission(userId, communityId, "manage_community");
  const [membership] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable).where(and(
    eq(communityMembersTable.communityId, communityId),
    eq(communityMembersTable.userId, userId),
  ));
  if (!membership) return null;
  if (manager || document.visibility === "company" || (document.visibility === "employee" && document.targetUserId === userId)) return document;
  const [permission] = await db.select({ permission: documentPermissionsTable.permission }).from(documentPermissionsTable).where(and(
    eq(documentPermissionsTable.documentId, documentId),
    eq(documentPermissionsTable.userId, userId),
  ));
  return permission ? document : null;
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
  const permissionMap = await permissionsForCommunities(
    userId,
    communities.map((community) => community.id),
    ["manage_community", "view_business"],
  );
  const result = communities.map((community) => {
    const joined = memberIds.has(community.id);
    const permissions = permissionMap.get(community.id);
    const canManage = permissions?.has("manage_community") ?? false;
    if (
      community.isPrivate
      && !joined
      && !canManage
      && !(permissions?.has("view_business") ?? false)
    ) return null;
    return { ...community, joined, canManage };
  }).filter((community): community is NonNullable<typeof community> => community !== null);
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
  const isPrivate = req.body?.isPrivate !== false;
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

router.get("/communities/:communityId/tasks/:taskId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const taskId = Number(param(req, "taskId"));
  if (!Number.isInteger(communityId) || !Number.isInteger(taskId) || !(await canAccessBusiness(userId, communityId))) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  const [task] = await db.select().from(workspaceTasksTable).where(and(
    eq(workspaceTasksTable.id, taskId),
    eq(workspaceTasksTable.communityId, communityId),
  ));
  if (!task) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  const [comments, attachments] = await Promise.all([
    db.select({
      id: workspaceTaskCommentsTable.id,
      taskId: workspaceTaskCommentsTable.taskId,
      authorId: workspaceTaskCommentsTable.authorId,
      author: usersTable.displayName,
      body: workspaceTaskCommentsTable.body,
      createdAt: workspaceTaskCommentsTable.createdAt,
    }).from(workspaceTaskCommentsTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, workspaceTaskCommentsTable.authorId))
      .where(eq(workspaceTaskCommentsTable.taskId, taskId))
      .orderBy(asc(workspaceTaskCommentsTable.createdAt)),
    db.select().from(workspaceTaskAttachmentsTable)
      .where(eq(workspaceTaskAttachmentsTable.taskId, taskId))
      .orderBy(asc(workspaceTaskAttachmentsTable.createdAt)),
  ]);
  res.json({ ...task, comments, attachments });
});

router.get("/communities/:communityId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const summaryView = req.query.view === "summary";
  const community = Number.isInteger(communityId) ? await communityForId(communityId) : null;
  if (!community) {
    res.status(404).json({ error: "Community not found." });
    return;
  }
  if (!(await canAccessBusiness(userId, community.id))) {
    res.status(404).json({ error: "Business workspace not found." });
    return;
  }
  await activateDueAnnouncements(community.id);
  const taskCommentsQuery = summaryView
    ? Promise.resolve([] as Array<{
      id: number;
      taskId: number;
      authorId: string;
      author: string;
      body: string;
      createdAt: Date;
    }>)
    : db.select({
      id: workspaceTaskCommentsTable.id,
      taskId: workspaceTaskCommentsTable.taskId,
      authorId: workspaceTaskCommentsTable.authorId,
      author: usersTable.displayName,
      body: workspaceTaskCommentsTable.body,
      createdAt: workspaceTaskCommentsTable.createdAt,
    }).from(workspaceTaskCommentsTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, workspaceTaskCommentsTable.authorId))
      .innerJoin(workspaceTasksTable, eq(workspaceTasksTable.id, workspaceTaskCommentsTable.taskId))
      .where(eq(workspaceTasksTable.communityId, community.id))
      .orderBy(asc(workspaceTaskCommentsTable.createdAt));
  const taskAttachmentsQuery = summaryView
    ? Promise.resolve([] as Array<{
      id: number;
      taskId: number;
      uploaderId: string;
      objectPath: string;
      fileName: string;
      contentType: string;
      fileSize: number;
      createdAt: Date;
    }>)
    : db.select({
      id: workspaceTaskAttachmentsTable.id,
      taskId: workspaceTaskAttachmentsTable.taskId,
      uploaderId: workspaceTaskAttachmentsTable.uploaderId,
      objectPath: workspaceTaskAttachmentsTable.objectPath,
      fileName: workspaceTaskAttachmentsTable.fileName,
      contentType: workspaceTaskAttachmentsTable.contentType,
      fileSize: workspaceTaskAttachmentsTable.fileSize,
      createdAt: workspaceTaskAttachmentsTable.createdAt,
    }).from(workspaceTaskAttachmentsTable)
      .innerJoin(workspaceTasksTable, eq(workspaceTasksTable.id, workspaceTaskAttachmentsTable.taskId))
      .where(eq(workspaceTasksTable.communityId, community.id));
  const [members, channels, categories, assignments, announcements, departments, locations, teams, employees, invitations, policies, tasks, taskComments, taskAttachments, teamMemberships, announcementReceipts, announcementAcks, announcementAttachments] = await Promise.all([
    db.select({
      id: usersTable.clerkId,
      username: usersTable.username,
      displayName: usersTable.displayName,
      presenceStatus: usersTable.status,
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
      title: serverAnnouncementsTable.title,
      body: serverAnnouncementsTable.body,
      audienceType: serverAnnouncementsTable.audienceType,
      departmentId: serverAnnouncementsTable.departmentId,
      locationId: serverAnnouncementsTable.locationId,
      teamId: serverAnnouncementsTable.teamId,
      recipientId: serverAnnouncementsTable.recipientId,
      requiresAcknowledgement: serverAnnouncementsTable.requiresAcknowledgement,
      scheduledAt: serverAnnouncementsTable.scheduledAt,
      expiresAt: serverAnnouncementsTable.expiresAt,
      status: serverAnnouncementsTable.status,
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
    db.select().from(workspaceTasksTable).where(eq(workspaceTasksTable.communityId, community.id)).orderBy(desc(workspaceTasksTable.updatedAt)),
    taskCommentsQuery,
    taskAttachmentsQuery,
    db.select({ teamId: teamMembersTable.teamId, userId: teamMembersTable.userId }).from(teamMembersTable)
      .innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId))
      .where(eq(teamsTable.communityId, community.id)),
    db.select({
      announcementId: announcementReadReceiptsTable.announcementId,
      userId: announcementReadReceiptsTable.userId,
      readAt: announcementReadReceiptsTable.readAt,
    }).from(announcementReadReceiptsTable)
      .innerJoin(serverAnnouncementsTable, eq(serverAnnouncementsTable.id, announcementReadReceiptsTable.announcementId))
      .where(eq(serverAnnouncementsTable.communityId, community.id)),
    db.select({
      announcementId: announcementAcknowledgementsTable.announcementId,
      userId: announcementAcknowledgementsTable.userId,
      acknowledgedAt: announcementAcknowledgementsTable.acknowledgedAt,
    }).from(announcementAcknowledgementsTable)
      .innerJoin(serverAnnouncementsTable, eq(serverAnnouncementsTable.id, announcementAcknowledgementsTable.announcementId))
      .where(eq(serverAnnouncementsTable.communityId, community.id)),
    db.select().from(announcementAttachmentsTable)
      .innerJoin(serverAnnouncementsTable, eq(serverAnnouncementsTable.id, announcementAttachmentsTable.announcementId))
      .where(eq(serverAnnouncementsTable.communityId, community.id)),
  ]);
  const canManage = await communityPermission(userId, community.id, "manage_community");
  const viewerIsMember = members.some((member) => member.id === userId);
  const visibleChannels = channels.filter((channel) => !channel.isPrivate || viewerIsMember || canManage);
  const employeeProfilesByUserId = new Map(employees.map((employee) => [employee.userId, employee]));
  const directoryEmployees = members.map((member) => {
    const profile = employeeProfilesByUserId.get(member.id);
    return {
      userId: member.id,
      username: member.username,
      displayName: member.displayName,
      employeeNumber: profile?.employeeNumber ?? "",
      jobTitle: profile?.jobTitle ?? "",
      employmentStatus: profile?.employmentStatus ?? "active",
      departmentId: profile?.departmentId ?? null,
      locationId: profile?.locationId ?? null,
      managerId: profile?.managerId ?? null,
      onboardedAt: profile?.onboardedAt ?? null,
      offboardedAt: profile?.offboardedAt ?? null,
      presenceStatus: member.status,
    };
  });
  const currentEmployee = employees.find((employee) => employee.userId === userId);
  const now = new Date();
  const visibleAnnouncements = announcements.filter((announcement) => canManage
    || (
      announcement.status === "published"
      && (!announcement.scheduledAt || announcement.scheduledAt <= now)
      && (!announcement.expiresAt || announcement.expiresAt > now)
      && (
        announcement.audienceType === "company"
        || (announcement.audienceType === "department" && announcement.departmentId === currentEmployee?.departmentId)
        || (announcement.audienceType === "location" && announcement.locationId === currentEmployee?.locationId)
        || (announcement.audienceType === "team" && teamMemberships.some((item) => item.teamId === announcement.teamId && item.userId === userId))
        || (announcement.audienceType === "individual" && announcement.recipientId === userId)
      )
    ));
  res.json({
    community,
    members,
    channels: visibleChannels.map((channel) => ({ ...channel, passwordHash: undefined })),
    categories,
    assignments: assignments.map((assignment) => ({ ...assignment, grantedBy: undefined })),
    announcements: visibleAnnouncements.map((announcement) => ({
      ...announcement,
      readAt: announcementReceipts.find((receipt) => receipt.announcementId === announcement.id && receipt.userId === userId)?.readAt ?? null,
      acknowledgedAt: announcementAcks.find((ack) => ack.announcementId === announcement.id && ack.userId === userId)?.acknowledgedAt ?? null,
      readCount: announcementReceipts.filter((receipt) => receipt.announcementId === announcement.id).length,
      acknowledgementCount: announcementAcks.filter((ack) => ack.announcementId === announcement.id).length,
      attachments: announcementAttachments
        .map(({ irc_announcement_attachments: attachment }) => attachment)
        .filter((attachment) => attachment.announcementId === announcement.id),
    })),
    departments,
    locations,
    teams,
    employees: directoryEmployees,
    invitations: invitations.map(({ tokenHash: _tokenHash, ...invitation }) => invitation),
    policies,
    tasks: tasks.map((task) => ({
      ...task,
      comments: taskComments.filter((comment) => comment.taskId === task.id),
      attachments: taskAttachments.filter((attachment) => attachment.taskId === task.id),
    })),
    canManage,
  });
});

router.get("/communities/:communityId/dashboard", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await communityPermission(userId, communityId, "manage_community"))) {
    res.status(403).json({ error: "Workspace manager permission required." });
    return;
  }
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const [members, channels, tasks, announcements, pendingRequests, activity] = await Promise.all([
    db.select({ userId: communityMembersTable.userId, status: usersTable.status }).from(communityMembersTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
      .where(eq(communityMembersTable.communityId, communityId)),
    db.select({ id: channelsTable.id }).from(channelsTable).where(eq(channelsTable.communityId, communityId)),
    db.select().from(workspaceTasksTable).where(eq(workspaceTasksTable.communityId, communityId)),
    db.select({ status: serverAnnouncementsTable.status, scheduledAt: serverAnnouncementsTable.scheduledAt, expiresAt: serverAnnouncementsTable.expiresAt })
      .from(serverAnnouncementsTable).where(eq(serverAnnouncementsTable.communityId, communityId)),
    db.select({ id: channelJoinRequestsTable.id }).from(channelJoinRequestsTable)
      .innerJoin(channelsTable, eq(channelsTable.id, channelJoinRequestsTable.channelId))
      .where(and(eq(channelsTable.communityId, communityId), eq(channelJoinRequestsTable.status, "pending"))),
    db.select({
      id: adminAuditLogsTable.id,
      action: adminAuditLogsTable.action,
      details: adminAuditLogsTable.details,
      actor: adminAuditLogsTable.actorDisplayName,
      createdAt: adminAuditLogsTable.createdAt,
    }).from(adminAuditLogsTable)
      .where(or(
        eq(adminAuditLogsTable.communityId, communityId),
        and(
          eq(adminAuditLogsTable.targetId, String(communityId)),
          eq(adminAuditLogsTable.targetLabel, `community:${communityId}`),
        ),
      ))
      .orderBy(desc(adminAuditLogsTable.createdAt), desc(adminAuditLogsTable.id))
      .limit(12),
  ]);
  const openTasks = tasks.filter((task) => !["completed", "cancelled"].includes(task.status));
  const dueThisWeek = openTasks.filter((task) => task.dueDate && task.dueDate >= now && task.dueDate <= weekAhead);
  const overdue = openTasks.filter((task) => task.dueDate && task.dueDate < now);
  const currentAnnouncements = announcements.filter((announcement) => announcement.status === "published"
    && (!announcement.scheduledAt || announcement.scheduledAt <= now)
    && (!announcement.expiresAt || announcement.expiresAt > now));
  res.json({
    stats: {
      employees: members.length,
      online: members.filter((member) => member.status === "online").length,
      channels: channels.length,
      openTasks: openTasks.length,
      announcements: currentAnnouncements.length,
      pendingRequests: pendingRequests.length,
    },
    tasks: {
      open: openTasks.length,
      dueThisWeek: dueThisWeek.length,
      overdue: overdue.length,
    },
    recentActivity: activity,
  });
});

router.get("/communities/:communityId/activity", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "Workspace manager permission required." });
    return;
  }

  const actorId = typeof req.query.userId === "string" && req.query.userId.trim() ? req.query.userId.trim() : null;
  const departmentId = typeof req.query.departmentId === "string" && req.query.departmentId.trim() ? Number(req.query.departmentId) : null;
  const locationId = typeof req.query.locationId === "string" && req.query.locationId.trim() ? Number(req.query.locationId) : null;
  const action = typeof req.query.action === "string" && req.query.action.trim() ? req.query.action.trim() : null;
  const resource = typeof req.query.resource === "string" && req.query.resource.trim() ? req.query.resource.trim().slice(0, 120) : null;
  const from = typeof req.query.from === "string" && req.query.from.trim() ? new Date(`${req.query.from}T00:00:00.000Z`) : null;
  const to = typeof req.query.to === "string" && req.query.to.trim() ? new Date(`${req.query.to}T23:59:59.999Z`) : null;
  if (
    (departmentId !== null && !Number.isInteger(departmentId))
    || (locationId !== null && !Number.isInteger(locationId))
    || (from && Number.isNaN(from.getTime()))
    || (to && Number.isNaN(to.getTime()))
  ) {
    res.status(400).json({ error: "Invalid activity filter." });
    return;
  }
  const workspaceScope = or(
    eq(adminAuditLogsTable.communityId, communityId),
    and(
      eq(adminAuditLogsTable.targetId, String(communityId)),
      eq(adminAuditLogsTable.targetLabel, `community:${communityId}`),
    ),
  );
  const filters = and(
    workspaceScope,
    actorId ? eq(adminAuditLogsTable.actorId, actorId) : undefined,
    departmentId !== null ? eq(adminAuditLogsTable.departmentId, departmentId) : undefined,
    locationId !== null ? eq(adminAuditLogsTable.locationId, locationId) : undefined,
    action ? eq(adminAuditLogsTable.action, action) : undefined,
    resource ? or(
      ilike(adminAuditLogsTable.resourceType, `%${resource}%`),
      ilike(adminAuditLogsTable.resourceId, `%${resource}%`),
      ilike(adminAuditLogsTable.targetLabel, `%${resource}%`),
      ilike(adminAuditLogsTable.details, `%${resource}%`),
    ) : undefined,
    from ? gte(adminAuditLogsTable.createdAt, from) : undefined,
    to ? lte(adminAuditLogsTable.createdAt, to) : undefined,
  );
  const [entries, actionOptions] = await Promise.all([
    db.select({
      id: adminAuditLogsTable.id,
      actorId: adminAuditLogsTable.actorId,
      actor: usersTable.displayName,
      action: adminAuditLogsTable.action,
      departmentId: adminAuditLogsTable.departmentId,
      locationId: adminAuditLogsTable.locationId,
      resourceType: adminAuditLogsTable.resourceType,
      resourceId: adminAuditLogsTable.resourceId,
      targetLabel: adminAuditLogsTable.targetLabel,
      details: adminAuditLogsTable.details,
      createdAt: adminAuditLogsTable.createdAt,
    }).from(adminAuditLogsTable)
      .leftJoin(usersTable, eq(usersTable.clerkId, adminAuditLogsTable.actorId))
      .where(filters)
      .orderBy(desc(adminAuditLogsTable.createdAt), desc(adminAuditLogsTable.id))
      .limit(200),
    db.selectDistinct({ action: adminAuditLogsTable.action })
      .from(adminAuditLogsTable)
      .where(workspaceScope)
      .orderBy(asc(adminAuditLogsTable.action)),
  ]);
  res.json({
    entries,
    actions: actionOptions.map((item) => item.action),
  });
});

router.post("/communities/:communityId/tasks", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage tasks in this workspace." });
    return;
  }
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 160) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 10000) : "";
  const assignedTo = typeof req.body?.assignedTo === "string" && req.body.assignedTo ? req.body.assignedTo : null;
  const departmentId = req.body?.departmentId ? Number(req.body.departmentId) : null;
  const locationId = req.body?.locationId ? Number(req.body.locationId) : null;
  const priority = typeof req.body?.priority === "string" ? req.body.priority : "medium";
  const dueDate = req.body?.dueDate ? new Date(req.body.dueDate) : null;
  if (!title) {
    res.status(400).json({ error: "A task title is required." });
    return;
  }
  if (!["low", "medium", "high", "urgent"].includes(priority) || (dueDate && Number.isNaN(dueDate.getTime()))) {
    res.status(400).json({ error: "Invalid task priority or due date." });
    return;
  }
  if (assignedTo) {
    const [member] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
      .where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, assignedTo)));
    if (!member) {
      res.status(400).json({ error: "The assignee must be a member of this workspace." });
      return;
    }
  }
  const [task] = await db.insert(workspaceTasksTable).values({
    communityId, title, description, assignedTo, departmentId, locationId, priority, dueDate, createdBy: userId,
  }).returning();
  if (assignedTo) {
    await createNotification({
      userId: assignedTo,
      type: "task_assigned",
      category: "task_assigned",
      body: `You were assigned the task “${title}”.`,
      communityId,
      entityType: "workspace_task",
      entityId: task.id,
      actionUrl: `/communities/${communityId}`,
    });
  }
  await writeCommunityAudit(userId, "created_workspace_task", communityId, title);
  res.status(201).json({ ...task, comments: [], attachments: [] });
});

router.patch("/communities/:communityId/tasks/:taskId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const taskId = Number(param(req, "taskId"));
  if (!Number.isInteger(communityId) || !Number.isInteger(taskId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot update tasks in this workspace." });
    return;
  }
  const [current] = await db.select().from(workspaceTasksTable)
    .where(and(eq(workspaceTasksTable.id, taskId), eq(workspaceTasksTable.communityId, communityId)));
  if (!current) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  const allowedStatuses = ["todo", "in_progress", "waiting", "completed", "cancelled"];
  const status = typeof req.body?.status === "string" ? req.body.status : undefined;
  const priority = typeof req.body?.priority === "string" ? req.body.priority : undefined;
  const dueDate = req.body?.dueDate === null ? null : req.body?.dueDate ? new Date(req.body.dueDate) : undefined;
  if (status !== undefined && !allowedStatuses.includes(status)) {
    res.status(400).json({ error: "Invalid task status." });
    return;
  }
  if (priority !== undefined && !["low", "medium", "high", "urgent"].includes(priority)) {
    res.status(400).json({ error: "Invalid task priority." });
    return;
  }
  if (dueDate instanceof Date && Number.isNaN(dueDate.getTime())) {
    res.status(400).json({ error: "Invalid due date." });
    return;
  }
  const [updated] = await db.update(workspaceTasksTable).set({
    ...(typeof req.body?.title === "string" ? { title: req.body.title.trim().slice(0, 160) } : {}),
    ...(typeof req.body?.description === "string" ? { description: req.body.description.trim().slice(0, 10000) } : {}),
    ...(typeof req.body?.assignedTo === "string" || req.body?.assignedTo === null ? { assignedTo: req.body.assignedTo || null } : {}),
    ...(status === undefined ? {} : { status, completedAt: status === "completed" ? new Date() : null }),
    ...(priority === undefined ? {} : { priority }),
    ...(dueDate === undefined ? {} : { dueDate }),
    updatedAt: new Date(),
  }).where(eq(workspaceTasksTable.id, taskId)).returning();
  if (updated.assignedTo && updated.assignedTo !== current.assignedTo) {
    await createNotification({
      userId: updated.assignedTo,
      type: "task_assigned",
      category: "task_assigned",
      body: `You were assigned the task “${updated.title}”.`,
      communityId,
      entityType: "workspace_task",
      entityId: updated.id,
      actionUrl: `/communities/${communityId}`,
    });
  }
  await writeCommunityAudit(userId, "updated_workspace_task", communityId, `${taskId}${status ? ` → ${status}` : ""}`);
  res.json({ ...updated, comments: [], attachments: [] });
});

router.post("/communities/:communityId/tasks/:taskId/comments", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const taskId = Number(param(req, "taskId"));
  const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 5000) : "";
  const [task] = await db.select({ id: workspaceTasksTable.id }).from(workspaceTasksTable)
    .innerJoin(communityMembersTable, and(eq(communityMembersTable.communityId, workspaceTasksTable.communityId), eq(communityMembersTable.userId, userId)))
    .where(and(eq(workspaceTasksTable.id, taskId), eq(workspaceTasksTable.communityId, communityId)));
  if (!task) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  if (!body) {
    res.status(400).json({ error: "A comment is required." });
    return;
  }
  const [comment] = await db.insert(workspaceTaskCommentsTable).values({ taskId, authorId: userId, body }).returning();
  await writeCommunityAudit(userId, "commented_on_workspace_task", communityId, String(taskId));
  res.status(201).json(comment);
});

router.post("/communities/:communityId/tasks/:taskId/attachments", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const taskId = Number(param(req, "taskId"));
  const [task] = await db.select({ id: workspaceTasksTable.id }).from(workspaceTasksTable)
    .innerJoin(communityMembersTable, and(eq(communityMembersTable.communityId, workspaceTasksTable.communityId), eq(communityMembersTable.userId, userId)))
    .where(and(eq(workspaceTasksTable.id, taskId), eq(workspaceTasksTable.communityId, communityId)));
  const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.trim().slice(0, 200) : "";
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType.slice(0, 120) : "application/octet-stream";
  const fileSize = Number(req.body?.fileSize);
  if (!task) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  if (!objectPath.startsWith("/objects/") || !fileName || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 10_000_000) {
    res.status(400).json({ error: "Invalid task attachment." });
    return;
  }
  const [attachment] = await db.insert(workspaceTaskAttachmentsTable).values({ taskId, uploaderId: userId, objectPath, fileName, contentType, fileSize }).returning();
  res.status(201).json(attachment);
});

router.get("/communities/:communityId/tasks/:taskId/attachments/:attachmentId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const taskId = Number(param(req, "taskId"));
  const attachmentId = Number(param(req, "attachmentId"));
  const [attachment] = await db.select({ objectPath: workspaceTaskAttachmentsTable.objectPath }).from(workspaceTaskAttachmentsTable)
    .innerJoin(workspaceTasksTable, eq(workspaceTasksTable.id, workspaceTaskAttachmentsTable.taskId))
    .innerJoin(communityMembersTable, and(eq(communityMembersTable.communityId, workspaceTasksTable.communityId), eq(communityMembersTable.userId, userId)))
    .where(and(eq(workspaceTaskAttachmentsTable.id, attachmentId), eq(workspaceTaskAttachmentsTable.taskId, taskId), eq(workspaceTasksTable.communityId, communityId)));
  if (!attachment) {
    res.status(404).json({ error: "Attachment not found." });
    return;
  }
  res.redirect(await signedObjectUrlForPath(attachment.objectPath));
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
  const [current] = await db.select().from(employeeProfilesTable).where(and(
    eq(employeeProfilesTable.communityId, communityId),
    eq(employeeProfilesTable.userId, employeeId),
  ));
  if (!current) {
    res.status(404).json({ error: "Employee profile not found." });
    return;
  }
  if (employmentStatus === "terminated") {
    const [workspace] = await db.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId));
    if (workspace?.ownerId === employeeId) {
      res.status(400).json({ error: "Transfer workspace ownership before terminating the current owner." });
      return;
    }
  }
  const updated = await db.transaction(async (tx) => {
    const [next] = await tx.update(employeeProfilesTable).set({
      ...(employmentStatus === undefined ? {} : { employmentStatus }),
      ...(employmentStatus === "onboarding" ? { onboardingStartedAt: now } : {}),
      ...(employmentStatus === "active" ? { onboardedAt: now } : {}),
      ...(employmentStatus === "offboarding" ? { offboardingAt: now } : {}),
      ...(employmentStatus === "terminated" ? { offboardedAt: now } : {}),
    }).where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.userId, employeeId))).returning();
    if (!next) throw new Error("Employee profile update failed.");
    if (employmentStatus === "terminated") {
      const workspaceChannels = await tx.select({ id: channelsTable.id }).from(channelsTable)
        .where(eq(channelsTable.communityId, communityId));
      const workspaceTeams = await tx.select({ id: teamsTable.id }).from(teamsTable)
        .where(eq(teamsTable.communityId, communityId));
      if (workspaceChannels.length) {
        await tx.delete(channelMembersTable).where(and(
          eq(channelMembersTable.userId, employeeId),
          inArray(channelMembersTable.channelId, workspaceChannels.map((channel) => channel.id)),
        ));
      }
      if (workspaceTeams.length) {
        await tx.delete(teamMembersTable).where(and(
          eq(teamMembersTable.userId, employeeId),
          inArray(teamMembersTable.teamId, workspaceTeams.map((team) => team.id)),
        ));
      }
      await tx.delete(userRolesTable).where(and(
        eq(userRolesTable.userId, employeeId),
        eq(userRolesTable.communityId, communityId),
      ));
      await tx.delete(communityMembersTable).where(and(
        eq(communityMembersTable.userId, employeeId),
        eq(communityMembersTable.communityId, communityId),
      ));
    }
    if (employmentStatus === "active") {
      await tx.insert(communityMembersTable).values({ communityId, userId: employeeId }).onConflictDoNothing();
      await tx.insert(userRolesTable).values({
        userId: employeeId,
        role: "employee",
        scopeType: "community",
        communityId,
        grantedBy: userId,
      }).onConflictDoNothing();
    }
    return next;
  });
  await writeCommunityAudit(userId, employmentStatus === "terminated" ? "offboarded_employee" : "updated_employee_status", communityId, {
    resourceType: "employee",
    resourceId: employeeId,
    targetId: employeeId,
    details: `${employeeId} → ${employmentStatus ?? "updated"}`,
  });
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
  if (!invitationRoles.includes(role as typeof invitationRoles[number])) {
    res.status(400).json({ error: "Invitation role must be member, employee, or contractor." });
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
  res.status(201).json({ ...invitation, tokenHash: undefined, invitationToken: rawToken });
});

router.post("/communities/:communityId/invitations/accept", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!Number.isInteger(communityId) || !token) {
    res.status(400).json({ error: "A workspace and invitation token are required." });
    return;
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [invitation] = await db.select().from(workspaceInvitationsTable).where(and(
    eq(workspaceInvitationsTable.communityId, communityId),
    eq(workspaceInvitationsTable.tokenHash, tokenHash),
  ));
  if (!invitation) {
    res.status(404).json({ error: "Invitation not found." });
    return;
  }
  if (invitation.status !== "pending") {
    res.status(409).json({ error: `This invitation is ${invitation.status}.` });
    return;
  }
  if (invitation.expiresAt <= new Date()) {
    await db.update(workspaceInvitationsTable).set({ status: "expired" }).where(eq(workspaceInvitationsTable.id, invitation.id));
    res.status(410).json({ error: "This invitation has expired. Ask a workspace manager to resend it." });
    return;
  }
  let verifiedEmails: string[];
  try {
    verifiedEmails = await verifiedEmailAddressesForUser(userId);
  } catch {
    res.status(503).json({ error: "We could not verify your account email. Please try again." });
    return;
  }
  if (!verifiedEmails.includes(invitation.email.trim().toLowerCase())) {
    res.status(403).json({ error: "Sign in with the verified email address that received this invitation." });
    return;
  }
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [accepted] = await tx.update(workspaceInvitationsTable).set({
      status: "accepted",
      invitedUserId: userId,
      acceptedAt: now,
    }).where(and(
      eq(workspaceInvitationsTable.id, invitation.id),
      eq(workspaceInvitationsTable.status, "pending"),
    )).returning();
    if (!accepted) throw new Error("Invitation is no longer available.");
    await tx.insert(communityMembersTable).values({ communityId, userId }).onConflictDoNothing();
    await tx.insert(employeeProfilesTable).values({
      communityId,
      userId,
      employmentStatus: "onboarding",
      departmentId: invitation.departmentId,
      locationId: invitation.locationId,
      invitedAt: now,
      onboardingStartedAt: now,
    }).onConflictDoUpdate({
      target: [employeeProfilesTable.communityId, employeeProfilesTable.userId],
      set: {
        employmentStatus: "onboarding",
        departmentId: invitation.departmentId,
        locationId: invitation.locationId,
        invitedAt: now,
        onboardingStartedAt: now,
      },
    });
    if (invitation.teamId) {
      await tx.insert(teamMembersTable).values({ teamId: invitation.teamId, userId }).onConflictDoNothing();
    }
    if (invitation.role !== "member") {
      await tx.insert(userRolesTable).values({
        userId,
        role: invitation.role,
        scopeType: "community",
        communityId,
        grantedBy: invitation.invitedBy,
      }).onConflictDoNothing();
    }
    return accepted;
  });
  await writeCommunityAudit(userId, "accepted_workspace_invitation", communityId, `invitation:${result.id}`);
  res.json({ ok: true, communityId, invitationId: result.id, employmentStatus: "onboarding" });
});

router.post("/communities/:communityId/invitations/:invitationId/resend", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const invitationId = Number(param(req, "invitationId"));
  if (!Number.isInteger(communityId) || !Number.isInteger(invitationId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot resend invitations in this workspace." });
    return;
  }
  const [existing] = await db.select().from(workspaceInvitationsTable).where(and(
    eq(workspaceInvitationsTable.id, invitationId),
    eq(workspaceInvitationsTable.communityId, communityId),
  ));
  if (!existing) {
    res.status(404).json({ error: "Invitation not found." });
    return;
  }
  if (existing.status === "accepted") {
    res.status(409).json({ error: "Accepted invitations cannot be resent." });
    return;
  }
  const rawToken = randomUUID();
  const [updated] = await db.update(workspaceInvitationsTable).set({
    status: "pending",
    tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    invitedBy: userId,
    revokedAt: null,
  }).where(eq(workspaceInvitationsTable.id, invitationId)).returning();
  await writeCommunityAudit(userId, "resent_workspace_invitation", communityId, existing.email);
  res.json({ ...updated, tokenHash: undefined, invitationToken: rawToken });
});

router.post("/communities/:communityId/transfer-ownership", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const targetUserId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  const [community] = Number.isInteger(communityId)
    ? await db.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable).where(eq(communitiesTable.id, communityId))
    : [];
  if (!community || (community.ownerId !== userId && !(await hasPermission(userId, "manage_business", { communityId })))) {
    res.status(403).json({ error: "Only the workspace owner can transfer ownership." });
    return;
  }
  if (!targetUserId || targetUserId === userId) {
    res.status(400).json({ error: "Choose another workspace member as the new owner." });
    return;
  }
  const [target] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable).where(and(
    eq(communityMembersTable.communityId, communityId),
    eq(communityMembersTable.userId, targetUserId),
  ));
  if (!target) {
    res.status(400).json({ error: "The new owner must already belong to this workspace." });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.update(communitiesTable).set({ ownerId: targetUserId }).where(eq(communitiesTable.id, communityId));
    await tx.delete(userRolesTable).where(and(
      eq(userRolesTable.userId, userId),
      eq(userRolesTable.communityId, communityId),
      eq(userRolesTable.role, "workspace_owner"),
    ));
    await tx.insert(userRolesTable).values({
      userId,
      role: "workspace_admin",
      scopeType: "community",
      communityId,
      grantedBy: userId,
    }).onConflictDoNothing();
    await tx.delete(userRolesTable).where(and(
      eq(userRolesTable.userId, targetUserId),
      eq(userRolesTable.communityId, communityId),
      eq(userRolesTable.role, "workspace_owner"),
    ));
    await tx.insert(userRolesTable).values({
      userId: targetUserId,
      role: "workspace_owner",
      scopeType: "community",
      communityId,
      grantedBy: userId,
    });
  });
  await writeCommunityAudit(userId, "transferred_workspace_ownership", communityId, {
    resourceType: "workspace",
    resourceId: communityId,
    targetId: targetUserId,
    details: `${userId} → ${targetUserId}`,
  });
  res.json({ ok: true, communityId, ownerId: targetUserId });
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
  const policyMembers = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
    .where(eq(communityMembersTable.communityId, communityId));
  await createNotifications(policyMembers.map((member) => member.userId), {
    type: "document_acknowledgement",
    category: "document_acknowledgement",
    body: `New document requires your acknowledgement: ${title}.`,
    communityId,
    entityType: "workspace_policy",
    entityId: policy.id,
    actionUrl: `/communities/${communityId}`,
  });
  await writeCommunityAudit(userId, "published_workspace_policy", communityId, title);
  res.status(201).json(policy);
});

router.post("/communities/:communityId/policies/:policyId/acknowledge", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const policyId = Number(param(req, "policyId"));
  const [policy] = await db.select({ id: workspacePoliciesTable.id, title: workspacePoliciesTable.title, createdBy: workspacePoliciesTable.createdBy }).from(workspacePoliciesTable)
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
  if (policy.createdBy !== userId) {
    const [acknowledger] = await db.select({ displayName: usersTable.displayName }).from(usersTable).where(eq(usersTable.clerkId, userId)).limit(1);
    await createNotification({
      userId: policy.createdBy,
      type: "document_acknowledgement",
      category: "document_acknowledgement",
      body: `${acknowledger?.displayName ?? "An employee"} acknowledged “${policy.title}”.`,
      communityId,
      entityType: "workspace_policy",
      entityId: policyId,
      actionUrl: `/communities/${communityId}`,
    });
  }
  res.json(acknowledgement);
});

router.get("/communities/:communityId/documents", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await canAccessBusiness(userId, communityId))) {
    res.status(404).json({ error: "Business workspace not found." });
    return;
  }
  const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const folderId = typeof req.query.folderId === "string" && req.query.folderId ? Number(req.query.folderId) : null;
  const manager = await communityPermission(userId, communityId, "manage_community");
  const [folders, documents, versions, acknowledgements, permissions, downloads] = await Promise.all([
    db.select().from(documentFoldersTable).where(eq(documentFoldersTable.communityId, communityId)).orderBy(asc(documentFoldersTable.name)),
    db.select().from(businessDocumentsTable).where(eq(businessDocumentsTable.communityId, communityId)).orderBy(desc(businessDocumentsTable.updatedAt)),
    db.select().from(documentVersionsTable).innerJoin(businessDocumentsTable, eq(businessDocumentsTable.id, documentVersionsTable.documentId)).where(eq(businessDocumentsTable.communityId, communityId)).orderBy(desc(documentVersionsTable.version)),
    db.select().from(documentAcknowledgementsTable).innerJoin(businessDocumentsTable, eq(businessDocumentsTable.id, documentAcknowledgementsTable.documentId)).where(eq(businessDocumentsTable.communityId, communityId)),
    db.select().from(documentPermissionsTable).innerJoin(businessDocumentsTable, eq(businessDocumentsTable.id, documentPermissionsTable.documentId)).where(eq(businessDocumentsTable.communityId, communityId)),
    db.select({ documentId: documentDownloadsTable.documentId }).from(documentDownloadsTable).innerJoin(businessDocumentsTable, eq(businessDocumentsTable.id, documentDownloadsTable.documentId)).where(eq(businessDocumentsTable.communityId, communityId)),
  ]);
  const permissionsByDocument = new Map<number, Array<{ userId: string; permission: string }>>();
  permissions.forEach(({ irc_document_permissions: permission }) => {
    const current = permissionsByDocument.get(permission.documentId) ?? [];
    current.push({ userId: permission.userId, permission: permission.permission });
    permissionsByDocument.set(permission.documentId, current);
  });
  const visible = documents.filter((document) => {
    if (folderId !== null && document.folderId !== folderId) return false;
    const textMatch = !query || `${document.title} ${document.description} ${document.category}`.toLowerCase().includes(query)
      || versions.some(({ irc_document_versions: version }) => version.documentId === document.id && version.fileName.toLowerCase().includes(query));
    if (!textMatch) return false;
    if (manager || document.visibility === "company" || (document.visibility === "employee" && document.targetUserId === userId)) return true;
    return permissionsByDocument.get(document.id)?.some((permission) => permission.userId === userId) ?? false;
  });
  res.json({
    folders,
    documents: visible.map((document) => ({
      ...document,
      versions: versions.filter(({ irc_document_versions: version }) => version.documentId === document.id).map(({ irc_document_versions: version }) => version),
      acknowledgedAt: acknowledgements.find(({ irc_document_acknowledgements: acknowledgement }) => acknowledgement.documentId === document.id && acknowledgement.userId === userId)?.irc_document_acknowledgements.acknowledgedAt ?? null,
      acknowledgementCount: acknowledgements.filter(({ irc_document_acknowledgements: acknowledgement }) => acknowledgement.documentId === document.id).length,
      downloadCount: downloads.filter((download) => download.documentId === document.id).length,
      permissions: manager ? permissionsByDocument.get(document.id) ?? [] : undefined,
    })),
    canManage: manager,
  });
});

router.post("/communities/:communityId/document-folders", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage document folders in this workspace." });
    return;
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
  const parentId = req.body?.parentId ? Number(req.body.parentId) : null;
  if (!name) {
    res.status(400).json({ error: "A folder name is required." });
    return;
  }
  if (parentId) {
    const [parent] = await db.select({ id: documentFoldersTable.id }).from(documentFoldersTable).where(and(eq(documentFoldersTable.id, parentId), eq(documentFoldersTable.communityId, communityId)));
    if (!parent) {
      res.status(400).json({ error: "Parent folder not found." });
      return;
    }
  }
  const [folder] = await db.insert(documentFoldersTable).values({ communityId, parentId, name, createdBy: userId }).returning();
  await writeCommunityAudit(userId, "created_document_folder", communityId, name);
  res.status(201).json(folder);
});

router.post("/communities/:communityId/documents", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage documents in this workspace." });
    return;
  }
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 160) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 1000) : "";
  const category = typeof req.body?.category === "string" ? req.body.category : "company";
  const visibility = typeof req.body?.visibility === "string" ? req.body.visibility : "company";
  const folderId = req.body?.folderId ? Number(req.body.folderId) : null;
  const targetUserId = typeof req.body?.targetUserId === "string" && req.body.targetUserId ? req.body.targetUserId : null;
  const requiresAcknowledgement = Boolean(req.body?.requiresAcknowledgement);
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.trim().slice(0, 200) : "";
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType.slice(0, 120) : "application/octet-stream";
  const fileSize = Number(req.body?.fileSize);
  if (!title || !documentCategories.includes(category as typeof documentCategories[number]) || !documentVisibilities.includes(visibility as typeof documentVisibilities[number]) || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
    res.status(400).json({ error: "A valid document title, category, visibility, and expiration are required." });
    return;
  }
  if (!objectPath.startsWith("/objects/") || !fileName || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 25_000_000) {
    res.status(400).json({ error: "A valid uploaded file is required." });
    return;
  }
  if (visibility === "employee" && !targetUserId) {
    res.status(400).json({ error: "Choose an employee for employee documents." });
    return;
  }
  if (folderId) {
    const [folder] = await db.select({ id: documentFoldersTable.id }).from(documentFoldersTable).where(and(eq(documentFoldersTable.id, folderId), eq(documentFoldersTable.communityId, communityId)));
    if (!folder) {
      res.status(400).json({ error: "Folder not found." });
      return;
    }
  }
  if (targetUserId) {
    const [member] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable).where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, targetUserId)));
    if (!member) {
      res.status(400).json({ error: "Employee is not a member of this workspace." });
      return;
    }
  }
  const [document] = await db.insert(businessDocumentsTable).values({
    communityId, folderId, title, description, category, visibility, targetUserId, requiresAcknowledgement, expiresAt, ownerId: userId,
  }).returning();
  const [version] = await db.insert(documentVersionsTable).values({
    documentId: document.id, version: 1, objectPath, fileName, contentType, fileSize, uploadedBy: userId,
  }).returning();
  await writeCommunityAudit(userId, "created_business_document", communityId, title);
  res.status(201).json({ ...document, versions: [version] });
});

router.post("/communities/:communityId/documents/:documentId/versions", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const documentId = Number(param(req, "documentId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot update documents in this workspace." });
    return;
  }
  const [document] = await db.select().from(businessDocumentsTable).where(and(eq(businessDocumentsTable.id, documentId), eq(businessDocumentsTable.communityId, communityId)));
  const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.trim().slice(0, 200) : "";
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType.slice(0, 120) : "application/octet-stream";
  const fileSize = Number(req.body?.fileSize);
  if (!document) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  if (!objectPath.startsWith("/objects/") || !fileName || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 25_000_000) {
    res.status(400).json({ error: "A valid uploaded file is required." });
    return;
  }
  const [latest] = await db.select({ version: documentVersionsTable.version }).from(documentVersionsTable).where(eq(documentVersionsTable.documentId, documentId)).orderBy(desc(documentVersionsTable.version)).limit(1);
  const [version] = await db.insert(documentVersionsTable).values({ documentId, version: (latest?.version ?? 0) + 1, objectPath, fileName, contentType, fileSize, uploadedBy: userId }).returning();
  await db.update(businessDocumentsTable).set({ updatedAt: new Date() }).where(eq(businessDocumentsTable.id, documentId));
  await writeCommunityAudit(userId, "uploaded_document_version", communityId, `${document.title} v${version.version}`);
  res.status(201).json(version);
});

router.post("/communities/:communityId/documents/:documentId/acknowledge", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const documentId = Number(param(req, "documentId"));
  const document = await documentForUser(documentId, communityId, userId);
  if (!document) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  if (!document.requiresAcknowledgement) {
    res.status(400).json({ error: "This document does not require acknowledgment." });
    return;
  }
  const [acknowledgement] = await db.insert(documentAcknowledgementsTable).values({ documentId, userId }).onConflictDoUpdate({
    target: [documentAcknowledgementsTable.documentId, documentAcknowledgementsTable.userId],
    set: { acknowledgedAt: new Date() },
  }).returning();
  res.json(acknowledgement);
});

router.post("/communities/:communityId/documents/:documentId/permissions", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const documentId = Number(param(req, "documentId"));
  if (!Number.isInteger(communityId) || !(await requireWorkspaceManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot manage document permissions in this workspace." });
    return;
  }
  const targetUserId = typeof req.body?.userId === "string" ? req.body.userId : "";
  const permission = typeof req.body?.permission === "string" ? req.body.permission : "viewer";
  const [document] = await db.select({ id: businessDocumentsTable.id }).from(businessDocumentsTable).where(and(eq(businessDocumentsTable.id, documentId), eq(businessDocumentsTable.communityId, communityId)));
  if (!document || !targetUserId || !["viewer", "editor", "acknowledger"].includes(permission)) {
    res.status(400).json({ error: "Invalid document permission." });
    return;
  }
  const [member] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable).where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, targetUserId)));
  if (!member) {
    res.status(400).json({ error: "User is not a workspace member." });
    return;
  }
  const [grant] = await db.insert(documentPermissionsTable).values({ documentId, userId: targetUserId, permission, grantedBy: userId }).onConflictDoUpdate({
    target: [documentPermissionsTable.documentId, documentPermissionsTable.userId],
    set: { permission, grantedBy: userId },
  }).returning();
  res.status(201).json(grant);
});

router.get("/communities/:communityId/documents/:documentId/download/:versionId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const documentId = Number(param(req, "documentId"));
  const versionId = Number(param(req, "versionId"));
  const document = await documentForUser(documentId, communityId, userId);
  const [version] = await db.select().from(documentVersionsTable).where(and(eq(documentVersionsTable.id, versionId), eq(documentVersionsTable.documentId, documentId)));
  if (!document || !version) {
    res.status(404).json({ error: "Document version not found." });
    return;
  }
  await db.insert(documentDownloadsTable).values({ documentId, versionId, userId });
  try {
    res.redirect(await signedObjectUrlForPath(version.objectPath));
  } catch {
    res.status(503).json({ error: "Document storage is temporarily unavailable." });
  }
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
  const [targetProfile] = await db.select({
    displayName: usersTable.displayName,
  }).from(usersTable).where(eq(usersTable.clerkId, memberId)).limit(1);
  const [targetEmployee] = await db.select({
    departmentId: employeeProfilesTable.departmentId,
    locationId: employeeProfilesTable.locationId,
  }).from(employeeProfilesTable).where(and(
    eq(employeeProfilesTable.communityId, communityId),
    eq(employeeProfilesTable.userId, memberId),
  )).limit(1);
  await writeCommunityAudit(userId, "changed_community_role", communityId, {
    resourceType: "employee",
    resourceId: memberId,
    resourceLabel: targetProfile?.displayName ?? memberId,
    departmentId: targetEmployee?.departmentId,
    locationId: targetEmployee?.locationId,
    details: `role → ${role}`,
  });
  res.json({ ok: true, userId: memberId, role, communityId });
});

router.post("/communities/:communityId/announcements", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  if (!Number.isInteger(communityId) || !(await communityPermission(userId, communityId, "create_announcement"))) {
    res.status(403).json({ error: "You cannot announce in this community." });
    return;
  }
  const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 160) : "Announcement";
  const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 10000) : "";
  const audienceType = typeof req.body?.audienceType === "string" ? req.body.audienceType : "company";
  const departmentId = req.body?.departmentId ? Number(req.body.departmentId) : null;
  const locationId = req.body?.locationId ? Number(req.body.locationId) : null;
  const teamId = req.body?.teamId ? Number(req.body.teamId) : null;
  const recipientId = typeof req.body?.recipientId === "string" && req.body.recipientId ? req.body.recipientId : null;
  const requiresAcknowledgement = Boolean(req.body?.requiresAcknowledgement);
  const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  const allowedAudiences = ["company", "department", "location", "team", "individual"];
  if (!body) {
    res.status(400).json({ error: "Announcement text is required." });
    return;
  }
  if (!allowedAudiences.includes(audienceType) || (scheduledAt && Number.isNaN(scheduledAt.getTime())) || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
    res.status(400).json({ error: "Invalid announcement audience or date." });
    return;
  }
  if (scheduledAt && expiresAt && expiresAt <= scheduledAt) {
    res.status(400).json({ error: "Expiration must be after the scheduled time." });
    return;
  }
  if (audienceType === "department" && (!departmentId || !(await db.select({ id: departmentsTable.id }).from(departmentsTable).where(and(eq(departmentsTable.id, departmentId), eq(departmentsTable.communityId, communityId))).limit(1)).length)) {
    res.status(400).json({ error: "Choose a department in this workspace." });
    return;
  }
  if (audienceType === "location" && (!locationId || !(await db.select({ id: locationsTable.id }).from(locationsTable).where(and(eq(locationsTable.id, locationId), eq(locationsTable.communityId, communityId))).limit(1)).length)) {
    res.status(400).json({ error: "Choose a location in this workspace." });
    return;
  }
  if (audienceType === "team" && (!teamId || !(await db.select({ id: teamsTable.id }).from(teamsTable).where(and(eq(teamsTable.id, teamId), eq(teamsTable.communityId, communityId))).limit(1)).length)) {
    res.status(400).json({ error: "Choose a team in this workspace." });
    return;
  }
  if (audienceType === "individual" && (!recipientId || !(await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable).where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, recipientId))).limit(1)).length)) {
    res.status(400).json({ error: "Choose an employee in this workspace." });
    return;
  }
  const isScheduled = scheduledAt !== null && scheduledAt > new Date();
  const [announcement] = await db.insert(serverAnnouncementsTable).values({
    authorId: userId, communityId, title, body, audienceType, departmentId, locationId, teamId, recipientId,
    requiresAcknowledgement, scheduledAt, expiresAt, status: isScheduled ? "scheduled" : "published",
  }).returning();
  const recipients = audienceType === "company"
    ? await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable).where(eq(communityMembersTable.communityId, communityId))
    : audienceType === "department"
      ? await db.select({ userId: employeeProfilesTable.userId }).from(employeeProfilesTable).where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.departmentId, departmentId!)))
      : audienceType === "location"
        ? await db.select({ userId: employeeProfilesTable.userId }).from(employeeProfilesTable).where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.locationId, locationId!)))
        : audienceType === "team"
          ? await db.select({ userId: teamMembersTable.userId }).from(teamMembersTable).innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId)).where(and(eq(teamsTable.communityId, communityId), eq(teamMembersTable.teamId, teamId!)))
          : recipientId ? [{ userId: recipientId }] : [];
  if (recipients.length && !isScheduled) {
    await createNotifications(recipients.map((recipient) => recipient.userId), {
      type: "community_announcement",
      category: "announcement",
      body: `${title}: ${body}`,
      communityId,
      entityType: "announcement",
      entityId: announcement.id,
      actionUrl: `/communities/${communityId}`,
    });
  }
  await writeCommunityAudit(userId, isScheduled ? "scheduled_community_announcement" : "published_community_announcement", communityId, title);
  res.status(201).json(announcement);
});

router.post("/communities/:communityId/announcements/:announcementId/read", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const announcementId = Number(param(req, "announcementId"));
  const [announcement] = await db.select({ id: serverAnnouncementsTable.id }).from(serverAnnouncementsTable)
    .innerJoin(communityMembersTable, and(eq(communityMembersTable.communityId, serverAnnouncementsTable.communityId), eq(communityMembersTable.userId, userId)))
    .where(and(eq(serverAnnouncementsTable.id, announcementId), eq(serverAnnouncementsTable.communityId, communityId)));
  if (!announcement) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  const [receipt] = await db.insert(announcementReadReceiptsTable).values({ announcementId, userId })
    .onConflictDoUpdate({ target: [announcementReadReceiptsTable.announcementId, announcementReadReceiptsTable.userId], set: { readAt: new Date() } }).returning();
  res.json(receipt);
});

router.post("/communities/:communityId/announcements/:announcementId/acknowledge", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const announcementId = Number(param(req, "announcementId"));
  const [announcement] = await db.select({ id: serverAnnouncementsTable.id, requiresAcknowledgement: serverAnnouncementsTable.requiresAcknowledgement }).from(serverAnnouncementsTable)
    .innerJoin(communityMembersTable, and(eq(communityMembersTable.communityId, serverAnnouncementsTable.communityId), eq(communityMembersTable.userId, userId)))
    .where(and(eq(serverAnnouncementsTable.id, announcementId), eq(serverAnnouncementsTable.communityId, communityId)));
  if (!announcement) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  if (!announcement.requiresAcknowledgement) {
    res.status(400).json({ error: "This announcement does not require acknowledgement." });
    return;
  }
  const [acknowledgement] = await db.insert(announcementAcknowledgementsTable).values({ announcementId, userId })
    .onConflictDoUpdate({ target: [announcementAcknowledgementsTable.announcementId, announcementAcknowledgementsTable.userId], set: { acknowledgedAt: new Date() } }).returning();
  res.json(acknowledgement);
});

router.post("/communities/:communityId/announcements/:announcementId/attachments", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const announcementId = Number(param(req, "announcementId"));
  const [announcement] = await db.select({ id: serverAnnouncementsTable.id }).from(serverAnnouncementsTable)
    .where(and(eq(serverAnnouncementsTable.id, announcementId), eq(serverAnnouncementsTable.communityId, communityId), eq(serverAnnouncementsTable.authorId, userId)));
  const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.trim().slice(0, 200) : "";
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType.slice(0, 120) : "application/octet-stream";
  const fileSize = Number(req.body?.fileSize);
  if (!announcement) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  if (!objectPath.startsWith("/objects/") || !fileName || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 10_000_000) {
    res.status(400).json({ error: "Invalid announcement attachment." });
    return;
  }
  const [attachment] = await db.insert(announcementAttachmentsTable).values({ announcementId, uploaderId: userId, objectPath, fileName, contentType, fileSize }).returning();
  res.status(201).json(attachment);
});

router.get("/communities/:communityId/announcements/:announcementId/attachments/:attachmentId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const announcementId = Number(param(req, "announcementId"));
  const attachmentId = Number(param(req, "attachmentId"));
  const [attachment] = await db.select({ objectPath: announcementAttachmentsTable.objectPath }).from(announcementAttachmentsTable)
    .innerJoin(serverAnnouncementsTable, eq(serverAnnouncementsTable.id, announcementAttachmentsTable.announcementId))
    .innerJoin(communityMembersTable, and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, userId)))
    .where(and(eq(announcementAttachmentsTable.id, attachmentId), eq(announcementAttachmentsTable.announcementId, announcementId), eq(serverAnnouncementsTable.communityId, communityId)));
  if (!attachment) {
    res.status(404).json({ error: "Attachment not found." });
    return;
  }
  res.redirect(await signedObjectUrlForPath(attachment.objectPath));
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