import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  blocksTable,
  adminAuditLogsTable,
  announcementAcknowledgementsTable,
  announcementAttachmentsTable,
  announcementReadReceiptsTable,
  categoriesTable,
  channelBansTable,
  channelInvitesTable,
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
  messageAttachmentsTable,
  messageReactionsTable,
  messagesTable,
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
import { isValidUploadedObjectPath, signedObjectUrlForPath } from "./storage";
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
import { categoryForNotification, createNotification, createNotifications } from "../lib/notifications";
import { canGrantWorkspaceRole } from "../lib/role-grant-policy";
import { wsHub } from "../lib/ws";
import { validateUploadMetadata } from "./storage";
import { enqueueObjectDeletionJobs } from "../lib/object-cleanup";
import { assertDeletionEligibleUser, finalizePendingAccountDeletion } from "../lib/account-deletion";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  COMMUNITY_DELETION_CONFIRMATION,
  MEMBER_REMOVAL_CONFIRMATION,
  confirmationMatches,
  exactCommunityOwner,
  targetMayBePermanentlyDeleted,
} from "../lib/destructive-policy";

const router: IRouter = Router();
const scopedCommunityPermissions = ["manage_community", "manage_community_members", "create_channel", "create_announcement"] as const;
const invitationRoles = ["member", "employee", "contractor"] as const;

function deletionConfirmation(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).confirmation;
  return typeof value === "string" ? value : null;
}

function onboardingCommunity(community: typeof communitiesTable.$inferSelect, joined = true, canManage = false) {
  return {
    id: community.id,
    name: community.name,
    slug: community.slug,
    plan: community.plan,
    onboardingStep: community.onboardingStep,
    joined,
    canManage,
  };
}

function onboardingNextStep(ownerCommunity: ReturnType<typeof onboardingCommunity> | null, hasMembership: boolean) {
  if (!ownerCommunity) return hasMembership ? "start" : "create";
  if (ownerCommunity.onboardingStep >= 9) return "start";
  return ownerCommunity.onboardingStep >= 2 ? "invite" : "configure";
}

