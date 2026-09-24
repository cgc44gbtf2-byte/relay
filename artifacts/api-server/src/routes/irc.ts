import { Router, type IRouter, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  blocksTable,
  channelBansTable,
  channelInvitesTable,
  channelJoinRequestsTable,
  channelMembersTable,
  categoriesTable,
  channelsTable,
  communitiesTable,
  communityMembersTable,
  db,
  messageAttachmentsTable,
  messageReactionsTable,
  messagesTable,
  moderationActionsTable,
  notificationsTable,
  serverAnnouncementsTable,
  workspaceTasksTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, ensureProfile, getUserId, type AuthenticatedRequest } from "../lib/auth";
import { wsHub } from "../lib/ws";
import { canPromoteChannelModerator } from "../lib/channel-moderation-policy";
import { canReadChannel } from "../lib/channel-access";
import { isValidUploadedObjectPath, signedObjectUrlForPath, validateUploadMetadata } from "./storage";
import { channelAccessRequiredError, channelNotFoundError } from "./errors";
import { hasPermission, permissionsForCommunities } from "../lib/permissions";
import { categoryForNotification, createNotification, createNotifications, hasNotificationForEntity } from "../lib/notifications";
import { logger } from "../lib/logger";
import { isValidQuery } from "../lib/validation";
import { enqueueObjectDeletionJobs } from "../lib/object-cleanup";
import { FixedWindowLimiter, rateLimitKey } from "../lib/fixed-window-limiter";

const router: IRouter = Router();
const channelJoinLimiter = new FixedWindowLimiter(20, 60_000);
const channelInviteLimiter = new FixedWindowLimiter(30, 60_000);
const userSearchLimiter = new FixedWindowLimiter(60, 60_000);
const messageSearchLimiter = new FixedWindowLimiter(60, 60_000);
const MAX_LIST_PAGE_SIZE = 100;

function listPage(req: AuthenticatedRequest): { limit: number; offset: number } {
  const requestedLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : MAX_LIST_PAGE_SIZE;
  const requestedOffset = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
  return {
    limit: Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, MAX_LIST_PAGE_SIZE)
      : MAX_LIST_PAGE_SIZE,
    offset: Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0,
  };
}

function setListPageHeaders(res: Response, hasMore: boolean, nextOffset: number): void {
  res.set("X-Has-More", String(hasMore));
  if (hasMore) res.set("X-Next-Offset", String(nextOffset));
}

function enforceRateLimit(
  req: AuthenticatedRequest,
  res: Response,
  limiter: FixedWindowLimiter,
  message: string,
): boolean {
  const result = limiter.check(
    rateLimitKey(getUserId(req), req.ip ?? req.socket.remoteAddress ?? "unknown"),
  );
  if (result.allowed) return true;
  res
    .set("Retry-After", String(result.retryAfterSeconds))
    .status(429)
    .json({ error: message });
  return false;
}

function param(req: AuthenticatedRequest, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

const channelName = (value: string): string => {
  const name = value.trim().toLowerCase();
  return name.startsWith("#") ? name : `#${name}`;
};

const passwordHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function hasChannelPassword(channel: { passwordHash: string | null }, password: unknown): boolean {
  return !channel.passwordHash || (typeof password === "string" && passwordHash(password) === channel.passwordHash);
}

function publicChannel(channel: typeof channelsTable.$inferSelect) {
  const { passwordHash: _passwordHash, ...safeChannel } = channel;
  return safeChannel;
}

async function channelFor(id: string) {
  const channelId = Number(id);
  if (!Number.isInteger(channelId)) return null;
  return db.query.channelsTable.findFirst({ where: eq(channelsTable.id, channelId) });
}

async function ensureDefaults(ownerId: string): Promise<void> {
  const existing = await db.select({ id: channelsTable.id }).from(channelsTable).limit(1);
  if (existing.length > 0) return;
  for (const name of ["#lobby", "#design", "#help", "#music"]) {
    await db.insert(channelsTable).values({
      name,
      topic:
        name === "#lobby"
          ? "The front door of the network. Say hello."
          : "A quiet corner of the network. Make it yours.",
      ownerId,
    }).onConflictDoNothing();
  }
}

async function membership(channelId: number, userId: string) {
  return db.query.channelMembersTable.findFirst({
    where: and(
      eq(channelMembersTable.channelId, channelId),
      eq(channelMembersTable.userId, userId),
    ),
  });
}

async function sharesBusiness(firstUserId: string, secondUserId: string): Promise<boolean> {
  if (firstUserId === secondUserId) return true;
  if (await hasPermission(firstUserId, "manage_any_community")) return true;
  const memberships = await db
    .select({ communityId: communityMembersTable.communityId })
    .from(communityMembersTable)
    .where(eq(communityMembersTable.userId, firstUserId));
  if (memberships.length === 0) return false;
  const [shared] = await db
    .select({ communityId: communityMembersTable.communityId })
    .from(communityMembersTable)
    .where(and(
      eq(communityMembersTable.userId, secondUserId),
      inArray(communityMembersTable.communityId, memberships.map((item) => item.communityId)),
    ))
    .limit(1);
  return Boolean(shared);
}

async function visibleChannelIds(userId: string): Promise<number[]> {
  const channels = await db.select({
    id: channelsTable.id,
    isPrivate: channelsTable.isPrivate,
    communityId: channelsTable.communityId,
  }).from(channelsTable);
  const visible = await Promise.all(channels.map(async (channel) => (
    await canReadChannel(channel, userId) ? channel.id : null
  )));
  return visible.filter((id): id is number => id !== null);
}

async function canReadMessage(message: typeof messagesTable.$inferSelect, userId: string): Promise<boolean> {
  if (message.channelId) {
    const channel = await channelFor(String(message.channelId));
    return Boolean(channel && await canReadChannel(channel, userId));
  }
  return message.senderId === userId || message.recipientId === userId;
}

function broadcastMessageEvent(
  message: typeof messagesTable.$inferSelect,
  event: unknown,
): void {
  if (message.channelId) {
    wsHub.broadcastChannel(message.channelId, event);
    return;
  }
  wsHub.broadcastUser(message.senderId, event);
  if (message.recipientId) wsHub.broadcastUser(message.recipientId, event);
}

async function isChannelOwnerOrModerator(channelId: number, userId: string): Promise<boolean> {
  const member = await membership(channelId, userId);
  return Boolean(
    (member && ["owner", "moderator"].includes(member.role))
      || await hasPermission(userId, "manage_channel", { channelId })
      || await hasPermission(userId, "moderate_channel", { channelId }),
  );
}

async function notifyMentionedUsers(body: string, senderId: string, channelId: number | null, messageId: string): Promise<void> {
  const names = [...body.matchAll(/@([a-z0-9_]{3,24})/gi)].map((match) => match[1].toLowerCase());
  if (names.length === 0) return;
  const mentioned = await db
    .select({ clerkId: usersTable.clerkId })
    .from(usersTable)
    .where(inArray(usersTable.username, [...new Set(names)]));
  const recipients = mentioned.filter((user) => user.clerkId !== senderId);
  if (recipients.length === 0) return;
  await createNotifications(recipients.map((user) => user.clerkId), {
    type: "mention",
    category: "mention",
    body: channelId ? "You were mentioned in a channel." : "You were mentioned.",
    entityType: "message",
    entityId: messageId,
  });
}

async function publicUser(userId: string) {
  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.clerkId, userId) });
  return user
    ? { id: user.clerkId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, status: user.status }
    : null;
}

async function ensureTaskDeadlineNotifications(userId: string): Promise<void> {
  const dueBy = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tasks = await db.select({
    id: workspaceTasksTable.id,
    title: workspaceTasksTable.title,
    dueDate: workspaceTasksTable.dueDate,
    communityId: workspaceTasksTable.communityId,
  }).from(workspaceTasksTable).where(and(
    eq(workspaceTasksTable.assignedTo, userId),
    lte(workspaceTasksTable.dueDate, dueBy),
    notInArray(workspaceTasksTable.status, ["completed", "cancelled"]),
  ));
  for (const task of tasks) {
    if (await hasNotificationForEntity(userId, "task_deadline", "workspace_task", task.id)) continue;
    await createNotification({
      userId,
      type: "task_deadline",
      category: "task_deadline",
      body: `Task deadline: ${task.title} is due ${task.dueDate ? new Date(task.dueDate).toLocaleString() : "soon"}.`,
      communityId: task.communityId,
      entityType: "workspace_task",
      entityId: task.id,
      actionUrl: `/communities/${task.communityId}`,
    });
  }
}

