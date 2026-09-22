import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
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
import { canReadChannel } from "../lib/channel-access";
import { signedObjectUrlForPath } from "./storage";
import { channelNotFoundError } from "./errors";
import { hasPermission, permissionsForCommunities } from "../lib/permissions";
import { categoryForNotification, createNotification, createNotifications, hasNotificationForEntity } from "../lib/notifications";
import { logger } from "../lib/logger";

const router: IRouter = Router();

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

async function isChannelOwnerOrModerator(channelId: number, userId: string): Promise<boolean> {
  const member = await membership(channelId, userId);
  return Boolean(
    (member && ["owner", "moderator"].includes(member.role))
      || await hasPermission(userId, "manage_channel", { channelId })
      || await hasPermission(userId, "moderate_channel", { channelId }),
  );
}

async function canReviewJoinRequests(channelId: number, userId: string): Promise<boolean> {
  const member = await membership(channelId, userId);
  return Boolean(member && ["owner", "moderator"].includes(member.role));
}

async function notifyMentionedUsers(body: string, senderId: string, channelId: number | null): Promise<void> {
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
    entityType: channelId ? "channel" : null,
    entityId: channelId,
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
  const user = await ensureProfile(getUserId(req));
  res.json({
    id: user.clerkId,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    role: user.role,
    lastSeenAt: user.lastSeenAt,
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
          isPrivate: communitiesTable.isPrivate,
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
    if (!category || (communityId !== null && category.communityId !== communityId)) {
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
  res.status(201).json({ ...channel, passwordHash: undefined, joined: true, accessStatus: "member", memberCount: 1 });
});

router.post("/channels/:channelId/join", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
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
    const [existingRequest] = await db
      .select()
      .from(channelJoinRequestsTable)
      .where(and(
        eq(channelJoinRequestsTable.channelId, channel.id),
        eq(channelJoinRequestsTable.userId, userId),
      ));
    if (existingRequest?.status === "pending") {
      res.status(202).json({ ok: true, status: "pending" });
      return;
    }
    const [request] = existingRequest
      ? await db.update(channelJoinRequestsTable)
        .set({ status: "pending", createdAt: new Date(), reviewedAt: null, reviewedBy: null })
        .where(eq(channelJoinRequestsTable.id, existingRequest.id))
        .returning()
      : await db.insert(channelJoinRequestsTable)
        .values({ channelId: channel.id, userId, status: "pending" })
        .returning();
    await createNotification({
      userId: channel.ownerId,
      type: "channel_join_request",
      category: "join_request",
      body: `Someone requested access to ${channel.name}.`,
      entityType: "channel_join_request",
      entityId: request.id,
      actionUrl: `/`,
    });
    res.status(202).json({ ok: true, status: request.status });
    return;
  }
  await db.insert(channelMembersTable).values({ channelId: channel.id, userId }).onConflictDoNothing();
  await db.delete(channelInvitesTable).where(and(eq(channelInvitesTable.channelId, channel.id), eq(channelInvitesTable.userId, userId)));
  const user = await publicUser(userId);
  const event = { type: "presence", channelId: channel.id, action: "join", user };
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
  if (!(await canReviewJoinRequests(channel.id, userId))) {
    res.status(403).json({ error: "Only channel operators can review join requests." });
    return;
  }
  const rows = await db
    .select({
      id: channelJoinRequestsTable.id,
      status: channelJoinRequestsTable.status,
      createdAt: channelJoinRequestsTable.createdAt,
      user: usersTable,
    })
    .from(channelJoinRequestsTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, channelJoinRequestsTable.userId))
    .where(and(eq(channelJoinRequestsTable.channelId, channel.id), eq(channelJoinRequestsTable.status, "pending")))
    .orderBy(asc(channelJoinRequestsTable.createdAt));
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
  if (!(await canReviewJoinRequests(channel.id, userId))) {
    res.status(403).json({ error: "Only channel operators can review join requests." });
    return;
  }
  const [request] = await db
    .update(channelJoinRequestsTable)
    .set({ status: decision === "approve" ? "approved" : "rejected", reviewedAt: new Date(), reviewedBy: userId })
    .where(and(
      eq(channelJoinRequestsTable.id, requestId),
      eq(channelJoinRequestsTable.channelId, channel.id),
      eq(channelJoinRequestsTable.status, "pending"),
    ))
    .returning();
  if (!request) {
    res.status(404).json({ error: "Join request not found." });
    return;
  }
  if (decision === "approve") {
    await db.insert(channelMembersTable).values({ channelId: channel.id, userId: request.userId }).onConflictDoNothing();
    await createNotification({ userId: request.userId, type: "channel_join_approved", category: "join_request", body: `Your request to join ${channel.name} was approved.`, entityType: "channel", entityId: channel.id });
  } else {
    await createNotification({ userId: request.userId, type: "channel_join_rejected", category: "join_request", body: `Your request to join ${channel.name} was declined.`, entityType: "channel", entityId: channel.id });
  }
  res.json({ ok: true, status: request.status });
});