async function provisionFreeCommunity(userId: string, displayName: string) {
  const slug = `relay-${slugify(userId).slice(-20) || randomUUID().slice(0, 8)}`;
  const name = `${displayName.trim().slice(0, 56) || "Relay"} community`;
  const existing = await db.select().from(communitiesTable).where(and(
    eq(communitiesTable.ownerId, userId),
    eq(communitiesTable.plan, "free_community"),
  )).orderBy(desc(communitiesTable.createdAt)).limit(1);
  if (existing[0]) return existing[0];
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(communitiesTable).values({
        name,
        slug,
        description: "A free Relay community.",
        businessType: "community",
        plan: "free_community",
        onboardingStep: 2,
        isPrivate: false,
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
      const [generalCategory] = await tx.insert(categoriesTable).values({
        name: "community",
        description: "Shared rooms for the community.",
        ownerId: userId,
        communityId: created.id,
      }).returning({ id: categoriesTable.id });
      const defaultChannels = [
        ["#welcome", "Introduce yourself and meet the community."],
        ["#general", "The main room for conversation."],
      ];
      const createdChannels = await tx.insert(channelsTable).values(defaultChannels.map(([channelName, topic]) => ({
        name: channelName,
        topic,
        ownerId: userId,
        communityId: created.id,
        categoryId: generalCategory.id,
        isPrivate: false,
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
  } catch {
    const [createdByAnotherRequest] = await db.select().from(communitiesTable).where(and(
      eq(communitiesTable.ownerId, userId),
      eq(communitiesTable.plan, "free_community"),
    )).orderBy(desc(communitiesTable.createdAt)).limit(1);
    if (createdByAnotherRequest) return createdByAnotherRequest;
    throw new Error("Unable to create a free community");
  }
}

async function requireWorkspaceManager(userId: string, communityId: number): Promise<boolean> {
  return communityPermission(userId, communityId, "manage_community");
}

async function requireOrganizationManager(userId: string, communityId: number): Promise<boolean> {
  return communityPermission(userId, communityId, "manage_organization");
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
  await ensurePermissionCatalog();
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

router.get("/onboarding", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const profile = await ensureProfile(userId);
  await provisionFreeCommunity(userId, profile.displayName);
  const [ownedCommunities, memberships] = await Promise.all([
    db.select().from(communitiesTable)
      .where(and(eq(communitiesTable.ownerId, userId), eq(communitiesTable.plan, "free_community")))
      .orderBy(desc(communitiesTable.createdAt)),
    db.select({
      community: communitiesTable,
    }).from(communityMembersTable)
      .innerJoin(communitiesTable, eq(communitiesTable.id, communityMembersTable.communityId))
      .where(and(
        eq(communityMembersTable.userId, userId),
        inArray(communitiesTable.plan, ["free_community", "purchased_community"]),
      ))
      .orderBy(desc(communitiesTable.createdAt)),
  ]);
  const ownerCommunity = ownedCommunities[0] ? onboardingCommunity(ownedCommunities[0], true, true) : null;
  const communities = memberships.map(({ community }) => onboardingCommunity(
    community,
    true,
    community.ownerId === userId,
  ));
  res.json({
    nextStep: onboardingNextStep(ownerCommunity, communities.length > 0),
    ownerCommunity,
    communities,
  });
});

router.post("/onboarding/:communityId/progress", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const requestedStep = Number(req.body?.step);
  if (!Number.isInteger(communityId) || ![2, 9].includes(requestedStep)) {
    res.status(400).json({ error: "Onboarding step must be 2 or 9." });
    return;
  }
  const [community] = await db.select().from(communitiesTable).where(eq(communitiesTable.id, communityId));
  if (!community) {
    res.status(404).json({ error: "Community not found." });
    return;
  }
  if (community.ownerId !== userId) {
    res.status(403).json({ error: "Only the community owner can advance onboarding." });
    return;
  }
  const [updated] = community.onboardingStep >= requestedStep
    ? [community]
    : await db.update(communitiesTable)
      .set({ onboardingStep: requestedStep })
      .where(eq(communitiesTable.id, communityId))
      .returning();
  const summary = onboardingCommunity(updated, true, true);
  res.json({
    community: summary,
    nextStep: onboardingNextStep(summary, true),
  });
});

router.get("/communities", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  const communities = await db.select().from(communitiesTable)
    .where(eq(communitiesTable.plan, "paid_workspace"))
    .orderBy(asc(communitiesTable.name));
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
    const { community, creationNotification } = await db.transaction(async (tx) => {
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
        plan: "paid_workspace",
        onboardingStep: req.body?.onboarding === true ? 1 : 9,
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
      const [actor] = await tx.select({ displayName: usersTable.displayName })
        .from(usersTable).where(eq(usersTable.clerkId, userId)).limit(1);
      await tx.insert(adminAuditLogsTable).values({
        actorId: userId,
        actorDisplayName: actor?.displayName,
        communityId: created.id,
        action: "created_community",
        resourceType: "workspace",
        resourceId: String(created.id),
        targetId: String(created.id),
        targetLabel: `community:${created.id}`,
        details: `Created ${created.name}`,
      });
      const [creationNotification] = await tx.insert(notificationsTable).values({
        userId,
        type: "administrative_action",
        category: "administrative_action",
        body: `created community: Created ${created.name}`,
        communityId: created.id,
        entityType: "community",
        entityId: String(created.id),
        actionUrl: `/communities/${created.id}`,
      }).returning();
      return { community: created, creationNotification };
    });
    if (creationNotification) {
      try {
        wsHub.broadcastUser(userId, { type: "notification", notification: creationNotification });
      } catch (error) {
        req.log.warn({ err: error }, "Could not broadcast community creation notification");
      }
    }
    res.status(201).json({ ...community, joined: true, canManage: true, defaultChannelsCreated: 6 });
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 3 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && cause.code === "23505"
        && "constraint" in cause && cause.constraint === "irc_communities_slug_idx") {
        res.status(409).json({ error: "That community slug is already in use." });
        return;
      }
      cause = "cause" in cause ? cause.cause : null;
    }
    req.log.error({ err: error }, "Failed to create community");
    res.status(500).json({ error: "Unable to create the community. Please try again." });
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
    db.select({
      teamId: teamMembersTable.teamId,
      userId: teamMembersTable.userId,
      role: teamMembersTable.role,
      status: teamMembersTable.status,
      joinedAt: teamMembersTable.joinedAt,
      endedAt: teamMembersTable.endedAt,
    }).from(teamMembersTable)
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
  const canManageOrganization = await requireOrganizationManager(userId, community.id);
  const viewerIsMember = members.some((member) => member.id === userId);
  const visibleChannels = channels.filter((channel) => !channel.isPrivate || viewerIsMember || canManage);
  const employeeProfilesByUserId = new Map(employees.map((employee) => [employee.userId, employee]));
  const teamMembershipsByUserId = new Map<string, typeof teamMemberships>();
  for (const membership of teamMemberships) {
    const existing = teamMembershipsByUserId.get(membership.userId) ?? [];
    existing.push(membership);
    teamMembershipsByUserId.set(membership.userId, existing);
  }
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
      teamIds: (teamMembershipsByUserId.get(member.id) ?? [])
        .filter((membership) => membership.status === "active")
        .map((membership) => membership.teamId),
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
    canManageOrganization,
    isOwner: community.ownerId === userId,
    teamMemberships,
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
  const [
    [memberStats],
    [channelStats],
    [taskStats],
    [announcementStats],
    [requestStats],
    activity,
  ] = await Promise.all([
    db.select({
      employees: count(),
      online: sql<number>`count(*) filter (where ${usersTable.status} = ${"online"})`,
    }).from(communityMembersTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
      .where(eq(communityMembersTable.communityId, communityId)),
    db.select({ channels: count() }).from(channelsTable)
      .where(eq(channelsTable.communityId, communityId)),
    db.select({
      open: sql<number>`count(*) filter (
        where ${workspaceTasksTable.status} not in (${"completed"}, ${"cancelled"})
      )`,
      dueThisWeek: sql<number>`count(*) filter (
        where ${workspaceTasksTable.status} not in (${"completed"}, ${"cancelled"})
          and ${workspaceTasksTable.dueDate} is not null
          and ${workspaceTasksTable.dueDate} >= ${now}
          and ${workspaceTasksTable.dueDate} <= ${weekAhead}
      )`,
      overdue: sql<number>`count(*) filter (
        where ${workspaceTasksTable.status} not in (${"completed"}, ${"cancelled"})
          and ${workspaceTasksTable.dueDate} is not null
          and ${workspaceTasksTable.dueDate} < ${now}
      )`,
    }).from(workspaceTasksTable)
      .where(eq(workspaceTasksTable.communityId, communityId)),
    db.select({
      announcements: sql<number>`count(*) filter (
        where ${serverAnnouncementsTable.status} = ${"published"}
          and (${serverAnnouncementsTable.scheduledAt} is null or ${serverAnnouncementsTable.scheduledAt} <= ${now})
          and (${serverAnnouncementsTable.expiresAt} is null or ${serverAnnouncementsTable.expiresAt} > ${now})
      )`,
    })
      .from(serverAnnouncementsTable).where(eq(serverAnnouncementsTable.communityId, communityId)),
    db.select({ pendingRequests: count() }).from(channelJoinRequestsTable)
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
  const openTasks = Number(taskStats?.open ?? 0);
  res.json({
    stats: {
      employees: Number(memberStats?.employees ?? 0),
      online: Number(memberStats?.online ?? 0),
      channels: Number(channelStats?.channels ?? 0),
      openTasks,
      announcements: Number(announcementStats?.announcements ?? 0),
      pendingRequests: Number(requestStats?.pendingRequests ?? 0),
    },
    tasks: {
      open: openTasks,
      dueThisWeek: Number(taskStats?.dueThisWeek ?? 0),
      overdue: Number(taskStats?.overdue ?? 0),
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
      actor: sql<string>`coalesce(${usersTable.displayName}, ${adminAuditLogsTable.actorDisplayName}, 'deleted user')`,
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
  const departmentId = req.body?.departmentId === undefined || req.body?.departmentId === null || req.body?.departmentId === ""
    ? null
    : Number(req.body.departmentId);
  const locationId = req.body?.locationId === undefined || req.body?.locationId === null || req.body?.locationId === ""
    ? null
    : Number(req.body.locationId);
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
  if (
    (departmentId !== null && (!Number.isSafeInteger(departmentId) || departmentId <= 0))
    || (locationId !== null && (!Number.isSafeInteger(locationId) || locationId <= 0))
  ) {
    res.status(400).json({ error: "Task organization assignments must use valid IDs." });
    return;
  }
  const [departments, locations] = await Promise.all([
    departmentId === null
      ? Promise.resolve([])
      : db.select({ id: departmentsTable.id }).from(departmentsTable).where(and(
        eq(departmentsTable.id, departmentId),
        eq(departmentsTable.communityId, communityId),
      )),
    locationId === null
      ? Promise.resolve([])
      : db.select({ id: locationsTable.id }).from(locationsTable).where(and(
        eq(locationsTable.id, locationId),
        eq(locationsTable.communityId, communityId),
      )),
  ]);
  if (
    (departmentId !== null && departments.length === 0)
    || (locationId !== null && locations.length === 0)
  ) {
    res.status(400).json({ error: "Task organization assignments must belong to this workspace." });
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
  const hasAssignedTo = typeof req.body?.assignedTo === "string" || req.body?.assignedTo === null;
  const assignedTo = hasAssignedTo && typeof req.body?.assignedTo === "string" && req.body.assignedTo
    ? req.body.assignedTo
    : hasAssignedTo ? null : undefined;
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
  if (assignedTo) {
    const [member] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
      .where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, assignedTo)));
    if (!member) {
      res.status(400).json({ error: "The assignee must be a member of this workspace." });
      return;
    }
  }
  const [updated] = await db.update(workspaceTasksTable).set({
    ...(typeof req.body?.title === "string" ? { title: req.body.title.trim().slice(0, 160) } : {}),
    ...(typeof req.body?.description === "string" ? { description: req.body.description.trim().slice(0, 10000) } : {}),
    ...(assignedTo === undefined ? {} : { assignedTo }),
    ...(status === undefined ? {} : { status, completedAt: status === "completed" ? new Date() : null }),
    ...(priority === undefined ? {} : { priority }),
    ...(dueDate === undefined ? {} : { dueDate }),
    updatedAt: new Date(),
  }).where(eq(workspaceTasksTable.id, taskId)).returning();
  const assignmentChanged = updated.assignedTo !== current.assignedTo;
  const changedFields: string[] = [];
  if (updated.title !== current.title) changedFields.push("title");
  if (updated.description !== current.description) changedFields.push("description");
  if (updated.status !== current.status) changedFields.push(`status → ${updated.status}`);
  if (updated.priority !== current.priority) changedFields.push(`priority → ${updated.priority}`);
  const currentDueDate = current.dueDate?.getTime() ?? null;
  const updatedDueDate = updated.dueDate?.getTime() ?? null;
  if (updatedDueDate !== currentDueDate) changedFields.push(updated.dueDate ? "due date" : "due date cleared");
  if (updated.assignedTo && assignmentChanged) {
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
  if (current.assignedTo && assignmentChanged) {
    await createNotification({
      userId: current.assignedTo,
      type: "task_updated",
      category: "task_updated",
      body: `You are no longer assigned the task “${updated.title}”.`,
      communityId,
      entityType: "workspace_task",
      entityId: updated.id,
      actionUrl: `/communities/${communityId}`,
    });
  } else if (updated.assignedTo && changedFields.length > 0) {
    await createNotification({
      userId: updated.assignedTo,
      type: "task_updated",
      category: "task_updated",
      body: `Task “${updated.title}” updated: ${changedFields.join(", ")}.`,
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
   if (!isValidUploadedObjectPath(objectPath) || !fileName || fileName.includes("/") || fileName.includes("\\") || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 10_000_000) {
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
  if (departmentId !== null && (!Number.isSafeInteger(departmentId) || !(await db.select({ id: departmentsTable.id }).from(departmentsTable).where(and(
    eq(departmentsTable.id, departmentId),
    eq(departmentsTable.communityId, communityId),
  )).limit(1)).length)) {
    res.status(400).json({ error: "Department does not belong to this workspace." });
    return;
  }
  if (locationId !== null && (!Number.isSafeInteger(locationId) || !(await db.select({ id: locationsTable.id }).from(locationsTable).where(and(
    eq(locationsTable.id, locationId),
    eq(locationsTable.communityId, communityId),
  )).limit(1)).length)) {
    res.status(400).json({ error: "Location does not belong to this workspace." });
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
      await assertDeletionEligibleUser(employeeId, tx);
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

router.patch("/communities/:communityId/employees/:employeeId/organization", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const employeeId = param(req, "employeeId");
  if (!Number.isInteger(communityId) || !(await requireOrganizationManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot assign organization units in this workspace." });
    return;
  }
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const fields = ["departmentId", "locationId", "managerId"] as const;
  if (!fields.some((field) => Object.hasOwn(body, field))) {
    res.status(400).json({ error: "At least one organization assignment is required." });
    return;
  }
  const parseNullableId = (value: unknown): number | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const departmentId = parseNullableId(body.departmentId);
  const locationId = parseNullableId(body.locationId);
  const managerId = body.managerId === undefined
    ? undefined
    : body.managerId === null || body.managerId === ""
      ? null
      : typeof body.managerId === "string" ? body.managerId : undefined;
  if ((Object.hasOwn(body, "departmentId") && departmentId === undefined)
    || (Object.hasOwn(body, "locationId") && locationId === undefined)
    || (Object.hasOwn(body, "managerId") && managerId === undefined)) {
    res.status(400).json({ error: "Organization assignments must use valid IDs." });
    return;
  }
  const [employee] = await db.select().from(employeeProfilesTable).where(and(
    eq(employeeProfilesTable.communityId, communityId),
    eq(employeeProfilesTable.userId, employeeId),
  ));
  if (!employee) {
    res.status(404).json({ error: "Employee profile not found." });
    return;
  }
  if (departmentId !== undefined && departmentId !== null) {
    const [department] = await db.select({ id: departmentsTable.id }).from(departmentsTable).where(and(
      eq(departmentsTable.id, departmentId),
      eq(departmentsTable.communityId, communityId),
    ));
    if (!department) {
      res.status(400).json({ error: "Department does not belong to this workspace." });
      return;
    }
  }
  if (locationId !== undefined && locationId !== null) {
    const [location] = await db.select({ id: locationsTable.id }).from(locationsTable).where(and(
      eq(locationsTable.id, locationId),
      eq(locationsTable.communityId, communityId),
    ));
    if (!location) {
      res.status(400).json({ error: "Location does not belong to this workspace." });
      return;
    }
  }
  if (managerId !== undefined && managerId !== null) {
    const [manager] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
      .innerJoin(employeeProfilesTable, and(
        eq(employeeProfilesTable.communityId, communityMembersTable.communityId),
        eq(employeeProfilesTable.userId, communityMembersTable.userId),
      ))
      .where(and(
        eq(communityMembersTable.communityId, communityId),
        eq(communityMembersTable.userId, managerId),
        eq(employeeProfilesTable.employmentStatus, "active"),
      ));
    if (!manager || managerId === employeeId) {
      res.status(400).json({ error: "Manager must be another active workspace employee." });
      return;
    }
  }
  const [updated] = await db.update(employeeProfilesTable).set({
    ...(departmentId === undefined ? {} : { departmentId }),
    ...(locationId === undefined ? {} : { locationId }),
    ...(managerId === undefined ? {} : { managerId }),
  }).where(and(
    eq(employeeProfilesTable.communityId, communityId),
    eq(employeeProfilesTable.userId, employeeId),
  )).returning();
  await writeCommunityAudit(userId, "assigned_employee_organization", communityId, {
    resourceType: "employee",
    resourceId: employeeId,
    targetId: employeeId,
    details: JSON.stringify({
      departmentId: updated?.departmentId ?? null,
      locationId: updated?.locationId ?? null,
      managerId: updated?.managerId ?? null,
    }),
  });
  res.json(updated);
});

router.put("/communities/:communityId/teams/:teamId/members/:memberId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const teamId = Number(param(req, "teamId"));
  const memberId = param(req, "memberId");
  if (!Number.isInteger(communityId) || !(await requireOrganizationManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot assign organization units in this workspace." });
    return;
  }
  if (!Number.isSafeInteger(teamId) || teamId <= 0) {
    res.status(400).json({ error: "Invalid team." });
    return;
  }
  const [team] = await db.select({ id: teamsTable.id }).from(teamsTable).where(and(
    eq(teamsTable.id, teamId),
    eq(teamsTable.communityId, communityId),
  ));
  const [member] = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
    .innerJoin(employeeProfilesTable, and(
      eq(employeeProfilesTable.communityId, communityMembersTable.communityId),
      eq(employeeProfilesTable.userId, communityMembersTable.userId),
    ))
    .where(and(
      eq(communityMembersTable.communityId, communityId),
      eq(communityMembersTable.userId, memberId),
      eq(employeeProfilesTable.employmentStatus, "active"),
    ));
  if (!team || !member) {
    res.status(404).json({ error: "Team or employee not found in this workspace." });
    return;
  }
  const role = typeof req.body?.role === "string" ? req.body.role : "member";
  const status = typeof req.body?.status === "string" ? req.body.status : "active";
  if (!["member", "lead", "manager"].includes(role) || !["active", "inactive"].includes(status)) {
    res.status(400).json({ error: "Invalid team membership." });
    return;
  }
  if (status === "active") {
    try { await assertDeletionEligibleUser(memberId); } catch {
      res.status(409).json({ error: "This account is pending deletion and cannot receive team access." });
      return;
    }
  }
  const [membership] = await db.insert(teamMembersTable).values({
    teamId,
    userId: memberId,
    role,
    status,
    endedAt: status === "active" ? null : new Date(),
  }).onConflictDoUpdate({
    target: [teamMembersTable.teamId, teamMembersTable.userId],
    set: { role, status, endedAt: status === "active" ? null : new Date() },
  }).returning();
  await writeCommunityAudit(userId, "assigned_employee_team", communityId, {
    resourceType: "team_membership",
    resourceId: `${teamId}:${memberId}`,
    targetId: memberId,
    details: `${memberId} → team ${teamId} (${role}, ${status})`,
  });
  res.json(membership);
});

router.delete("/communities/:communityId/teams/:teamId/members/:memberId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const teamId = Number(param(req, "teamId"));
  const memberId = param(req, "memberId");
  if (!Number.isInteger(communityId) || !(await requireOrganizationManager(userId, communityId))) {
    res.status(403).json({ error: "You cannot assign organization units in this workspace." });
    return;
  }
  const [team] = await db.select({ id: teamsTable.id }).from(teamsTable).where(and(
    eq(teamsTable.id, teamId),
    eq(teamsTable.communityId, communityId),
  ));
  if (!team) {
    res.status(404).json({ error: "Team not found in this workspace." });
    return;
  }
  const deleted = await db.delete(teamMembersTable).where(and(
    eq(teamMembersTable.teamId, teamId),
    eq(teamMembersTable.userId, memberId),
  )).returning();
  if (!deleted.length) {
    res.status(404).json({ error: "Team membership not found." });
    return;
  }
  await writeCommunityAudit(userId, "removed_employee_team", communityId, {
    resourceType: "team_membership",
    resourceId: `${teamId}:${memberId}`,
    targetId: memberId,
    details: `${memberId} ← team ${teamId}`,
  });
  res.json({ ok: true });
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
  const [community] = await db.select({ plan: communitiesTable.plan })
    .from(communitiesTable)
    .where(eq(communitiesTable.id, communityId))
    .limit(1);
  const invitationRole = community?.plan === "free_community" ? "member" : role;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "A valid employee email is required." });
    return;
  }
  if (!invitationRoles.includes(role as typeof invitationRoles[number])) {
    res.status(400).json({ error: "Invitation role must be member, employee, or contractor." });
    return;
  }
  const rawToken = randomUUID();
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const [existingPending] = await db.select().from(workspaceInvitationsTable).where(and(
    eq(workspaceInvitationsTable.communityId, communityId),
    eq(workspaceInvitationsTable.email, email),
    eq(workspaceInvitationsTable.status, "pending"),
  ));
  const [invitation] = existingPending
    ? await db.update(workspaceInvitationsTable).set({
      role: invitationRole,
      invitedBy: userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
    }).where(eq(workspaceInvitationsTable.id, existingPending.id)).returning()
    : await db.insert(workspaceInvitationsTable).values({
      communityId,
      email,
      role: invitationRole,
      invitedBy: userId,
      tokenHash,
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
    const [lockedUser] = await tx.select({ deletionStatus: usersTable.deletionStatus }).from(usersTable)
      .where(eq(usersTable.clerkId, userId)).for("update");
    if (!lockedUser || lockedUser.deletionStatus === "pending" || lockedUser.deletionStatus === "completed") {
      throw new Error("Account deletion is pending or completed.");
    }
    await assertDeletionEligibleUser(userId, tx);
    const [lockedInvitation] = await tx.select().from(workspaceInvitationsTable).where(and(
      eq(workspaceInvitationsTable.id, invitation.id),
      eq(workspaceInvitationsTable.communityId, communityId),
      eq(workspaceInvitationsTable.tokenHash, tokenHash),
    )).for("update");
    if (
      !lockedInvitation
      || lockedInvitation.status !== "pending"
      || lockedInvitation.expiresAt <= now
    ) {
      return { status: "unavailable" as const };
    }
    const [departments, locations, teams] = await Promise.all([
      lockedInvitation.departmentId
        ? tx.select({ id: departmentsTable.id }).from(departmentsTable).where(and(
          eq(departmentsTable.id, lockedInvitation.departmentId),
          eq(departmentsTable.communityId, communityId),
        ))
        : Promise.resolve([]),
      lockedInvitation.locationId
        ? tx.select({ id: locationsTable.id }).from(locationsTable).where(and(
          eq(locationsTable.id, lockedInvitation.locationId),
          eq(locationsTable.communityId, communityId),
        ))
        : Promise.resolve([]),
      lockedInvitation.teamId
        ? tx.select({ id: teamsTable.id }).from(teamsTable).where(and(
          eq(teamsTable.id, lockedInvitation.teamId),
          eq(teamsTable.communityId, communityId),
        ))
        : Promise.resolve([]),
    ]);
    if (
      (lockedInvitation.departmentId && departments.length === 0)
      || (lockedInvitation.locationId && locations.length === 0)
      || (lockedInvitation.teamId && teams.length === 0)
    ) {
      return { status: "invalid_scope" as const };
    }
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
      departmentId: lockedInvitation.departmentId,
      locationId: lockedInvitation.locationId,
      invitedAt: now,
      onboardingStartedAt: now,
    }).onConflictDoUpdate({
      target: [employeeProfilesTable.communityId, employeeProfilesTable.userId],
      set: {
        employmentStatus: "onboarding",
        departmentId: lockedInvitation.departmentId,
        locationId: lockedInvitation.locationId,
        invitedAt: now,
        onboardingStartedAt: now,
      },
    });
    if (lockedInvitation.teamId) {
      await tx.insert(teamMembersTable).values({ teamId: lockedInvitation.teamId, userId }).onConflictDoNothing();
    }
    if (lockedInvitation.role !== "member") {
      await tx.insert(userRolesTable).values({
        userId,
        role: lockedInvitation.role,
        scopeType: "community",
        communityId,
        grantedBy: lockedInvitation.invitedBy,
      }).onConflictDoNothing();
    }
    return { status: "accepted" as const, invitation: accepted };
  });
  if (result.status === "invalid_scope") {
    res.status(409).json({ error: "This invitation contains organization assignments from another workspace." });
    return;
  }
  if (result.status === "unavailable") {
    res.status(409).json({ error: "Invitation is no longer available." });
    return;
  }
  await writeCommunityAudit(userId, "accepted_workspace_invitation", communityId, `invitation:${result.invitation.id}`);
  res.json({ ok: true, communityId, invitationId: result.invitation.id, employmentStatus: "onboarding" });
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
  if (!Number.isInteger(communityId)) { res.status(400).json({ error: "Invalid workspace." }); return; }
  if (!targetUserId || targetUserId === userId) {
    res.status(400).json({ error: "Choose another workspace member as the new owner." });
    return;
  }
  try {
    await db.transaction(async (tx) => {
    const [lockedCommunity] = await tx.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId)).for("update");
    const [target] = await tx.select({ deletionStatus: usersTable.deletionStatus }).from(communityMembersTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
      .where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, targetUserId))).for("update");
    if (!lockedCommunity || lockedCommunity.ownerId !== userId) throw new Error("Only the workspace owner can transfer ownership.");
    if (!target || target.deletionStatus !== "none") throw new Error("The new owner must be an active workspace member.");
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
    }, { isolationLevel: "serializable" });
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : "Ownership transfer was rejected." });
    return;
  }
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
   if (!isValidUploadedObjectPath(objectPath) || !fileName || fileName.includes("/") || fileName.includes("\\") || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 25_000_000) {
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
   if (!isValidUploadedObjectPath(objectPath) || !fileName || fileName.includes("/") || fileName.includes("\\") || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 25_000_000) {
    res.status(400).json({ error: "A valid uploaded file is required." });
    return;
  }
  const version = await db.transaction(async (tx) => {
    const [lockedDocument] = await tx.select({ id: businessDocumentsTable.id }).from(businessDocumentsTable)
      .where(and(
        eq(businessDocumentsTable.id, documentId),
        eq(businessDocumentsTable.communityId, communityId),
      ))
      .for("update");
    if (!lockedDocument) return null;
    const [latest] = await tx.select({ version: documentVersionsTable.version }).from(documentVersionsTable)
      .where(eq(documentVersionsTable.documentId, documentId))
      .orderBy(desc(documentVersionsTable.version))
      .limit(1);
    const [inserted] = await tx.insert(documentVersionsTable).values({
      documentId,
      version: (latest?.version ?? 0) + 1,
      objectPath,
      fileName,
      contentType,
      fileSize,
      uploadedBy: userId,
    }).returning();
    await tx.update(businessDocumentsTable).set({ updatedAt: new Date() })
      .where(eq(businessDocumentsTable.id, documentId));
    return inserted;
  });
  if (!version) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
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

router.delete("/communities/:communityId/categories/:categoryId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const categoryId = Number(param(req, "categoryId"));
  if (!Number.isInteger(communityId) || !Number.isInteger(categoryId) || !(await communityPermission(userId, communityId, "manage_community"))) {
    res.status(403).json({ error: "You cannot delete categories in this community." });
    return;
  }
  const [category] = await db.select({ id: categoriesTable.id, name: categoriesTable.name })
    .from(categoriesTable)
    .where(and(eq(categoriesTable.id, categoryId), eq(categoriesTable.communityId, communityId)));
  if (!category) {
    res.status(404).json({ error: "Category not found." });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.update(channelsTable)
      .set({ categoryId: null })
      .where(and(eq(channelsTable.communityId, communityId), eq(channelsTable.categoryId, categoryId)));
    await tx.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
  });
  await writeCommunityAudit(userId, "deleted_community_category", communityId, category.name);
  res.json({ ok: true, categoryId });
});

router.delete("/communities/:communityId/categories/:categoryId/with-channels", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const categoryId = Number(param(req, "categoryId"));
  const confirmation = deletionConfirmation(req.body);
  if (!Number.isInteger(communityId) || !Number.isInteger(categoryId) || confirmation === null) {
    res.status(400).json({ error: "Confirmation is required." });
    return;
  }
  const [community] = await db.select({ ownerId: communitiesTable.ownerId, name: communitiesTable.name })
    .from(communitiesTable).where(eq(communitiesTable.id, communityId));
  if (!community || !exactCommunityOwner(community.ownerId, userId)) {
    res.status(403).json({ error: "Only the exact workspace owner can delete a category and all of its channels." });
    return;
  }
  const removedChannelIds: number[] = [];
  const objectPaths: string[] = [];
  const deletion = await db.transaction(async (tx) => {
    const [lockedCommunity] = await tx.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId)).for("update");
    if (!lockedCommunity || !exactCommunityOwner(lockedCommunity.ownerId, userId)) return { outcome: "forbidden" } as const;
    const [category] = await tx.select({ id: categoriesTable.id, name: categoriesTable.name }).from(categoriesTable)
      .where(and(eq(categoriesTable.id, categoryId), eq(categoriesTable.communityId, communityId))).for("update");
    if (!category) return { outcome: "not_found" } as const;
    if (!confirmationMatches(
      "DELETE CATEGORY {target} AND CHANNELS FROM WORKSPACE {workspace}",
      confirmation,
      category.name,
      community.name,
    )) return { outcome: "confirmation", category } as const;
    const channels = await tx.select({ id: channelsTable.id }).from(channelsTable)
      .where(and(eq(channelsTable.communityId, communityId), eq(channelsTable.categoryId, categoryId)));
    removedChannelIds.push(...channels.map(({ id }) => id));
    if (removedChannelIds.length) {
      const requests = await tx.select({ id: channelJoinRequestsTable.id }).from(channelJoinRequestsTable)
        .where(inArray(channelJoinRequestsTable.channelId, removedChannelIds));
      await tx.delete(notificationsTable).where(and(
        eq(notificationsTable.entityType, "channel"),
        inArray(notificationsTable.entityId, removedChannelIds.map(String)),
      ));
      if (requests.length) {
        await tx.delete(notificationsTable).where(and(
          eq(notificationsTable.entityType, "channel_join_request"),
          inArray(notificationsTable.entityId, requests.map(({ id }) => String(id))),
        ));
      }
      await tx.delete(channelJoinRequestsTable).where(inArray(channelJoinRequestsTable.channelId, removedChannelIds));
      await tx.delete(channelInvitesTable).where(inArray(channelInvitesTable.channelId, removedChannelIds));
      await tx.delete(channelBansTable).where(inArray(channelBansTable.channelId, removedChannelIds));
      const messages = await tx.select({ id: messagesTable.id }).from(messagesTable)
        .where(inArray(messagesTable.channelId, removedChannelIds));
      if (messages.length) {
        const messageIds = messages.map(({ id }) => id);
        const paths = await tx.select({ objectPath: messageAttachmentsTable.objectPath }).from(messageAttachmentsTable)
          .where(inArray(messageAttachmentsTable.messageId, messageIds));
        objectPaths.push(...paths.map(({ objectPath }) => objectPath));
        await enqueueObjectDeletionJobs(tx, paths.map(({ objectPath }) => objectPath), `category:${categoryId}`);
        await tx.delete(messageAttachmentsTable).where(inArray(messageAttachmentsTable.messageId, messageIds));
        await tx.delete(messageReactionsTable).where(inArray(messageReactionsTable.messageId, messageIds));
      }
      await tx.delete(channelMembersTable).where(inArray(channelMembersTable.channelId, removedChannelIds));
      await tx.delete(messagesTable).where(inArray(messagesTable.channelId, removedChannelIds));
      await tx.delete(channelsTable).where(inArray(channelsTable.id, removedChannelIds));
    }
    await tx.delete(categoriesTable).where(eq(categoriesTable.id, categoryId));
    return { outcome: "deleted", category } as const;
  });
  if (deletion.outcome === "forbidden") {
    res.status(403).json({ error: "You cannot delete this category and its channels." });
    return;
  }
  if (deletion.outcome === "not_found") {
    res.status(404).json({ error: "Category not found." });
    return;
  }
  if (deletion.outcome === "confirmation") {
    res.status(400).json({ error: "Confirmation does not match.", requiredConfirmation: `DELETE CATEGORY ${deletion.category.name} AND CHANNELS FROM WORKSPACE ${community.name}` });
    return;
  }
  for (const channelId of removedChannelIds) wsHub.broadcastChannelRemoved(channelId);
  await writeCommunityAudit(userId, "deleted_community_category_with_channels", communityId, deletion.category.name);
  res.json({
    ok: true,
    categoryId,
    deletedChannelCount: removedChannelIds.length,
    cleanupPending: objectPaths.length > 0,
    cleanupPendingCount: new Set(objectPaths).size,
  });
});