async function messageViews(messages: typeof messagesTable.$inferSelect[], viewerId?: string) {
  if (messages.length === 0) return [];
  const messageIds = messages.map((message) => message.id);
  const senderIds = [...new Set(messages.map((message) => message.senderId))];
  const [senders, attachments, reactions, reactedRows] = await Promise.all([
    db.select({
      id: usersTable.clerkId,
      username: usersTable.username,
      displayName: usersTable.displayName,
      avatarUrl: usersTable.avatarUrl,
      status: usersTable.status,
    }).from(usersTable).where(inArray(usersTable.clerkId, senderIds)),
    db.select({
      messageId: messageAttachmentsTable.messageId,
      id: messageAttachmentsTable.id,
      fileName: messageAttachmentsTable.fileName,
      contentType: messageAttachmentsTable.contentType,
      fileSize: messageAttachmentsTable.fileSize,
    }).from(messageAttachmentsTable).where(inArray(messageAttachmentsTable.messageId, messageIds)),
    db.select({
      messageId: messageReactionsTable.messageId,
      emoji: messageReactionsTable.emoji,
      count: sql<number>`count(*)`,
    }).from(messageReactionsTable)
      .where(inArray(messageReactionsTable.messageId, messageIds))
      .groupBy(messageReactionsTable.messageId, messageReactionsTable.emoji),
    viewerId
      ? db.select({
        messageId: messageReactionsTable.messageId,
        emoji: messageReactionsTable.emoji,
      }).from(messageReactionsTable).where(and(
        inArray(messageReactionsTable.messageId, messageIds),
        eq(messageReactionsTable.userId, viewerId),
      ))
      : Promise.resolve([]),
  ]);
  const sendersById = new Map(senders.map((sender) => [sender.id, sender]));
  const attachmentsByMessage = new Map<string, typeof attachments[number][]>();
  for (const attachment of attachments) {
    const list = attachmentsByMessage.get(attachment.messageId) ?? [];
    list.push(attachment);
    attachmentsByMessage.set(attachment.messageId, list);
  }
  const reactionsByMessage = new Map<string, typeof reactions[number][]>();
  for (const reaction of reactions) {
    const list = reactionsByMessage.get(reaction.messageId) ?? [];
    list.push(reaction);
    reactionsByMessage.set(reaction.messageId, list);
  }
  const reactedByMessage = new Set(reactedRows.map((reaction) => `${reaction.messageId}:${reaction.emoji}`));
  return messages.map((message) => ({
    id: message.id,
    channelId: message.channelId,
    threadKey: message.threadKey,
    body: message.body,
    kind: message.kind,
    createdAt: message.createdAt,
    replyToId: message.replyToId,
    sender: sendersById.get(message.senderId) ?? null,
    recipientId: message.recipientId,
    deletedAt: message.deletedAt,
    reactions: (reactionsByMessage.get(message.id) ?? []).map((reaction) => ({
      emoji: reaction.emoji,
      count: Number(reaction.count),
      reacted: reactedByMessage.has(`${message.id}:${reaction.emoji}`),
    })),
    attachments: (attachmentsByMessage.get(message.id) ?? []).map(({ messageId: _messageId, ...attachment }) => ({
      ...attachment,
      url: `/api/attachments/${attachment.id}`,
    })),
  }));
}

async function messageView(message: typeof messagesTable.$inferSelect, viewerId?: string) {
  const [view] = await messageViews([message], viewerId);
  if (!view) throw new Error("Message view could not be created.");
  return view;
}

router.get("/me", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const user = await ensureProfile(userId);
  let isTestAccount = false;
  let testRole: string | null = null;
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const metadata = clerkUser.publicMetadata;
    if (metadata && typeof metadata === "object" && (metadata as Record<string, unknown>).relay === "relay_test_account") {
      isTestAccount = true;
      testRole = typeof (metadata as Record<string, unknown>).role === "string"
        ? (metadata as Record<string, unknown>).role as string
        : null;
    }
  } catch {
    // Profile responses remain available if Clerk metadata is temporarily unavailable.
  }
  res.json({
    id: user.clerkId,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    role: user.role,
    lastSeenAt: user.lastSeenAt,
    isTestAccount,
    testRole,
  });
});

router.patch("/me", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : undefined;
  const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : undefined;
  if (username && !/^[a-z0-9_]{3,24}$/.test(username)) {
    res.status(400).json({ error: "Username must be 3–24 letters, numbers, or underscores." });
    return;
  }
  if (displayName !== undefined && (displayName.length < 1 || displayName.length > 48)) {
    res.status(400).json({ error: "Display name must be 1–48 characters." });
    return;
  }
  const [updated] = await db.update(usersTable).set({
    ...(username ? { username } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    status: "online",
    lastSeenAt: new Date(),
  }).where(eq(usersTable.clerkId, userId)).returning();
  res.json(updated);
});

router.get("/channels", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  await ensureDefaults(userId);
  const [allChannels, joined, allCategories, pending] = await Promise.all([
    db.select().from(channelsTable).orderBy(asc(channelsTable.name)),
    db
      .select({ channelId: channelMembersTable.channelId })
      .from(channelMembersTable)
      .where(eq(channelMembersTable.userId, userId)),
    db.select().from(categoriesTable).orderBy(asc(categoriesTable.name)),
    db
      .select({ channelId: channelJoinRequestsTable.channelId })
      .from(channelJoinRequestsTable)
      .where(and(
        eq(channelJoinRequestsTable.userId, userId),
        eq(channelJoinRequestsTable.status, "pending"),
      )),
  ]);
  const joinedIds = new Set(joined.map((item) => item.channelId));
  const communityIds = [
    ...new Set([
      ...allChannels.flatMap((channel) =>
        channel.communityId === null ? [] : [channel.communityId],
      ),
      ...allCategories.flatMap((category) =>
        category.communityId === null ? [] : [category.communityId],
      ),
    ]),
  ];
  const [communities, memberships] = communityIds.length
    ? await Promise.all([
      db
        .select({
          id: communitiesTable.id,
          name: communitiesTable.name,
          isPrivate: communitiesTable.isPrivate,
          plan: communitiesTable.plan,
        })
        .from(communitiesTable)
        .where(inArray(communitiesTable.id, communityIds)),
      db
        .select({ communityId: communityMembersTable.communityId })
        .from(communityMembersTable)
        .where(and(
          eq(communityMembersTable.userId, userId),
          inArray(communityMembersTable.communityId, communityIds),
        )),
    ])
    : [[], []];
  const communityPrivacy = new Map(
    communities.map((community) => [community.id, community.isPrivate]),
  );
  const communityNames = new Map(communities.map((community) => [community.id, community.name]));
  const publicCommunityIds = new Set(communities
    .filter((community) => !community.isPrivate && ["free_community", "purchased_community"].includes(community.plan))
    .map((community) => community.id));
  const membershipIds = new Set(
    memberships.map((membership) => membership.communityId),
  );
  const permissionAccess = new Map<number, Promise<boolean>>();
  const hasPrivateCommunityAccess = (communityId: number): Promise<boolean> => {
    if (membershipIds.has(communityId)) return Promise.resolve(true);
    const cached = permissionAccess.get(communityId);
    if (cached) return cached;
    const access = (async () =>
      await hasPermission(userId, "view_business", { communityId })
      || await hasPermission(userId, "manage_community", { communityId })
    )();
    permissionAccess.set(communityId, access);
    return access;
  };
  const visibleChannels = await Promise.all(allChannels.map(async (channel) => {
    if (
      channel.communityId !== null
      && communityPrivacy.get(channel.communityId) !== false
      && !(await hasPrivateCommunityAccess(channel.communityId))
    ) {
      return null;
    }
    return !channel.isPrivate || joinedIds.has(channel.id) ? channel : null;
  }));
  const channels = visibleChannels.filter((channel): channel is typeof allChannels[number] => channel !== null);
  const counts = channels.length
    ? await db
      .select({
        channelId: channelMembersTable.channelId,
        memberCount: count(),
      })
      .from(channelMembersTable)
      .where(inArray(channelMembersTable.channelId, channels.map((channel) => channel.id)))
      .groupBy(channelMembersTable.channelId)
    : [];
  const countMap = new Map(
    counts.map(({ channelId, memberCount }) => [channelId, Number(memberCount)]),
  );
  const visibleCategories = await Promise.all(allCategories.map(async (category) => {
    if (category.communityId === null) return category;
    return communityPrivacy.get(category.communityId) !== true
      || await hasPrivateCommunityAccess(category.communityId)
      ? category
      : null;
  }));
  const categories = visibleCategories.filter((category): category is typeof allCategories[number] => category !== null);
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const pendingIds = new Set(pending.map((request) => request.channelId));
  res.json(channels.map((channel) => ({
    ...channel,
    communityName: channel.communityId === null ? "Public network" : communityNames.get(channel.communityId) ?? null,
    canMovePublicSpace: channel.ownerId === userId && !channel.isPrivate
      && (channel.communityId === null || publicCommunityIds.has(channel.communityId)),
    passwordHash: undefined,
    joined: joinedIds.has(channel.id),
    accessStatus: joinedIds.has(channel.id)
      ? "member"
      : pendingIds.has(channel.id)
        ? "pending"
        : channel.isPrivate
          ? "available"
          : "open",
    category: channel.categoryId ? categoryMap.get(channel.categoryId) ?? null : null,
    memberCount: countMap.get(channel.id) ?? 0,
  })));
});