router.post("/channels/:channelId/invites", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
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
  wsHub.revokeChannelAccess(channel.id, userId);
  wsHub.broadcastChannel(channel.id, { type: "presence", channelId: channel.id, action: "leave", userId });
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
    res.status(403).json({ error: "Join the private channel before viewing its members." });
    return;
  }
  const rows = await db
    .select({
      user: usersTable,
      role: channelMembersTable.role,
      mutedUntil: channelMembersTable.mutedUntil,
    })
    .from(channelMembersTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, channelMembersTable.userId))
    .where(eq(channelMembersTable.channelId, channel.id))
    .orderBy(asc(usersTable.displayName));
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
    res.status(403).json({ error: "Join the private channel before reading its history." });
    return;
  }
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
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
    res.status(403).json({ error: "Join the channel before sending messages." });
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
  void notifyMentionedUsers(body, userId, channel.id).catch((error) => {
    logger.warn({ err: error, messageId: message.id }, "Message mention notifications failed.");
  });
  wsHub.broadcastChannel(channel.id, { type: "message", message: view });
});

router.patch("/channels/:channelId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (!(await isChannelOwnerOrModerator(channel.id, userId))) {
    res.status(403).json({ error: "Only channel owners and moderators can edit this channel." });
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
  const [updated] = await db.update(channelsTable).set({
    ...(topic === undefined ? {} : { topic }),
    ...(description === undefined ? {} : { description }),
    ...(isInviteOnly === undefined ? {} : { isInviteOnly }),
    ...(password === undefined ? {} : { passwordHash: password ? passwordHash(password) : null }),
  }).where(eq(channelsTable.id, channel.id)).returning();
  await db.insert(moderationActionsTable).values({
    actorId: userId,
    communityId: channel.communityId,
    channelId: channel.id,
    action: "updated_channel",
    details: topic !== undefined ? `topic:${topic}` : "channel settings changed",
  });
  wsHub.broadcastChannel(channel.id, { type: "channel", channel: publicChannel(updated) });
  res.json(publicChannel(updated));
});

router.delete("/channels/:channelId", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (!(await isChannelOwnerOrModerator(channel.id, userId))) {
    res.status(403).json({ error: "Only channel owners and moderators can delete this channel." });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(channelJoinRequestsTable).where(eq(channelJoinRequestsTable.channelId, channel.id));
    await tx.delete(channelInvitesTable).where(eq(channelInvitesTable.channelId, channel.id));
    await tx.delete(channelBansTable).where(eq(channelBansTable.channelId, channel.id));
    await tx.delete(channelMembersTable).where(eq(channelMembersTable.channelId, channel.id));
    await tx.delete(messagesTable).where(eq(messagesTable.channelId, channel.id));
    await tx.delete(channelsTable).where(eq(channelsTable.id, channel.id));
  });
  wsHub.broadcastChannelRemoved(channel.id);
  res.json({ ok: true });
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
  if (message.channelId) wsHub.broadcastChannel(message.channelId, { type: "message_deleted", messageId: message.id });
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
  if (!(await canReadMessage(message, userId))) {
    res.status(403).json({ error: "You cannot attach files to this message." });
    return;
  }
  if (message.senderId !== userId) {
    res.status(403).json({ error: "Only the message sender can attach files." });
    return;
  }
  const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.trim().slice(0, 160) : "";
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType.trim().slice(0, 120) : "application/octet-stream";
  const fileSize = Number(req.body?.fileSize);
  if (!objectPath.startsWith("/objects/") || !fileName || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 10_000_000) {
    res.status(400).json({ error: "Invalid attachment metadata." });
    return;
  }
  const [attachment] = await db.insert(messageAttachmentsTable).values({
    messageId,
    uploaderId: userId,
    objectPath,
    fileName,
    contentType,
    fileSize,
  }).returning();
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
  if (message.channelId) wsHub.broadcastChannel(message.channelId, { type: "reaction", messageId, reactions: view.reactions });
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
  if (message.channelId) wsHub.broadcastChannel(message.channelId, { type: "reaction", messageId, reactions: view.reactions });
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
  if (!(await isChannelOwnerOrModerator(channel.id, userId))) {
    res.status(403).json({ error: "You do not have moderation permissions." });
    return;
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
  } else {
    await db.update(channelMembersTable).set({ role: "moderator" }).where(and(eq(channelMembersTable.channelId, channel.id), eq(channelMembersTable.userId, targetUserId)));
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
  const userId = getUserId(req);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
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
  const rows = await db.select().from(messagesTable).where(or(eq(messagesTable.senderId, userId), eq(messagesTable.recipientId, userId))).orderBy(desc(messagesTable.createdAt));
  const keys = [...new Set(rows.map((row) => row.threadKey).filter((key): key is string => Boolean(key)))];
  const threads = [];
  for (const key of keys) {
    const peerId = key.split(":").find((id) => id !== userId) ?? userId;
    if (!(await sharesBusiness(userId, peerId))) continue;
    const peer = await publicUser(peerId);
    const last = rows.find((row) => row.threadKey === key);
    if (peer && last) threads.push({ key, peer, lastMessage: await messageView(last) });
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
  const userId = getUserId(req);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
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
  const rows = await db.select().from(notificationsTable).where(eq(notificationsTable.userId, userId)).orderBy(desc(notificationsTable.createdAt)).limit(100);
  res.json(rows.map((row) => ({ ...row, category: categoryForNotification(row.type, row.category) })));
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
  await db.update(notificationsTable).set({ readAt: new Date() }).where(and(eq(notificationsTable.id, Number(param(req, "id"))), eq(notificationsTable.userId, getUserId(req))));
  res.json({ ok: true });
});

export default router;