router.delete("/communities/:communityId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actorId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const confirmation = deletionConfirmation(req.body);
  if (!Number.isInteger(communityId) || confirmation === null) { res.status(400).json({ error: "Confirmation is required." }); return; }
  const [community] = await db.select().from(communitiesTable).where(eq(communitiesTable.id, communityId));
  if (!community) { res.status(404).json({ error: "Workspace not found." }); return; }
  if (!exactCommunityOwner(community.ownerId, actorId)) { res.status(403).json({ error: "Only the exact workspace owner can delete this workspace." }); return; }
  if (!confirmationMatches(COMMUNITY_DELETION_CONFIRMATION, confirmation, community.name, community.name)) {
    res.status(400).json({ error: "Confirmation does not match.", requiredConfirmation: `DELETE WORKSPACE ${community.name}` }); return;
  }
  const removedChannelIds: number[] = [];
  const objectPaths: string[] = [];
  await db.transaction(async (tx) => {
    const [lockedCommunity] = await tx.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId)).for("update");
    if (!lockedCommunity || !exactCommunityOwner(lockedCommunity.ownerId, actorId)) throw new Error("Workspace ownership changed.");
    await tx.insert(adminAuditLogsTable).values({
      actorId, communityId: null, action: "deleted_workspace", resourceType: "workspace",
      resourceId: String(communityId), targetId: String(communityId), targetLabel: community.name,
      details: `Workspace ${community.name} deleted`,
    });
    const channels = await tx.select({ id: channelsTable.id }).from(channelsTable).where(eq(channelsTable.communityId, communityId));
    removedChannelIds.push(...channels.map((channel) => channel.id));
    const channelIds = channels.map((channel) => channel.id);
    if (channelIds.length) {
      const requests = await tx.select({ id: channelJoinRequestsTable.id }).from(channelJoinRequestsTable)
        .where(inArray(channelJoinRequestsTable.channelId, channelIds));
      if (requests.length) await tx.delete(notificationsTable).where(and(
        eq(notificationsTable.entityType, "channel_join_request"),
        inArray(notificationsTable.entityId, requests.map((row) => String(row.id))),
      ));
      await tx.delete(channelJoinRequestsTable).where(inArray(channelJoinRequestsTable.channelId, channelIds));
      await tx.delete(channelInvitesTable).where(inArray(channelInvitesTable.channelId, channelIds));
      await tx.delete(channelBansTable).where(inArray(channelBansTable.channelId, channelIds));
      const messages = await tx.select({ id: messagesTable.id }).from(messagesTable).where(inArray(messagesTable.channelId, channelIds));
      if (messages.length) {
        const messageIds = messages.map((message) => message.id);
        const attachments = await tx.select({ objectPath: messageAttachmentsTable.objectPath }).from(messageAttachmentsTable).where(inArray(messageAttachmentsTable.messageId, messageIds));
        objectPaths.push(...attachments.map((row) => row.objectPath));
        await tx.delete(messageAttachmentsTable).where(inArray(messageAttachmentsTable.messageId, messageIds));
        await tx.delete(messageReactionsTable).where(inArray(messageReactionsTable.messageId, messageIds));
      }
      await tx.delete(channelMembersTable).where(inArray(channelMembersTable.channelId, channelIds));
      await tx.delete(messagesTable).where(inArray(messagesTable.channelId, channelIds));
      await tx.delete(channelsTable).where(inArray(channelsTable.id, channelIds));
    }
    const versions = await tx.select({ objectPath: documentVersionsTable.objectPath }).from(documentVersionsTable)
      .innerJoin(businessDocumentsTable, eq(businessDocumentsTable.id, documentVersionsTable.documentId))
      .where(eq(businessDocumentsTable.communityId, communityId));
    objectPaths.push(...versions.map((row) => row.objectPath));
    const taskAttachments = await tx.select({ objectPath: workspaceTaskAttachmentsTable.objectPath }).from(workspaceTaskAttachmentsTable)
      .innerJoin(workspaceTasksTable, eq(workspaceTasksTable.id, workspaceTaskAttachmentsTable.taskId))
      .where(eq(workspaceTasksTable.communityId, communityId));
    objectPaths.push(...taskAttachments.map((row) => row.objectPath));
    const announcementAttachments = await tx.select({ objectPath: announcementAttachmentsTable.objectPath }).from(announcementAttachmentsTable)
      .innerJoin(serverAnnouncementsTable, eq(serverAnnouncementsTable.id, announcementAttachmentsTable.announcementId))
      .where(eq(serverAnnouncementsTable.communityId, communityId));
    objectPaths.push(...announcementAttachments.map((row) => row.objectPath));
    await enqueueObjectDeletionJobs(tx, objectPaths, `community:${communityId}`);
    // Community-owned audit rows are cascaded with the community. This is a
    // known retention limitation; no fake post-delete audit is emitted.
    await tx.delete(communitiesTable).where(eq(communitiesTable.id, communityId));
  });
  for (const channelId of removedChannelIds) wsHub.broadcastChannelRemoved(channelId);
  const cleanupPendingCount = [...new Set(objectPaths)].length;
  res.json({ ok: true, navigation: "/communities", cleanupPending: cleanupPendingCount > 0, cleanupPendingCount });
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