router.get("/categories", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const allCategories = await db.select().from(categoriesTable).orderBy(asc(categoriesTable.name));
  const communityIds = [
    ...new Set(
      allCategories.flatMap((category) =>
        category.communityId === null ? [] : [category.communityId],
      ),
    ),
  ];
  const permissions = await permissionsForCommunities(
    userId,
    communityIds,
    ["view_business", "manage_community"],
  );
  const categories = allCategories.filter((category) => {
    if (category.communityId === null) return true;
    const communityPermissions = permissions.get(category.communityId);
    return communityPermissions?.has("view_business")
      || communityPermissions?.has("manage_community");
  });
  res.json(categories);
});

router.post("/categories", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  const name = typeof req.body.name === "string" ? req.body.name.trim().toLowerCase() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 240) : "";
  if (!/^[a-z0-9][a-z0-9 _-]{1,39}$/.test(name)) {
    res.status(400).json({ error: "Category names must be 2–40 lowercase characters." });
    return;
  }
  const [category] = await db.insert(categoriesTable).values({ name, description, ownerId: userId }).returning();
  res.status(201).json(category);
});

router.post("/channels", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureProfile(userId);
  const name = typeof req.body.name === "string" ? channelName(req.body.name) : "";
  const topic = typeof req.body.topic === "string" ? req.body.topic.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 240) : "";
  const isPrivate = req.body.isPrivate === true;
  const isInviteOnly = req.body.isInviteOnly === true;
  const password = typeof req.body.password === "string" ? req.body.password.trim() : "";
  const categoryId = req.body.categoryId === null || req.body.categoryId === undefined || req.body.categoryId === ""
    ? null
    : Number(req.body.categoryId);
  const communityId = req.body.communityId === null || req.body.communityId === undefined || req.body.communityId === ""
    ? null
    : Number(req.body.communityId);
  if (!/^#[a-z0-9][a-z0-9_-]{1,31}$/.test(name)) {
    res.status(400).json({ error: "Channel names must be 2–32 lowercase characters." });
    return;
  }
  if (categoryId !== null) {
    if (!Number.isInteger(categoryId)) {
      res.status(400).json({ error: "Category must be valid." });
      return;
    }
    const category = await db.query.categoriesTable.findFirst({
      where: eq(categoriesTable.id, categoryId),
    });
    if (!category || category.communityId !== communityId) {
      res.status(400).json({ error: "Category must be valid." });
      return;
    }
  }
  if (communityId !== null) {
    if (!Number.isInteger(communityId) || !(await hasPermission(userId, "create_channel", {
      communityId,
      categoryId: categoryId ?? undefined,
    }))) {
      res.status(403).json({ error: "You cannot create channels in this community." });
      return;
    }
  }
  if (password && password.length < 4) {
    res.status(400).json({ error: "Channel passwords must be at least 4 characters." });
    return;
  }
  const [channel] = await db.insert(channelsTable).values({
    name,
    topic,
    description,
    ownerId: userId,
    communityId,
    categoryId,
    isPrivate,
    isInviteOnly,
    passwordHash: password ? passwordHash(password) : null,
  }).returning();
  await db.insert(channelMembersTable).values({ channelId: channel.id, userId, role: "owner" });
  const sourceCommunity = communityId === null ? null : (await db.select({
    name: communitiesTable.name, isPrivate: communitiesTable.isPrivate, plan: communitiesTable.plan,
  }).from(communitiesTable).where(eq(communitiesTable.id, communityId)))[0];
  res.status(201).json({
    ...channel, passwordHash: undefined, joined: true, accessStatus: "member", memberCount: 1,
    communityName: sourceCommunity?.name ?? "Public network",
    canMovePublicSpace: !isPrivate && (communityId === null
      || (sourceCommunity?.isPrivate === false && ["free_community", "purchased_community"].includes(sourceCommunity.plan))),
  });
});

router.post("/channels/:channelId/join", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!enforceRateLimit(req, res, channelJoinLimiter, "Too many channel join requests.")) return;
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const ban = await db.query.channelBansTable.findFirst({
    where: and(eq(channelBansTable.channelId, channel.id), eq(channelBansTable.userId, userId)),
  });
  if (ban) {
    res.status(403).json({ error: ban.reason || "You are banned from this channel." });
    return;
  }
  await ensureProfile(userId);
  if (!hasChannelPassword(channel, req.body?.password)) {
    res.status(403).json({ error: "A channel password is required." });
    return;
  }
  if (channel.isPrivate && !(await membership(channel.id, userId))) {
    const invite = await db.query.channelInvitesTable.findFirst({
      where: and(eq(channelInvitesTable.channelId, channel.id), eq(channelInvitesTable.userId, userId)),
    });
    if (channel.isInviteOnly && !invite) {
      res.status(403).json({ error: "This channel is invite-only." });
      return;
    }
    const requestResult = await db.transaction(async (tx) => {
      const [lockedChannel] = await tx
        .select({ id: channelsTable.id, ownerId: channelsTable.ownerId, name: channelsTable.name })
        .from(channelsTable)
        .where(eq(channelsTable.id, channel.id))
        .for("update");
      if (!lockedChannel) return { outcome: "channel_not_found" } as const;
      const [existingRequest] = await tx
        .select()
        .from(channelJoinRequestsTable)
        .where(and(
          eq(channelJoinRequestsTable.channelId, channel.id),
          eq(channelJoinRequestsTable.userId, userId),
        ))
        .for("update");
      if (existingRequest?.status === "pending") {
        return { outcome: "pending", request: existingRequest, notification: null } as const;
      }
      const [request] = existingRequest
        ? await tx.update(channelJoinRequestsTable)
          .set({ status: "pending", createdAt: new Date(), reviewedAt: null, reviewedBy: null })
          .where(eq(channelJoinRequestsTable.id, existingRequest.id))
          .returning()
        : await tx.insert(channelJoinRequestsTable)
          .values({ channelId: channel.id, userId, status: "pending" })
          .returning();
      if (!request) return { outcome: "channel_not_found" } as const;
      const [notification] = await tx.insert(notificationsTable).values({
        userId: lockedChannel.ownerId,
        type: "channel_join_request",
        category: "join_request",
        body: `Someone requested access to ${lockedChannel.name}.`,
        entityType: "channel_join_request",
        entityId: String(request.id),
        actionUrl: "/",
      }).returning();
      return { outcome: "pending", request, notification: notification ?? null } as const;
    });
    if (requestResult.outcome === "channel_not_found") {
      res.status(404).json(channelNotFoundError);
      return;
    }
    if (requestResult.notification) {
      wsHub.broadcastUser(requestResult.notification.userId, {
        type: "notification",
        notification: {
          ...requestResult.notification,
          category: categoryForNotification(
            requestResult.notification.type,
            requestResult.notification.category,
          ),
        },
      });
    }
    if (!requestResult.notification) {
      res.status(202).json({ ok: true, status: "pending" });
      return;
    }
    res.status(202).json({ ok: true, status: requestResult.request.status });
    return;
  }
  await db.insert(channelMembersTable).values({ channelId: channel.id, userId }).onConflictDoNothing();
  await db.delete(channelInvitesTable).where(and(eq(channelInvitesTable.channelId, channel.id), eq(channelInvitesTable.userId, userId)));
  const user = await publicUser(userId);
  const event = {
    type: "presence",
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    channelId: channel.id,
    action: "join",
    user,
  };
  wsHub.broadcastChannel(channel.id, event);
  res.json({ ok: true, status: "member" });
});