router.patch("/communities/:communityId/channels/:channelId/category", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const channelId = Number(param(req, "channelId"));
  const categoryId = req.body?.categoryId;
  if (!Number.isSafeInteger(communityId) || communityId < 1 || !Number.isSafeInteger(channelId) || channelId < 1
    || (categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId < 1))) {
    res.status(400).json({ error: "Choose a valid channel and category or unassigned." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    if (!(await hasPermission(userId, "manage_community", { communityId }, tx, true))) {
      return { outcome: "forbidden" } as const;
    }
    const [community] = await tx.select({ id: communitiesTable.id }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId)).for("share");
    if (!community) return { outcome: "not_found" } as const;
    const [channel] = await tx.select({ id: channelsTable.id }).from(channelsTable)
      .where(and(eq(channelsTable.id, channelId), eq(channelsTable.communityId, communityId)))
      .for("update");
    if (!channel) return { outcome: "not_found" } as const;
    if (categoryId !== null) {
      const [category] = await tx.select({ id: categoriesTable.id }).from(categoriesTable)
        .where(and(eq(categoriesTable.id, categoryId), eq(categoriesTable.communityId, communityId)))
        .for("share");
      if (!category) return { outcome: "wrong_workspace" } as const;
    }
    const [updated] = await tx.update(channelsTable).set({ categoryId })
      .where(eq(channelsTable.id, channelId)).returning();
    return { outcome: "updated", updated } as const;
  });
  if (result.outcome === "forbidden") {
    res.status(403).json({ error: "You cannot organize channels in this workspace." });
    return;
  }
  if (result.outcome === "not_found") {
    res.status(404).json({ error: "Channel not found in this workspace." });
    return;
  }
  if (result.outcome === "wrong_workspace") {
    res.status(400).json({ error: "Category must belong to this workspace." });
    return;
  }
  await writeCommunityAudit(userId, "moved_community_channel_category", communityId, {
    resourceType: "channel",
    resourceId: channelId,
    resourceLabel: result.updated.name,
    details: categoryId === null ? "Moved to uncategorized" : `Moved to category ${categoryId}`,
  });
  wsHub.broadcastChannel(channelId, { type: "channel", channel: { ...result.updated, passwordHash: undefined } });
  wsHub.broadcastChannelListChanged();
  res.json({ ...result.updated, passwordHash: undefined });
});

router.delete("/communities/:communityId/channels/:channelId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const channelId = Number(param(req, "channelId"));
  const confirmation = deletionConfirmation(req.body);
  if (!Number.isInteger(communityId) || !Number.isInteger(channelId) || confirmation === null) {
    res.status(403).json({ error: "You cannot delete channels in this community." });
    return;
  }
  const [community] = await db.select({ ownerId: communitiesTable.ownerId, name: communitiesTable.name })
    .from(communitiesTable).where(eq(communitiesTable.id, communityId));
  if (!community || !exactCommunityOwner(community.ownerId, userId)) {
    res.status(403).json({ error: "Only the exact workspace owner can use the workspace-console channel deletion action." });
    return;
  }
  let cleanupPendingCount = 0;
  const deletion = await db.transaction(async (tx) => {
    const [lockedCommunity] = await tx.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId)).for("update");
    if (!lockedCommunity || !exactCommunityOwner(lockedCommunity.ownerId, userId)) return { outcome: "forbidden" } as const;
    const [channel] = await tx
      .select({ id: channelsTable.id, name: channelsTable.name })
      .from(channelsTable)
      .where(and(eq(channelsTable.id, channelId), eq(channelsTable.communityId, communityId)))
      .for("update");
    if (!channel) return { outcome: "not_found" } as const;
    if (!confirmationMatches(
      MEMBER_REMOVAL_CONFIRMATION.replace("REMOVE MEMBER {target}", "DELETE CHANNEL {target}"),
      confirmation,
      channel.name,
      community.name,
    )) return { outcome: "confirmation", channel } as const;
    const requestIds = await tx
      .select({ id: channelJoinRequestsTable.id })
      .from(channelJoinRequestsTable)
      .where(eq(channelJoinRequestsTable.channelId, channelId));
    await tx.delete(notificationsTable).where(and(
      eq(notificationsTable.entityType, "channel"),
      eq(notificationsTable.entityId, String(channelId)),
    ));
    if (requestIds.length) {
      await tx.delete(notificationsTable).where(and(
        eq(notificationsTable.entityType, "channel_join_request"),
        inArray(notificationsTable.entityId, requestIds.map(({ id }) => String(id))),
      ));
    }
    await tx.delete(channelJoinRequestsTable).where(eq(channelJoinRequestsTable.channelId, channelId));
    await tx.delete(channelInvitesTable).where(eq(channelInvitesTable.channelId, channelId));
    await tx.delete(channelBansTable).where(eq(channelBansTable.channelId, channelId));
    const channelMessages = await tx.select({ id: messagesTable.id })
      .from(messagesTable)
      .where(eq(messagesTable.channelId, channelId));
    if (channelMessages.length) {
      const paths = await tx.select({ objectPath: messageAttachmentsTable.objectPath }).from(messageAttachmentsTable)
        .where(inArray(messageAttachmentsTable.messageId, channelMessages.map((message) => message.id)));
      cleanupPendingCount = new Set(paths.map((row) => row.objectPath)).size;
      await enqueueObjectDeletionJobs(tx, paths.map((row) => row.objectPath), `channel:${channelId}`);
      await tx.delete(messageAttachmentsTable).where(inArray(messageAttachmentsTable.messageId, channelMessages.map((message) => message.id)));
      await tx.delete(messageReactionsTable).where(inArray(messageReactionsTable.messageId, channelMessages.map((message) => message.id)));
    }
    await tx.delete(channelMembersTable).where(eq(channelMembersTable.channelId, channelId));
    await tx.delete(messagesTable).where(eq(messagesTable.channelId, channelId));
    const [deleted] = await tx
      .delete(channelsTable)
      .where(and(eq(channelsTable.id, channelId), eq(channelsTable.communityId, communityId)))
      .returning({ id: channelsTable.id });
    return deleted
      ? { outcome: "deleted", channel } as const
      : { outcome: "not_found" } as const;
  });
  if (deletion.outcome === "forbidden") {
    res.status(403).json({ error: "You cannot delete channels in this community." });
    return;
  }
  if (deletion.outcome === "confirmation") {
    res.status(400).json({ error: "Confirmation does not match.", requiredConfirmation: `DELETE CHANNEL ${deletion.channel?.name ?? "channel"} FROM WORKSPACE ${community.name}` });
    return;
  }
  if (deletion.outcome === "not_found") {
    res.status(404).json({ error: "Channel not found." });
    return;
  }
  wsHub.broadcastChannelRemoved(channelId);
  await writeCommunityAudit(userId, "deleted_community_channel", communityId, deletion.channel.name);
  res.json({ ok: true, channelId, cleanupPending: cleanupPendingCount > 0, cleanupPendingCount });
});