router.get("/channels/:channelId/join-requests", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const page = listPage(req);
  const review = await db.transaction(async (tx) => {
    const [reviewer] = await tx
      .select({ role: channelMembersTable.role })
      .from(channelMembersTable)
      .where(and(
        eq(channelMembersTable.channelId, channel.id),
        eq(channelMembersTable.userId, userId),
      ))
      .for("update");
    if (!reviewer || !["owner", "moderator"].includes(reviewer.role)) {
      return { authorized: false as const, rows: [] };
    }
    const rows = await tx
      .select({
        id: channelJoinRequestsTable.id,
        status: channelJoinRequestsTable.status,
        createdAt: channelJoinRequestsTable.createdAt,
        user: usersTable,
      })
      .from(channelJoinRequestsTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, channelJoinRequestsTable.userId))
      .where(and(eq(channelJoinRequestsTable.channelId, channel.id), eq(channelJoinRequestsTable.status, "pending")))
      .orderBy(asc(channelJoinRequestsTable.createdAt), asc(channelJoinRequestsTable.id))
      .limit(page.limit + 1)
      .offset(page.offset);
    return { authorized: true as const, rows };
  });
  if (!review.authorized) {
    res.status(403).json({ error: "Only channel operators can review join requests." });
    return;
  }
  const rows = review.rows;
  const hasMore = rows.length > page.limit;
  if (hasMore) rows.pop();
  setListPageHeaders(res, hasMore, page.offset + page.limit);
  res.json(rows.map(({ id, status, createdAt, user }) => ({
    id,
    status,
    createdAt,
    user: {
      id: user.clerkId,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      status: user.status,
    },
  })));
});

router.post("/channels/:channelId/join-requests/:requestId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  const requestId = Number(param(req, "requestId"));
  const decision = req.body?.decision;
  if (!channel || !Number.isInteger(requestId) || !["approve", "reject"].includes(decision)) {
    res.status(400).json({ error: "Invalid join-request decision." });
    return;
  }
  const review = await db.transaction(async (tx) => {
    const [lockedChannel] = await tx
      .select({ id: channelsTable.id })
      .from(channelsTable)
      .where(eq(channelsTable.id, channel.id))
      .for("update");
    if (!lockedChannel) {
      return { outcome: "channel_not_found" } as const;
    }
    const [request] = await tx
      .select()
      .from(channelJoinRequestsTable)
      .where(and(
        eq(channelJoinRequestsTable.id, requestId),
        eq(channelJoinRequestsTable.channelId, channel.id),
        eq(channelJoinRequestsTable.status, "pending"),
      ))
      .for("update");
    if (!request) {
      return { outcome: "not_found" } as const;
    }
    const [reviewer] = await tx
      .select({ role: channelMembersTable.role })
      .from(channelMembersTable)
      .where(and(
        eq(channelMembersTable.channelId, channel.id),
        eq(channelMembersTable.userId, userId),
      ))
      .for("update");
    if (!reviewer || !["owner", "moderator"].includes(reviewer.role)) {
      return { outcome: "forbidden" } as const;
    }
    const [updatedRequest] = await tx
      .update(channelJoinRequestsTable)
      .set({ status: decision === "approve" ? "approved" : "rejected", reviewedAt: new Date(), reviewedBy: userId })
      .where(and(
        eq(channelJoinRequestsTable.id, requestId),
        eq(channelJoinRequestsTable.channelId, channel.id),
        eq(channelJoinRequestsTable.status, "pending"),
      ))
      .returning();
    if (!updatedRequest) {
      return { outcome: "not_found" } as const;
    }
    if (decision === "approve") {
      await tx
        .insert(channelMembersTable)
        .values({ channelId: channel.id, userId: updatedRequest.userId })
        .onConflictDoNothing();
    }
    const [notification] = await tx.insert(notificationsTable).values({
      userId: updatedRequest.userId,
      type: decision === "approve" ? "channel_join_approved" : "channel_join_rejected",
      category: "join_request",
      body: decision === "approve"
        ? `Your request to join ${channel.name} was approved.`
        : `Your request to join ${channel.name} was declined.`,
      entityType: "channel",
      entityId: String(channel.id),
    }).returning();
    return { outcome: "updated", request: updatedRequest, notification: notification ?? null } as const;
  });
  if (review.outcome === "channel_not_found") {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (review.outcome === "forbidden") {
    res.status(403).json({ error: "Only channel operators can review join requests." });
    return;
  }
  if (review.outcome === "not_found") {
    res.status(404).json({ error: "Join request not found." });
    return;
  }
  const { request } = review;
  if (review.notification) {
    wsHub.broadcastUser(review.notification.userId, {
      type: "notification",
      notification: {
        ...review.notification,
        category: categoryForNotification(review.notification.type, review.notification.category),
      },
    });
  }
  res.json({ ok: true, status: request.status });
});

router.post("/channels/:channelId/invites", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!enforceRateLimit(req, res, channelInviteLimiter, "Too many channel invite requests.")) return;
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  if (!channel || !username) {
    res.status(400).json({ error: "A channel and username are required." });
    return;
  }
  if (!(await isChannelOwnerOrModerator(channel.id, userId))) {
    res.status(403).json({ error: "Only channel operators can invite users." });
    return;
  }
  const target = await db.query.usersTable.findFirst({ where: eq(usersTable.username, username) });
  if (!target) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  await db.insert(channelInvitesTable).values({ channelId: channel.id, userId: target.clerkId, invitedBy: userId }).onConflictDoUpdate({
    target: [channelInvitesTable.channelId, channelInvitesTable.userId],
    set: { invitedBy: userId, createdAt: new Date() },
  });
  await createNotification({ userId: target.clerkId, type: "channel_invite", category: "join_request", body: `You were invited to ${channel.name}.`, entityType: "channel", entityId: channel.id });
  res.status(201).json({ ok: true });
});

router.post("/channels/:channelId/leave", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(channelMembersTable).where(and(
      eq(channelMembersTable.channelId, channel.id),
      eq(channelMembersTable.userId, userId),
    ));
    await tx.delete(channelJoinRequestsTable).where(and(
      eq(channelJoinRequestsTable.channelId, channel.id),
      eq(channelJoinRequestsTable.userId, userId),
    ));
  });
  if (channel.isPrivate) wsHub.revokeChannelAccess(channel.id, userId);
  wsHub.broadcastChannel(channel.id, {
    type: "presence",
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    channelId: channel.id,
    action: "leave",
    userId,
  });
  res.json({ ok: true });
});

router.get("/channels/:channelId/members", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (!(await canReadChannel(channel, userId))) {
    res.status(403).json(channelAccessRequiredError("Join the private channel before viewing its members."));
    return;
  }
  const page = listPage(req);
  const rows = await db
    .select({
      user: usersTable,
      role: channelMembersTable.role,
      mutedUntil: channelMembersTable.mutedUntil,
    })
    .from(channelMembersTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, channelMembersTable.userId))
    .where(eq(channelMembersTable.channelId, channel.id))
    .orderBy(asc(usersTable.displayName), asc(usersTable.clerkId))
    .limit(page.limit + 1)
    .offset(page.offset);
  const hasMore = rows.length > page.limit;
  if (hasMore) rows.pop();
  setListPageHeaders(res, hasMore, page.offset + page.limit);
  res.json(rows.map(({ user, role, mutedUntil }) => ({
    id: user.clerkId,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    role,
    mutedUntil,
  })));
});

router.get("/channels/:channelId/messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (!(await canReadChannel(channel, userId))) {
    res.status(403).json(channelAccessRequiredError("Join the private channel before reading its history."));
    return;
  }
  const rawQuery = req.query.q;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (typeof rawQuery === "string" && !isValidQuery(rawQuery)) {
    res.status(400).json({ error: "Search queries must be 200 characters or fewer." });
    return;
  }
  const rows = await db.select().from(messagesTable).where(and(
    eq(messagesTable.channelId, channel.id),
    query ? ilike(messagesTable.body, `%${query}%`) : undefined,
  )).orderBy(desc(messagesTable.createdAt), desc(messagesTable.id)).limit(100);
  res.json({ channel: { ...channel, passwordHash: undefined }, messages: await messageViews(rows.reverse(), userId) });
});

router.post("/channels/:channelId/messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const member = await membership(channel.id, userId);
  if (!member) {
    res.status(403).json(channelAccessRequiredError("Join the channel before sending messages."));
    return;
  }
  if (member.mutedUntil && member.mutedUntil > new Date()) {
    res.status(403).json({ error: "You are muted in this channel." });
    return;
  }
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 500) {
    res.status(400).json({ error: "Messages must be 1–500 characters." });
    return;
  }
  const replyToId = typeof req.body.replyToId === "string" && req.body.replyToId.trim() ? req.body.replyToId.trim() : null;
  if (replyToId) {
    const [parent] = await db.select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.id, replyToId), eq(messagesTable.channelId, channel.id)))
      .limit(1);
    if (!parent) {
      res.status(400).json({ error: "The message you are replying to is not in this channel." });
      return;
    }
  }
  const [message] = await db.insert(messagesTable).values({ channelId: channel.id, senderId: userId, replyToId, body }).returning();
  const view = await messageView(message);
  res.status(201).json(view);
  void notifyMentionedUsers(body, userId, channel.id, message.id).catch((error) => {
    logger.warn({ err: error, messageId: message.id }, "Message mention notifications failed.");
  });
  wsHub.broadcastChannel(channel.id, { type: "message", message: view });
});