/**
 * Destructive member operations deliberately do not use hasPermission: platform
 * and workspace-manager roles must not be able to invoke these owner actions.
 */
router.delete("/communities/:communityId/members/:memberId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actorId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const memberId = param(req, "memberId");
  const confirmation = deletionConfirmation(req.body);
  if (!Number.isInteger(communityId) || confirmation === null) {
    res.status(400).json({ error: "Confirmation is required." });
    return;
  }
  const [community] = await db.select().from(communitiesTable).where(eq(communitiesTable.id, communityId));
  if (!community) { res.status(404).json({ error: "Workspace not found." }); return; }
  if (!exactCommunityOwner(community.ownerId, actorId)) {
    res.status(403).json({ error: "Only the exact workspace owner can remove members." });
    return;
  }
  const [target] = await db.select().from(usersTable).where(eq(usersTable.clerkId, memberId));
  if (!target) { res.status(404).json({ error: "Member not found." }); return; }
  if (memberId === actorId || memberId === community.ownerId) {
    res.status(400).json({ error: "The workspace owner cannot remove themselves or the workspace owner." });
    return;
  }
  if (!confirmationMatches(MEMBER_REMOVAL_CONFIRMATION, confirmation, target.displayName, community.name)) {
    res.status(400).json({ error: "Confirmation does not match.", requiredConfirmation: `REMOVE MEMBER ${target.displayName} FROM WORKSPACE ${community.name}` });
    return;
  }
  const removed = await db.transaction(async (tx) => {
    const [lockedCommunity] = await tx.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId)).for("update");
    if (!lockedCommunity || !exactCommunityOwner(lockedCommunity.ownerId, actorId)) return false;
    const [membership] = await tx.select().from(communityMembersTable).where(and(
      eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, memberId),
    )).for("update");
    if (!membership) return false;
    const workspaceChannels = await tx.select({ id: channelsTable.id }).from(channelsTable)
      .where(eq(channelsTable.communityId, communityId));
    const channels = await tx.select({ id: channelsTable.id }).from(channelsTable)
      .where(and(eq(channelsTable.communityId, communityId), eq(channelsTable.ownerId, memberId)));
    const categories = await tx.select({ id: categoriesTable.id }).from(categoriesTable)
      .where(and(eq(categoriesTable.communityId, communityId), eq(categoriesTable.ownerId, memberId)));
    if (channels.length) {
      await tx.update(channelsTable).set({ ownerId: community.ownerId })
        .where(inArray(channelsTable.id, channels.map((row) => row.id)));
      await tx.insert(channelMembersTable).values(channels.map((row) => ({
        channelId: row.id, userId: community.ownerId, role: "owner",
      }))).onConflictDoUpdate({ target: [channelMembersTable.channelId, channelMembersTable.userId], set: { role: "owner" } });
    }
    if (categories.length) await tx.update(categoriesTable).set({ ownerId: community.ownerId })
      .where(inArray(categoriesTable.id, categories.map((row) => row.id)));
    if (workspaceChannels.length) {
      const channelIds = workspaceChannels.map((row) => row.id);
      await tx.delete(channelMembersTable).where(and(eq(channelMembersTable.userId, memberId), inArray(channelMembersTable.channelId, channelIds)));
      await tx.delete(channelBansTable).where(and(eq(channelBansTable.userId, memberId), inArray(channelBansTable.channelId, channelIds)));
      await tx.delete(channelJoinRequestsTable).where(and(eq(channelJoinRequestsTable.userId, memberId), inArray(channelJoinRequestsTable.channelId, channelIds)));
      await tx.delete(channelInvitesTable).where(and(eq(channelInvitesTable.userId, memberId), inArray(channelInvitesTable.channelId, channelIds)));
    }
    const workspaceTeams = await tx.select({ id: teamsTable.id }).from(teamsTable).where(eq(teamsTable.communityId, communityId));
    if (workspaceTeams.length) await tx.delete(teamMembersTable).where(and(eq(teamMembersTable.userId, memberId), inArray(teamMembersTable.teamId, workspaceTeams.map((row) => row.id))));
    await tx.delete(userRolesTable).where(and(eq(userRolesTable.userId, memberId), eq(userRolesTable.communityId, communityId)));
    await tx.delete(notificationsTable).where(and(eq(notificationsTable.userId, memberId), eq(notificationsTable.communityId, communityId)));
    const policies = await tx.select({ id: workspacePoliciesTable.id }).from(workspacePoliciesTable).where(eq(workspacePoliciesTable.communityId, communityId));
    if (policies.length) await tx.delete(policyAcknowledgementsTable).where(and(eq(policyAcknowledgementsTable.userId, memberId), inArray(policyAcknowledgementsTable.policyId, policies.map((row) => row.id))));
    const documents = await tx.select({ id: businessDocumentsTable.id }).from(businessDocumentsTable).where(eq(businessDocumentsTable.communityId, communityId));
    if (documents.length) {
      const documentIds = documents.map((row) => row.id);
      await tx.delete(documentPermissionsTable).where(and(eq(documentPermissionsTable.userId, memberId), inArray(documentPermissionsTable.documentId, documentIds)));
      await tx.delete(documentAcknowledgementsTable).where(and(eq(documentAcknowledgementsTable.userId, memberId), inArray(documentAcknowledgementsTable.documentId, documentIds)));
      await tx.delete(documentDownloadsTable).where(and(eq(documentDownloadsTable.userId, memberId), inArray(documentDownloadsTable.documentId, documentIds)));
    }
    await tx.delete(employeeProfilesTable).where(and(eq(employeeProfilesTable.userId, memberId), eq(employeeProfilesTable.communityId, communityId)));
    await tx.update(workspaceInvitationsTable).set({ invitedUserId: null })
      .where(and(eq(workspaceInvitationsTable.communityId, communityId), eq(workspaceInvitationsTable.invitedUserId, memberId)));
    await tx.update(departmentsTable).set({ managerId: null }).where(and(eq(departmentsTable.communityId, communityId), eq(departmentsTable.managerId, memberId)));
    await tx.update(teamsTable).set({ managerId: null }).where(and(eq(teamsTable.communityId, communityId), eq(teamsTable.managerId, memberId)));
    await tx.delete(communityMembersTable).where(and(eq(communityMembersTable.communityId, communityId), eq(communityMembersTable.userId, memberId)));
    return true;
  });
  if (!removed) { res.status(404).json({ error: "Member is not in this workspace." }); return; }
  const channelIds = (await db.select({ id: channelsTable.id }).from(channelsTable).where(eq(channelsTable.communityId, communityId))).map((row) => row.id);
  wsHub.revokeUserChannelAccess(channelIds, memberId);
  for (const channelId of channelIds) wsHub.broadcastChannel(channelId, { type: "presence", action: "leave", channelId, userId: memberId });
  wsHub.broadcastUser(memberId, { type: "workspace_membership_removed", communityId });
  await writeCommunityAudit(actorId, "removed_workspace_member", communityId, {
    resourceType: "member", resourceId: memberId, targetId: memberId, targetLabel: target.displayName,
  });
  res.json({ ok: true, communityId, memberId });
});

router.delete("/communities/:communityId/members/:memberId/account", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const actorId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const memberId = param(req, "memberId");
  const confirmation = deletionConfirmation(req.body);
  if (!Number.isInteger(communityId) || confirmation === null) { res.status(400).json({ error: "Confirmation is required." }); return; }
  const [community] = await db.select().from(communitiesTable).where(eq(communitiesTable.id, communityId));
  const [target] = await db.select().from(usersTable).where(eq(usersTable.clerkId, memberId));
  if (!community || !target) { res.status(404).json({ error: "Workspace or member not found." }); return; }
  if (!exactCommunityOwner(community.ownerId, actorId)) { res.status(403).json({ error: "Only the exact workspace owner can delete accounts." }); return; }
  if (memberId === actorId || memberId === community.ownerId) { res.status(400).json({ error: "The workspace owner cannot delete themselves or the workspace owner." }); return; }
  if (!confirmationMatches(ACCOUNT_DELETION_CONFIRMATION, confirmation, target.displayName, community.name)) {
    res.status(400).json({ error: "Confirmation does not match.", requiredConfirmation: `DELETE ACCOUNT ${target.displayName} FROM WORKSPACE ${community.name}` }); return;
  }
  const [targetMemberships, targetOwned] = await Promise.all([
    db.select({ communityId: communityMembersTable.communityId }).from(communityMembersTable).where(eq(communityMembersTable.userId, memberId)),
    db.select({ id: communitiesTable.id }).from(communitiesTable).where(eq(communitiesTable.ownerId, memberId)),
  ]);
  if (!targetMemberships.some((row) => row.communityId === communityId) && target.deletionStatus !== "pending") {
    res.status(404).json({ error: "Member is not in this workspace." }); return;
  }
  const requesterOwned = await db.select({ id: communitiesTable.id }).from(communitiesTable).where(eq(communitiesTable.ownerId, actorId));
  if (!targetMayBePermanentlyDeleted(targetMemberships.map((row) => row.communityId), targetOwned.map((row) => row.id), requesterOwned.map((row) => row.id))) {
    res.status(409).json({ error: "This account belongs to another workspace or owns a workspace; use workspace-only member removal." }); return;
  }
  await db.transaction(async (tx) => {
    const [lockedCommunity] = await tx.select({ ownerId: communitiesTable.ownerId }).from(communitiesTable)
      .where(eq(communitiesTable.id, communityId)).for("update");
    if (!lockedCommunity || !exactCommunityOwner(lockedCommunity.ownerId, actorId)) throw new Error("Ownership changed.");
    const [lockedTarget] = await tx.select({ accountStatus: usersTable.accountStatus }).from(usersTable)
      .where(eq(usersTable.clerkId, memberId)).for("update");
    if (!lockedTarget) throw new Error("Member disappeared.");
    const lockedMemberships = await tx.select({ communityId: communityMembersTable.communityId }).from(communityMembersTable)
      .where(eq(communityMembersTable.userId, memberId)).for("update");
    const lockedOwned = await tx.select({ id: communitiesTable.id }).from(communitiesTable)
      .where(eq(communitiesTable.ownerId, memberId)).for("update");
    const lockedRequesterOwned = await tx.select({ id: communitiesTable.id }).from(communitiesTable)
      .where(eq(communitiesTable.ownerId, actorId)).for("update");
    if (!targetMayBePermanentlyDeleted(
      lockedMemberships.map((row) => row.communityId),
      lockedOwned.map((row) => row.id),
      lockedRequesterOwned.map((row) => row.id),
    ) && target.deletionStatus !== "pending") throw new Error("Account deletion eligibility changed.");
    await tx.insert(adminAuditLogsTable).values({
      actorId, communityId, action: "requested_account_deletion", resourceType: "user",
      resourceId: memberId, targetId: memberId, targetLabel: target.displayName,
      details: "Account deletion initiated; Clerk revocation pending.",
    });
    await tx.update(usersTable).set({
      deletionStatus: "pending", deletionRequestedAt: new Date(), accountStatus: "suspended",
      clerkDeletionStatus: "pending", clerkDeletionLastError: null,
    })
      .where(eq(usersTable.clerkId, memberId));
    await tx.delete(communityMembersTable).where(eq(communityMembersTable.userId, memberId));
    await tx.delete(userRolesTable).where(eq(userRolesTable.userId, memberId));
    await tx.delete(channelMembersTable).where(eq(channelMembersTable.userId, memberId));
     await tx.delete(teamMembersTable).where(eq(teamMembersTable.userId, memberId));
  }, { isolationLevel: "serializable" });
  wsHub.disconnectUser(memberId, "Account access revoked.");
  const finalization = await finalizePendingAccountDeletion(memberId);
  if (finalization === "retryable") {
    res.status(502).json({ error: "Clerk deletion failed; the pending deletion will be retried.", retryable: true, pending: true });
    return;
  }
  res.json({ ok: true, pending: finalization !== "completed", navigation: `/communities/${communityId}` });
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
  await ensureProfile(userId);
  const result = await db.transaction(async (tx) => {
    const orderedUserIds = [...new Set([userId, memberId])].sort();
    await tx.select({ clerkId: usersTable.clerkId })
      .from(usersTable)
      .where(inArray(usersTable.clerkId, orderedUserIds))
      .for("update");

    if (!(await hasPermission(userId, "manage_community_members", { communityId }, tx, true))) {
      return { outcome: "forbidden" } as const;
    }

    const [actor] = await tx.select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.clerkId, userId))
      .for("update");
    if (!actor) {
      return { outcome: "forbidden" } as const;
    }
    if (actor.role !== "admin") {
      const actorAssignments = await tx.select({ role: userRolesTable.role })
        .from(userRolesTable)
        .where(and(
          eq(userRolesTable.userId, userId),
          eq(userRolesTable.communityId, communityId),
        ))
        .for("update");
      if (!canGrantWorkspaceRole(
        actorAssignments.map((assignment) => assignment.role),
        role,
      )) {
        return { outcome: "rank_forbidden" } as const;
      }
    }

    const [member] = await tx.select({ userId: communityMembersTable.userId })
      .from(communityMembersTable)
      .where(and(
        eq(communityMembersTable.communityId, communityId),
        eq(communityMembersTable.userId, memberId),
      ))
      .for("share");
    if (!member) {
      return { outcome: "not_found" } as const;
    }
    try {
      await assertDeletionEligibleUser(memberId, tx);
    } catch {
      return { outcome: "pending_deletion" } as const;
    }

    await tx.delete(userRolesTable).where(and(
      eq(userRolesTable.userId, memberId),
      eq(userRolesTable.communityId, communityId),
      eq(userRolesTable.scopeType, "community"),
    ));
    if (role !== "member") {
      await tx.insert(userRolesTable).values({
        userId: memberId,
        role,
        scopeType: "community",
        communityId,
        grantedBy: userId,
      });
    }
    const [targetProfile] = await tx.select({
      displayName: usersTable.displayName,
    }).from(usersTable).where(eq(usersTable.clerkId, memberId)).limit(1);
    const [targetEmployee] = await tx.select({
      departmentId: employeeProfilesTable.departmentId,
      locationId: employeeProfilesTable.locationId,
    }).from(employeeProfilesTable).where(and(
      eq(employeeProfilesTable.communityId, communityId),
      eq(employeeProfilesTable.userId, memberId),
    )).limit(1);
    return { outcome: "updated", targetProfile, targetEmployee } as const;
  });

  if (result.outcome === "forbidden") {
    res.status(403).json({ error: "You cannot manage members in this community." });
    return;
  }
  if (result.outcome === "rank_forbidden") {
    res.status(403).json({ error: "You can only assign roles below your own workspace role." });
    return;
  }
  if (result.outcome === "not_found") {
    res.status(404).json({ error: "Community member not found." });
    return;
  }
  if (result.outcome === "pending_deletion") {
    res.status(409).json({ error: "This account is pending deletion and cannot receive roles." });
    return;
  }
  await writeCommunityAudit(userId, "changed_community_role", communityId, {
    resourceType: "employee",
    resourceId: memberId,
    resourceLabel: result.targetProfile?.displayName ?? memberId,
    departmentId: result.targetEmployee?.departmentId,
    locationId: result.targetEmployee?.locationId,
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
  const { announcement, notifications } = await db.transaction(async (tx) => {
    const [announcement] = await tx.insert(serverAnnouncementsTable).values({
      authorId: userId, communityId, title, body, audienceType, departmentId, locationId, teamId, recipientId,
      requiresAcknowledgement, scheduledAt, expiresAt, status: isScheduled ? "scheduled" : "published",
    }).returning();
    const recipients = audienceType === "company"
      ? await tx.select({ userId: communityMembersTable.userId }).from(communityMembersTable).where(eq(communityMembersTable.communityId, communityId))
      : audienceType === "department"
        ? await tx.select({ userId: employeeProfilesTable.userId }).from(employeeProfilesTable).where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.departmentId, departmentId!)))
        : audienceType === "location"
          ? await tx.select({ userId: employeeProfilesTable.userId }).from(employeeProfilesTable).where(and(eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.locationId, locationId!)))
          : audienceType === "team"
            ? await tx.select({ userId: teamMembersTable.userId }).from(teamMembersTable).innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId)).where(and(eq(teamsTable.communityId, communityId), eq(teamMembersTable.teamId, teamId!)))
            : recipientId ? [{ userId: recipientId }] : [];
    const notificationRecipients = isScheduled ? [] : [...new Set(recipients.map((recipient) => recipient.userId))];
    const announcementNotifications = notificationRecipients.length
      ? await tx.insert(notificationsTable).values(notificationRecipients.map((recipientUserId) => ({
        userId: recipientUserId,
        type: "community_announcement",
        category: "announcement",
        body: `${title}: ${body}`,
        communityId,
        entityType: "announcement",
        entityId: String(announcement.id),
        actionUrl: `/communities/${communityId}`,
      }))).returning()
      : [];

    const [actor] = await tx.select({ displayName: usersTable.displayName })
      .from(usersTable).where(eq(usersTable.clerkId, userId)).limit(1);
    const action = isScheduled ? "scheduled_community_announcement" : "published_community_announcement";
    await tx.insert(adminAuditLogsTable).values({
      actorId: userId,
      actorDisplayName: actor?.displayName,
      communityId,
      action,
      resourceType: "workspace",
      resourceId: String(communityId),
      targetId: String(communityId),
      targetLabel: `community:${communityId}`,
      details: title,
    });
    const managers = await tx.select({ userId: userRolesTable.userId }).from(userRolesTable).where(and(
      eq(userRolesTable.communityId, communityId),
      inArray(userRolesTable.role, ["workspace_owner", "workspace_admin", "community_admin", "department_admin"]),
    ));
    const managerIds = [...new Set(managers.map((manager) => manager.userId))];
    const auditNotifications = managerIds.length
      ? await tx.insert(notificationsTable).values(managerIds.map((managerId) => ({
        userId: managerId,
        type: "administrative_action",
        category: "administrative_action",
        body: `${action.replaceAll("_", " ")}: ${title}`,
        communityId,
        entityType: "community",
        entityId: String(communityId),
        actionUrl: `/communities/${communityId}`,
      }))).returning()
      : [];
    return { announcement, notifications: [...announcementNotifications, ...auditNotifications] };
  });
  for (const notification of notifications) {
    wsHub.broadcastUser(notification.userId, {
      type: "notification",
      notification: { ...notification, category: categoryForNotification(notification.type, notification.category) },
    });
  }
  res.status(201).json(announcement);
});