router.post("/channels/:channelId/file-messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const member = await membership(channel.id, userId);
  if (!member) {
    res.status(403).json(channelAccessRequiredError("Join the channel before sending messages."));
    return;
  }
  if (member.mutedUntil && member.mutedUntil > new Date()) {
    res.status(403).json({ error: "You are muted in this channel." });
    return;
  }
  const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
  const metadata = validateUploadMetadata({
    name: req.body?.fileName,
    size: req.body?.fileSize,
    contentType: req.body?.contentType,
  });
  if (
    !isValidUploadedObjectPath(objectPath)
    || !metadata
    || metadata.size > 10_000_000
  ) {
    res.status(400).json({ error: "Invalid attachment metadata." });
    return;
  }
  const message = await db.transaction(async (tx) => {
    const [createdMessage] = await tx.insert(messagesTable).values({
      channelId: channel.id,
      senderId: userId,
      body: metadata.name,
    }).returning();
    await tx.insert(messageAttachmentsTable).values({
      messageId: createdMessage.id,
      uploaderId: userId,
      objectPath,
      fileName: metadata.name,
      contentType: metadata.contentType,
      fileSize: metadata.size,
    });
    return createdMessage;
  });
  const view = await messageView(message, userId);
  res.status(201).json(view);
  wsHub.broadcastChannel(channel.id, { type: "message", message: view });
});

router.get("/channels/:channelId/public-spaces", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channelId = Number(param(req, "channelId"));
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (channel.ownerId !== userId) {
    res.status(403).json({ error: "Only the channel owner can move it between public spaces." });
    return;
  }
  const source = channel.communityId === null ? null : (await db.select().from(communitiesTable)
    .where(eq(communitiesTable.id, channel.communityId)))[0];
  if (channel.isPrivate || (source && (source.isPrivate || !["free_community", "purchased_community"].includes(source.plan)))) {
    res.status(400).json({ error: "Only channels in public communities or the public network can move between public spaces." });
    return;
  }
  const owned = await db.select({ id: communitiesTable.id, name: communitiesTable.name })
    .from(communitiesTable)
    .where(and(eq(communitiesTable.ownerId, userId), inArray(communitiesTable.plan, ["free_community", "purchased_community"]),
      eq(communitiesTable.isPrivate, false), eq(communitiesTable.status, "active")));
  res.json(owned.filter((community) => community.id !== channel.communityId));
});

router.patch("/channels/:channelId/public-space", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channelId = Number(param(req, "channelId"));
  const destinationId = req.body?.communityId;
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (!Number.isSafeInteger(destinationId) || destinationId < 1) {
    res.status(400).json({ error: "Choose a valid public space." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [channel] = await tx.select().from(channelsTable)
      .where(eq(channelsTable.id, channelId)).for("update");
    if (!channel) return { outcome: "not_found" } as const;
    if (channel.ownerId !== userId) return { outcome: "forbidden" } as const;
    if (channel.isPrivate) return { outcome: "not_public" } as const;
    if (channel.communityId === destinationId) return { outcome: "same_space" } as const;
    const communityIds = [channel.communityId, destinationId].filter((id): id is number => id !== null);
    const communities = communityIds.length
      ? await tx.select().from(communitiesTable)
        .where(inArray(communitiesTable.id, communityIds))
        .orderBy(asc(communitiesTable.id)).for("share")
      : [];
    const source = communities.find((item) => item.id === channel.communityId);
    if (channel.communityId !== null && (!source || source.isPrivate || !["free_community", "purchased_community"].includes(source.plan))) {
      return { outcome: "not_public" } as const;
    }
    const destination = communities.find((item) => item.id === destinationId);
    if (!destination || destination.ownerId !== userId
      || destination.isPrivate || !["free_community", "purchased_community"].includes(destination.plan) || destination.status !== "active") {
      return { outcome: "invalid_destination" } as const;
    }
    const [updated] = await tx.update(channelsTable)
      .set({ communityId: destinationId, categoryId: null })
      .where(eq(channelsTable.id, channelId)).returning();
    await tx.insert(moderationActionsTable).values({
      actorId: userId,
      communityId: destinationId,
      channelId,
      action: "moved_public_channel",
      details: `from:${channel.communityId ?? "network"} to:${destinationId ?? "network"}`,
    });
    return { outcome: "moved", updated, destinationName: destination.name } as const;
  });
  if (result.outcome === "not_found") {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (result.outcome === "forbidden") {
    res.status(403).json({ error: "Only the channel owner can move it between public spaces." });
    return;
  }
  if (result.outcome === "not_public" || result.outcome === "invalid_destination" || result.outcome === "same_space") {
    res.status(400).json({ error: "The channel and destination must be different public spaces you own." });
    return;
  }
  const moved = { ...publicChannel(result.updated), communityName: result.destinationName };
  wsHub.broadcastChannel(channelId, { type: "channel", channel: moved });
  wsHub.broadcastChannelListChanged();
  res.json(moved);
});

router.patch("/channels/:channelId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channelId = Number(param(req, "channelId"));
  if (!Number.isSafeInteger(channelId) || channelId < 1) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const hasCategoryId = Object.prototype.hasOwnProperty.call(req.body, "categoryId");
  const categoryId = req.body.categoryId === null
    ? null
    : typeof req.body.categoryId === "number" && Number.isSafeInteger(req.body.categoryId) && req.body.categoryId > 0
      ? req.body.categoryId
      : undefined;
  if (hasCategoryId && categoryId === undefined) {
    res.status(400).json({ error: "Choose a valid category or unassigned." });
    return;
  }
  const topic = typeof req.body.topic === "string" ? req.body.topic.trim().slice(0, 160) : undefined;
  const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 240) : undefined;
  const isInviteOnly = typeof req.body.isInviteOnly === "boolean" ? req.body.isInviteOnly : undefined;
  const password = req.body.password === null
    ? null
    : typeof req.body.password === "string"
      ? req.body.password.trim()
      : undefined;
  if (password && password.length < 4) {
    res.status(400).json({ error: "Channel passwords must be at least 4 characters." });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [channel] = await tx.select().from(channelsTable)
      .where(eq(channelsTable.id, channelId)).for("update");
    if (!channel) return { outcome: "not_found" } as const;
    const [membership] = await tx.select({ role: channelMembersTable.role })
      .from(channelMembersTable)
      .where(and(eq(channelMembersTable.channelId, channelId), eq(channelMembersTable.userId, userId)))
      .for("update");
    if (membership?.role !== "owner" && membership?.role !== "moderator") return { outcome: "forbidden" } as const;
    if (categoryId !== null && categoryId !== undefined) {
      const [category] = await tx.select({ communityId: categoriesTable.communityId })
        .from(categoriesTable).where(eq(categoriesTable.id, categoryId)).for("share");
      if (!category || category.communityId !== channel.communityId) return { outcome: "wrong_workspace" } as const;
    }
    const [updated] = await tx.update(channelsTable).set({
      ...(topic === undefined ? {} : { topic }),
      ...(description === undefined ? {} : { description }),
      ...(isInviteOnly === undefined ? {} : { isInviteOnly }),
      ...(password === undefined ? {} : { passwordHash: password ? passwordHash(password) : null }),
      ...(hasCategoryId ? { categoryId } : {}),
    }).where(eq(channelsTable.id, channelId)).returning();
    await tx.insert(moderationActionsTable).values({
      actorId: userId,
      communityId: channel.communityId,
      channelId,
      action: "updated_channel",
      details: hasCategoryId ? `category:${categoryId ?? "unassigned"}` : topic !== undefined ? `topic:${topic}` : "channel settings changed",
    });
    return { outcome: "updated", updated } as const;
  });
  if (result.outcome === "not_found") {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (result.outcome === "forbidden") {
    res.status(403).json({ error: "Only channel owners and moderators can edit this channel." });
    return;
  }
  if (result.outcome === "wrong_workspace") {
    res.status(400).json({ error: "The selected category must belong to the same workspace as the channel." });
    return;
  }
  wsHub.broadcastChannel(channelId, { type: "channel", channel: publicChannel(result.updated) });
  if (hasCategoryId) wsHub.broadcastChannelListChanged();
  res.json(publicChannel(result.updated));
});

router.delete("/channels/:channelId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channelId = Number(param(req, "channelId"));
  if (!Number.isInteger(channelId)) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const deletion = await db.transaction(async (tx) => {
    const [channel] = await tx
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.id, channelId))
      .for("update");
    if (!channel) return { outcome: "not_found" } as const;
    const [actorMembership] = await tx
      .select({ role: channelMembersTable.role })
      .from(channelMembersTable)
      .where(and(
        eq(channelMembersTable.channelId, channel.id),
        eq(channelMembersTable.userId, userId),
      ))
      .for("update");
    const actorCanManageChannel = await hasPermission(
      userId,
      "manage_channel",
      { channelId: channel.id },
      tx,
      true,
    );
    if (actorMembership?.role !== "owner" && !actorCanManageChannel) {
      return { outcome: "forbidden" } as const;
    }
    const requestIds = await tx
      .select({ id: channelJoinRequestsTable.id })
      .from(channelJoinRequestsTable)
      .where(eq(channelJoinRequestsTable.channelId, channel.id));
    await tx.delete(notificationsTable).where(and(
      eq(notificationsTable.entityType, "channel"),
      eq(notificationsTable.entityId, String(channel.id)),
    ));
    if (requestIds.length) {
      await tx.delete(notificationsTable).where(and(
        eq(notificationsTable.entityType, "channel_join_request"),
        inArray(notificationsTable.entityId, requestIds.map(({ id }) => String(id))),
      ));
    }
    await tx.delete(channelJoinRequestsTable).where(eq(channelJoinRequestsTable.channelId, channel.id));
    await tx.delete(channelInvitesTable).where(eq(channelInvitesTable.channelId, channel.id));
    await tx.delete(channelBansTable).where(eq(channelBansTable.channelId, channel.id));
    const channelMessages = await tx.select({ id: messagesTable.id }).from(messagesTable)
      .where(eq(messagesTable.channelId, channel.id));
    let cleanupPendingCount = 0;
    if (channelMessages.length) {
      const messageIds = channelMessages.map((message) => message.id);
      const attachments = await tx.select({ objectPath: messageAttachmentsTable.objectPath })
        .from(messageAttachmentsTable)
        .where(inArray(messageAttachmentsTable.messageId, messageIds));
      cleanupPendingCount = new Set(attachments.map(({ objectPath }) => objectPath)).size;
      await enqueueObjectDeletionJobs(
        tx,
        attachments.map(({ objectPath }) => objectPath),
        `channel:${channel.id}`,
      );
      await tx.delete(messageAttachmentsTable).where(inArray(messageAttachmentsTable.messageId, messageIds));
      await tx.delete(messageReactionsTable).where(inArray(messageReactionsTable.messageId, messageIds));
    }
    await tx.delete(channelMembersTable).where(eq(channelMembersTable.channelId, channel.id));
    await tx.delete(messagesTable).where(eq(messagesTable.channelId, channel.id));
    const [deleted] = await tx
      .delete(channelsTable)
      .where(eq(channelsTable.id, channel.id))
      .returning({ id: channelsTable.id });
    return deleted
      ? { outcome: "deleted", channelId: deleted.id, cleanupPendingCount } as const
      : { outcome: "not_found" } as const;
  });
  if (deletion.outcome === "not_found") {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (deletion.outcome === "forbidden") {
    res.status(403).json({ error: "Only channel owners or channel managers can delete this channel." });
    return;
  }
  wsHub.broadcastChannelRemoved(deletion.channelId);
  res.json({
    ok: true,
    cleanupPending: deletion.cleanupPendingCount > 0,
    cleanupPendingCount: deletion.cleanupPendingCount,
  });
});

router.delete("/messages/:messageId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const messageId = param(req, "messageId");
  const [message] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const channel = message.channelId ? await db.query.channelsTable.findFirst({ where: eq(channelsTable.id, message.channelId) }) : null;
  const actor = message.senderId === userId || Boolean(
    channel
      && (await hasPermission(userId, "delete_message", { channelId: channel.id }))
      && await isChannelOwnerOrModerator(channel.id, userId),
  );
  if (!actor) {
    res.status(403).json({ error: "You cannot delete this message." });
    return;
  }
  const [deleted] = await db.update(messagesTable)
    .set({ body: "[message deleted]", kind: "deleted", deletedAt: new Date(), deletedBy: userId })
    .where(eq(messagesTable.id, message.id))
    .returning();
  broadcastMessageEvent(message, { type: "message_deleted", messageId: message.id });
  res.json(await messageView(deleted, userId));
});

router.post("/messages/:messageId/attachments", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const messageId = param(req, "messageId");
  const [message] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (message.kind === "deleted") {
    res.status(409).json({ error: "Deleted messages cannot receive attachments." });
    return;
  }
  if (!(await canReadMessage(message, userId))) {
    res.status(403).json({ error: "You cannot attach files to this message." });
    return;
  }
  if (message.senderId !== userId) {
    res.status(403).json({ error: "Only the message sender can attach files." });
    return;
  }
  const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
  const metadata = validateUploadMetadata({
    name: req.body?.fileName,
    size: req.body?.fileSize,
    contentType: req.body?.contentType,
  });
  if (
    !isValidUploadedObjectPath(objectPath)
    || !metadata
    || metadata.size > 10_000_000
  ) {
    res.status(400).json({ error: "Invalid attachment metadata." });
    return;
  }
  const [attachment] = await db.insert(messageAttachmentsTable).values({
    messageId,
    uploaderId: userId,
    objectPath,
    fileName: metadata.name,
    contentType: metadata.contentType,
    fileSize: metadata.size,
  }).returning();
  const updatedView = await messageView(message, userId);
  broadcastMessageEvent(message, { type: "message", message: updatedView });
  res.status(201).json({ ...attachment, url: `/api/attachments/${attachment.id}` });
});

router.get("/attachments/:attachmentId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const attachmentId = Number(param(req, "attachmentId"));
  if (!Number.isInteger(attachmentId)) {
    res.status(404).json({ error: "Attachment not found." });
    return;
  }
  const [row] = await db
    .select({ attachment: messageAttachmentsTable, message: messagesTable })
    .from(messageAttachmentsTable)
    .innerJoin(messagesTable, eq(messagesTable.id, messageAttachmentsTable.messageId))
    .where(eq(messageAttachmentsTable.id, attachmentId));
  if (!row || !(await canReadMessage(row.message, userId))) {
    res.status(404).json({ error: "Attachment not found." });
    return;
  }
  try {
    res.redirect(await signedObjectUrlForPath(row.attachment.objectPath));
  } catch {
    res.status(503).json({ error: "File storage is temporarily unavailable." });
  }
});

router.post("/messages/:messageId/reactions", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const messageId = param(req, "messageId");
  const emoji = typeof req.body?.emoji === "string" ? req.body.emoji.trim().slice(0, 16) : "";
  if (!emoji) {
    res.status(400).json({ error: "An emoji is required." });
    return;
  }
  const [message] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (!(await canReadMessage(message, userId))) {
    res.status(403).json({ error: "You cannot react to this message." });
    return;
  }
  await db.insert(messageReactionsTable).values({ messageId, userId, emoji }).onConflictDoNothing();
  const view = await messageView(message, userId);
  broadcastMessageEvent(message, { type: "reaction", messageId, reactions: view.reactions });
  res.json(view.reactions);
});

router.delete("/messages/:messageId/reactions/:emoji", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const messageId = param(req, "messageId");
  const emoji = decodeURIComponent(param(req, "emoji"));
  const [message] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (!(await canReadMessage(message, userId))) {
    res.status(403).json({ error: "You cannot change reactions on this message." });
    return;
  }
  await db.delete(messageReactionsTable).where(and(
    eq(messageReactionsTable.messageId, messageId),
    eq(messageReactionsTable.userId, userId),
    eq(messageReactionsTable.emoji, emoji),
  ));
  const view = await messageView(message, userId);
  broadcastMessageEvent(message, { type: "reaction", messageId, reactions: view.reactions });
  res.json(view.reactions);
});