router.delete("/communities/:communityId/announcements/:announcementId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const communityId = Number(param(req, "communityId"));
  const announcementId = Number(param(req, "announcementId"));
  if (!Number.isInteger(communityId) || !Number.isInteger(announcementId) || !(await communityPermission(userId, communityId, "manage_community"))) {
    res.status(403).json({ error: "You cannot delete announcements in this community." });
    return;
  }
  const [announcement] = await db.select({ id: serverAnnouncementsTable.id, title: serverAnnouncementsTable.title })
    .from(serverAnnouncementsTable)
    .where(and(eq(serverAnnouncementsTable.id, announcementId), eq(serverAnnouncementsTable.communityId, communityId)));
  if (!announcement) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  await db.delete(serverAnnouncementsTable).where(eq(serverAnnouncementsTable.id, announcementId));
  await writeCommunityAudit(userId, "deleted_community_announcement", communityId, announcement.title);
  res.json({ ok: true, announcementId });
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
  const metadata = validateUploadMetadata({
    name: req.body?.fileName,
    size: req.body?.fileSize,
    contentType: req.body?.contentType,
  });
  if (!announcement) {
    res.status(404).json({ error: "Announcement not found." });
    return;
  }
  if (!isValidUploadedObjectPath(objectPath) || !metadata || metadata.size > 10_000_000) {
    res.status(400).json({ error: "Invalid announcement attachment." });
    return;
  }
  const [attachment] = await db.insert(announcementAttachmentsTable).values({ announcementId, uploaderId: userId, objectPath, fileName: metadata.name, contentType: metadata.contentType, fileSize: metadata.size }).returning();
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