router.post("/channels/:channelId/moderation", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const targetUserId = typeof req.body.targetUserId === "string" ? req.body.targetUserId : "";
  const action = req.body.action;
  if (!targetUserId || !["mute", "kick", "ban", "unban", "moderator"].includes(action)) {
    res.status(400).json({ error: "Invalid moderation request." });
    return;
  }
  if (action !== "moderator" && !(await isChannelOwnerOrModerator(channel.id, userId))) {
    res.status(403).json({ error: "You do not have moderation permissions." });
    return;
  }
  if (action === "moderator") {
    const promoted = await db.transaction(async (tx) => {
      const promotionUserIds = [...new Set([userId, targetUserId])].sort();
      const lockedMemberships = await tx
        .select()
        .from(channelMembersTable)
        .where(and(
          eq(channelMembersTable.channelId, channel.id),
          inArray(channelMembersTable.userId, promotionUserIds),
        ))
        .orderBy(channelMembersTable.userId)
        .for("update");
      const actorMembership = lockedMemberships.find((member) => member.userId === userId);
      const targetMembership = lockedMemberships.find((member) => member.userId === targetUserId);
      const actorCanManageChannel = await hasPermission(
        userId,
        "manage_channel",
        { channelId: channel.id },
        tx,
        true,
      );
      if (!canPromoteChannelModerator({
        actorRole: actorMembership?.role ?? null,
        actorCanManageChannel,
        targetRole: targetMembership?.role ?? null,
      })) {
        return false;
      }
      const [updated] = await tx
        .update(channelMembersTable)
        .set({ role: "moderator" })
        .where(and(
          eq(channelMembersTable.channelId, channel.id),
          eq(channelMembersTable.userId, targetUserId),
          eq(channelMembersTable.role, "member"),
        ))
        .returning({ userId: channelMembersTable.userId });
      return Boolean(updated);
    }, { isolationLevel: "serializable" });
    if (!promoted) {
      res.status(403).json({
        error: "Only channel owners or channel managers can promote current members.",
      });
      return;
    }
  }
  if (action === "mute") {
    const minutes = Math.max(1, Math.min(1440, Number(req.body.minutes) || 10));
    await db.update(channelMembersTable).set({ mutedUntil: new Date(Date.now() + minutes * 60_000) }).where(and(eq(channelMembersTable.channelId, channel.id), eq(channelMembersTable.userId, targetUserId)));
  } else if (action === "kick") {
    await db.delete(channelMembersTable).where(and(eq(channelMembersTable.channelId, channel.id), eq(channelMembersTable.userId, targetUserId)));
    wsHub.revokeChannelAccess(channel.id, targetUserId);
  } else if (action === "ban") {
    await db.delete(channelMembersTable).where(and(eq(channelMembersTable.channelId, channel.id), eq(channelMembersTable.userId, targetUserId)));
    await db.insert(channelBansTable).values({ channelId: channel.id, userId: targetUserId, reason: String(req.body.reason ?? "") }).onConflictDoUpdate({ target: [channelBansTable.channelId, channelBansTable.userId], set: { reason: String(req.body.reason ?? "") } });
    wsHub.revokeChannelAccess(channel.id, targetUserId);
  } else if (action === "unban") {
    await db.delete(channelBansTable).where(and(eq(channelBansTable.channelId, channel.id), eq(channelBansTable.userId, targetUserId)));
  }
  await db.insert(moderationActionsTable).values({
    actorId: userId,
    targetUserId,
    communityId: channel.communityId,
    channelId: channel.id,
    action,
    details: typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : null,
  });
  wsHub.broadcastChannel(channel.id, { type: "moderation", action, targetUserId });
  res.json({ ok: true });
});

router.get("/users/search", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!enforceRateLimit(req, res, userSearchLimiter, "Too many user search requests.")) return;
  const userId = getUserId(req);
  const rawQuery = req.query.q;
  const q = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (typeof rawQuery === "string" && !isValidQuery(rawQuery)) {
    res.status(400).json({ error: "Search queries must be 200 characters or fewer." });
    return;
  }
  if (q.length < 2) {
    res.json([]);
    return;
  }
  if (await hasPermission(userId, "manage_any_community")) {
    const users = await db.select().from(usersTable)
      .where(or(ilike(usersTable.username, `%${q}%`), ilike(usersTable.displayName, `%${q}%`)))
      .limit(20);
    res.json(users.map((user) => ({ id: user.clerkId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, status: user.status })));
    return;
  }
  const memberships = await db.select({ communityId: communityMembersTable.communityId })
    .from(communityMembersTable)
    .where(eq(communityMembersTable.userId, userId));
  if (memberships.length === 0) {
    res.json([]);
    return;
  }
  const users = await db.selectDistinct({ user: usersTable })
    .from(communityMembersTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
    .where(and(
      inArray(communityMembersTable.communityId, memberships.map((item) => item.communityId)),
      or(ilike(usersTable.username, `%${q}%`), ilike(usersTable.displayName, `%${q}%`)),
    ))
    .limit(20);
  res.json(users.map(({ user }) => ({ id: user.clerkId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, status: user.status })));
});

router.post("/users/:userId/block", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const blockerId = getUserId(req);
  await db.insert(blocksTable).values({ blockerId, blockedId: param(req, "userId") }).onConflictDoNothing();
  res.json({ ok: true });
});

router.delete("/users/:userId/block", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  await db.delete(blocksTable).where(and(eq(blocksTable.blockerId, getUserId(req)), eq(blocksTable.blockedId, param(req, "userId"))));
  res.json({ ok: true });
});

function threadKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

router.get("/dm/threads", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const rows = await db
    .selectDistinctOn([messagesTable.threadKey])
    .from(messagesTable)
    .where(or(eq(messagesTable.senderId, userId), eq(messagesTable.recipientId, userId)))
    .orderBy(asc(messagesTable.threadKey), desc(messagesTable.createdAt), desc(messagesTable.id));
  const peerIds = [...new Set(
    rows
      .map((row) => row.threadKey?.split(":").find((id) => id !== userId))
      .filter((id): id is string => Boolean(id)),
  )];
  const peers = peerIds.length
    ? await db.select({
      id: usersTable.clerkId,
      username: usersTable.username,
      displayName: usersTable.displayName,
      avatarUrl: usersTable.avatarUrl,
      status: usersTable.status,
    }).from(usersTable).where(inArray(usersTable.clerkId, peerIds))
    : [];
  const peerById = new Map(peers.map((peer) => [peer.id, peer]));
  const views = await messageViews(rows, userId);
  const viewById = new Map(views.map((view) => [view.id, view]));
  const threads = [];
  for (const row of rows) {
    const key = row.threadKey;
    const peerId = key?.split(":").find((id) => id !== userId);
    const peer = peerId ? peerById.get(peerId) : null;
    const lastMessage = viewById.get(row.id);
    if (key && peerId && peer && lastMessage && await sharesBusiness(userId, peerId)) {
      threads.push({ key, peer, lastMessage });
    }
  }
  res.json(threads);
});

router.get("/dm/:userId/messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const peerId = param(req, "userId");
  if (!(await sharesBusiness(userId, peerId))) {
    res.status(403).json({ error: "Direct messages are limited to people in a shared business workspace." });
    return;
  }
  const key = threadKey(userId, peerId);
  const beforeValue = typeof req.query.before === "string" ? req.query.before : null;
  const before = beforeValue ? new Date(beforeValue) : null;
  if (beforeValue && (!before || Number.isNaN(before.getTime()))) {
    res.status(400).json({ error: "Invalid message cursor." });
    return;
  }
  const rows = await db.select().from(messagesTable).where(and(
    eq(messagesTable.threadKey, key),
    before ? lt(messagesTable.createdAt, before) : undefined,
  )).orderBy(desc(messagesTable.createdAt), desc(messagesTable.id)).limit(100);
  res.json({ threadKey: key, peer: await publicUser(peerId), messages: await messageViews(rows.reverse(), userId) });
});

router.post("/dm/:userId/messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const senderId = getUserId(req);
  const recipientId = param(req, "userId");
  if (!(await sharesBusiness(senderId, recipientId))) {
    res.status(403).json({ error: "Direct messages are limited to people in a shared business workspace." });
    return;
  }
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 500) {
    res.status(400).json({ error: "Messages must be 1–500 characters." });
    return;
  }
  const blocked = await db.query.blocksTable.findFirst({ where: or(and(eq(blocksTable.blockerId, senderId), eq(blocksTable.blockedId, recipientId)), and(eq(blocksTable.blockerId, recipientId), eq(blocksTable.blockedId, senderId))) });
  if (blocked) {
    res.status(403).json({ error: "Direct messages are unavailable for this user." });
    return;
  }
  const replyToId = typeof req.body.replyToId === "string" && req.body.replyToId.trim() ? req.body.replyToId.trim() : null;
  if (replyToId) {
    const [parent] = await db.select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(
        eq(messagesTable.id, replyToId),
        eq(messagesTable.threadKey, threadKey(senderId, recipientId)),
      ))
      .limit(1);
    if (!parent) {
      res.status(400).json({ error: "The message you are replying to is not in this conversation." });
      return;
    }
  }
  const [message] = await db.insert(messagesTable).values({ senderId, recipientId, threadKey: threadKey(senderId, recipientId), replyToId, body }).returning();
  const view = await messageView(message);
  res.status(201).json(view);
  void createNotification({
    userId: recipientId,
    type: "direct_message",
    category: "direct_message",
    body: "You have a new direct message.",
    entityType: "message",
    entityId: message.id,
  }).catch((error) => {
    logger.warn({ err: error, messageId: message.id }, "Direct-message notification failed.");
  });
  wsHub.broadcastUser(senderId, { type: "dm", message: view });
  wsHub.broadcastUser(recipientId, { type: "dm", message: view });
});

router.get("/search/messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!enforceRateLimit(req, res, messageSearchLimiter, "Too many message search requests.")) return;
  const userId = getUserId(req);
  const rawQuery = req.query.q;
  const q = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (typeof rawQuery === "string" && !isValidQuery(rawQuery)) {
    res.status(400).json({ error: "Search queries must be 200 characters or fewer." });
    return;
  }
  if (q.length < 2) {
    res.json([]);
    return;
  }
  const channelIds = await visibleChannelIds(userId);
  const messageScope = channelIds.length > 0
    ? or(inArray(messagesTable.channelId, channelIds), and(
      isNull(messagesTable.channelId),
      or(eq(messagesTable.senderId, userId), eq(messagesTable.recipientId, userId)),
    ))
    : and(
      isNull(messagesTable.channelId),
      or(eq(messagesTable.senderId, userId), eq(messagesTable.recipientId, userId)),
    );
  const rows = await db.select().from(messagesTable).where(and(
    ilike(messagesTable.body, `%${q}%`),
    messageScope,
  )).orderBy(desc(messagesTable.createdAt)).limit(100);
  res.json(await messageViews(rows, userId));
});

router.get("/notifications", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureTaskDeadlineNotifications(userId);
  const archived = req.query.archived === "true";
  const rows = await db.select().from(notificationsTable).where(and(
    eq(notificationsTable.userId, userId),
    isNull(notificationsTable.deletedAt),
    archived ? sql`${notificationsTable.archivedAt} IS NOT NULL` : isNull(notificationsTable.archivedAt),
  )).orderBy(desc(notificationsTable.createdAt)).limit(100);
  res.json(rows.map((row) => ({ ...row, category: categoryForNotification(row.type, row.category) })));
});

router.get("/notifications/:id/detail", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const notificationId = Number(param(req, "id"));
  if (!Number.isSafeInteger(notificationId) || notificationId < 1) {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  const userId = getUserId(req);
  const [notice] = await db.select().from(notificationsTable).where(and(
    eq(notificationsTable.id, notificationId),
    eq(notificationsTable.userId, userId),
    isNull(notificationsTable.deletedAt),
  )).limit(1);
  if (!notice) {
    res.status(404).json({ error: "Notification not found." });
    return;
  }
  let message: Awaited<ReturnType<typeof messageView>> | null = null;
  if (notice.entityType === "message" && notice.entityId) {
    const [row] = await db.select().from(messagesTable).where(eq(messagesTable.id, notice.entityId)).limit(1);
    const channel = row?.channelId
      ? await db.query.channelsTable.findFirst({ where: eq(channelsTable.id, row.channelId) })
      : null;
    if (row && (
      (row.channelId === null && (row.senderId === userId || row.recipientId === userId))
      || (channel && await canReadChannel(channel, userId))
    )) {
      message = await messageView(row, userId);
    }
  }
  res.json({ notification: { ...notice, category: categoryForNotification(notice.type, notice.category) }, message });
});

router.get("/announcements", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const memberships = await db.select({ communityId: communityMembersTable.communityId })
    .from(communityMembersTable)
    .where(eq(communityMembersTable.userId, userId));
  await Promise.all(memberships.map(async ({ communityId }) => {
    const due = await db.select().from(serverAnnouncementsTable).where(and(
      eq(serverAnnouncementsTable.communityId, communityId),
      eq(serverAnnouncementsTable.status, "scheduled"),
      lte(serverAnnouncementsTable.scheduledAt, new Date()),
    ));
    for (const announcement of due) {
      const [activated] = await db.update(serverAnnouncementsTable).set({ status: "published" })
        .where(and(eq(serverAnnouncementsTable.id, announcement.id), eq(serverAnnouncementsTable.status, "scheduled"))).returning();
      if (!activated) continue;
      const recipients = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
        .where(eq(communityMembersTable.communityId, communityId));
      if (recipients.length) await db.insert(notificationsTable).values(recipients.map((recipient) => ({ userId: recipient.userId, type: "community_announcement", body: `${announcement.title}: ${announcement.body}` })));
    }
  }));
  const isPlatformAdmin = await hasPermission(userId, "manage_any_community");
  const visibility = isPlatformAdmin
    ? undefined
    : memberships.length > 0
      ? inArray(serverAnnouncementsTable.communityId, memberships.map((item) => item.communityId))
      : isNull(serverAnnouncementsTable.communityId);
  const announcements = await db
    .select({
      id: serverAnnouncementsTable.id,
      body: serverAnnouncementsTable.body,
      createdAt: serverAnnouncementsTable.createdAt,
      author: usersTable.displayName,
    })
    .from(serverAnnouncementsTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, serverAnnouncementsTable.authorId))
    .where(and(
      eq(serverAnnouncementsTable.status, "published"),
      visibility,
    ))
    .orderBy(desc(serverAnnouncementsTable.createdAt))
    .limit(20);
  res.json(announcements);
});

router.post("/notifications/:id/read", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const notificationId = Number(param(req, "id"));
  if (!Number.isSafeInteger(notificationId) || notificationId < 1) {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  const readAt = new Date();
  const [updated] = await db
    .update(notificationsTable)
    .set({ readAt })
    .where(and(eq(notificationsTable.id, notificationId), eq(notificationsTable.userId, userId), isNull(notificationsTable.deletedAt)))
    .returning({ id: notificationsTable.id, readAt: notificationsTable.readAt });
  if (updated) {
    wsHub.broadcastUser(userId, {
      type: "notification_read",
      notificationId: updated.id,
      readAt: updated.readAt,
    });
  }
  res.json({ ok: true });
});

router.post("/notifications/read-all", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const readAt = new Date();
  const updated = await db.update(notificationsTable).set({ readAt }).where(and(
    eq(notificationsTable.userId, userId),
    isNull(notificationsTable.archivedAt),
    isNull(notificationsTable.deletedAt),
    isNull(notificationsTable.readAt),
  )).returning({ id: notificationsTable.id });
  wsHub.broadcastUser(userId, { type: "notifications_read_all", notificationIds: updated.map((item) => item.id), readAt });
  res.json({ updated: updated.length, readAt });
});

router.post("/notifications/:id/archive", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = Number(param(req, "id"));
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  const userId = getUserId(req);
  const [updated] = await db.update(notificationsTable).set({ archivedAt: new Date() }).where(and(
    eq(notificationsTable.id, id), eq(notificationsTable.userId, userId), isNull(notificationsTable.deletedAt),
  )).returning({ id: notificationsTable.id });
  if (!updated) { res.status(404).json({ error: "Notification not found." }); return; }
  wsHub.broadcastUser(userId, { type: "notification_archived", notificationId: id });
  res.json({ ok: true });
});

router.post("/notifications/:id/restore", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = Number(param(req, "id"));
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  const userId = getUserId(req);
  const [updated] = await db.update(notificationsTable).set({ archivedAt: null }).where(and(
    eq(notificationsTable.id, id), eq(notificationsTable.userId, userId), isNull(notificationsTable.deletedAt),
  )).returning({ id: notificationsTable.id });
  if (!updated) { res.status(404).json({ error: "Notification not found." }); return; }
  wsHub.broadcastUser(userId, { type: "notification_restored", notificationId: id });
  res.json({ ok: true });
});

router.delete("/notifications/clear", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const deleted = await db.update(notificationsTable).set({ deletedAt: new Date(), body: "", actionUrl: null })
    .where(and(eq(notificationsTable.userId, userId), isNull(notificationsTable.archivedAt), isNull(notificationsTable.deletedAt)))
    .returning({ id: notificationsTable.id });
  wsHub.broadcastUser(userId, { type: "notifications_cleared", notificationIds: deleted.map((item) => item.id) });
  res.json({ deleted: deleted.length });
});

router.delete("/notifications/:id", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = Number(param(req, "id"));
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid notification ID." });
    return;
  }
  const userId = getUserId(req);
  const [deleted] = await db.update(notificationsTable).set({ deletedAt: new Date(), body: "", actionUrl: null }).where(and(
    eq(notificationsTable.id, id), eq(notificationsTable.userId, userId), isNull(notificationsTable.deletedAt),
  )).returning({ id: notificationsTable.id });
  if (!deleted) { res.status(404).json({ error: "Notification not found." }); return; }
  wsHub.broadcastUser(userId, { type: "notification_deleted", notificationId: id });
  res.json({ ok: true });
});

export default router;