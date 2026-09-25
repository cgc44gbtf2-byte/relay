import { Router, type IRouter, type Response } from "express";
import { clerkClient } from "@clerk/express";
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
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
  employeeProfilesTable,
  messageAttachmentsTable,
  messageReactionsTable,
  messagesTable,
  moderationActionsTable,
  notificationsTable,
  serverAnnouncementsTable,
  teamMembersTable,
  teamsTable,
  workspaceTasksTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, ensureProfile, getUserId, type AuthenticatedRequest } from "../lib/auth";
import { AccountDeletionPendingError, assertDeletionEligibleUser } from "../lib/account-deletion";
import { wsHub } from "../lib/ws";
import { canPromoteChannelModerator } from "../lib/channel-moderation-policy";
import { canReadChannel } from "../lib/channel-access";
import { isPublicCommunityAvailable, subscriberPaidThrough } from "../lib/community-subscription";
import { isAvailableUnscopedObjectPath, isUploadedObjectPathForResource, signedObjectUrlForPath, validateUploadMetadata } from "./storage";
import { channelAccessRequiredError, channelNotFoundError } from "./errors";
import { hasPermission, permissionsForCommunities } from "../lib/permissions";
import { categoryForNotification, createNotification, createNotifications, hasNotificationForEntity } from "../lib/notifications";
import { logger } from "../lib/logger";
import { isValidQuery } from "../lib/validation";
import { enqueueObjectDeletionJobs } from "../lib/object-cleanup";
import { FixedWindowLimiter, rateLimitKey } from "../lib/fixed-window-limiter";
import { parseCollectionPage, visibleListPage } from "../lib/visible-list-page";

const router: IRouter = Router();
router.use("/channels/:channelId", requireAuth, async (req: AuthenticatedRequest, res, next): Promise<void> => {
  if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") {
    next();
    return;
  }
  const channelId = Number(req.params.channelId);
  if (Number.isSafeInteger(channelId) && channelId > 0) {
    const [space] = await db.select({ plan: communitiesTable.plan, ownerId: communitiesTable.ownerId })
      .from(channelsTable).innerJoin(communitiesTable, eq(channelsTable.communityId, communitiesTable.id))
      .where(eq(channelsTable.id, channelId)).limit(1);
    if (space && !(await isPublicCommunityAvailable(space))) {
      res.status(403).json({ error: "This community is paused until its owner's subscription is renewed." });
      return;
    }
  }
  next();
});
const channelJoinLimiter = new FixedWindowLimiter(20, 60_000);
const channelInviteLimiter = new FixedWindowLimiter(30, 60_000);
const userSearchLimiter = new FixedWindowLimiter(60, 60_000);
const messageSearchLimiter = new FixedWindowLimiter(60, 60_000);
const messageSendLimiter = new FixedWindowLimiter(60, 60_000);
const MAX_LIST_PAGE_SIZE = 100;

function isUsernameUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      typeof current === "object"
      && current !== null
      && "code" in current
      && current.code === "23505"
      && "constraint" in current
      && current.constraint === "irc_users_username_idx"
    ) {
      return true;
    }
    current = typeof current === "object" && current !== null && "cause" in current
      ? current.cause
      : undefined;
  }
  return false;
}

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

async function moderationActorDisplayName(actorId: string): Promise<string> {
  const [actor] = await db.select({ displayName: usersTable.displayName })
    .from(usersTable)
    .where(eq(usersTable.clerkId, actorId))
    .limit(1);
  if (!actor) throw new Error("Authenticated moderation actor profile was not found.");
  return actor.displayName;
}

function validatedListPage(req: AuthenticatedRequest, res: Response): { limit: number; offset: number } | null {
  const page = parseCollectionPage(req.query, MAX_LIST_PAGE_SIZE);
  if (!page) {
    res.status(400).json({ error: `Invalid pagination: limit must be 1–${MAX_LIST_PAGE_SIZE} and offset must be a nonnegative safe integer.` });
    return null;
  }
  return page;
}

function setListPageHeaders(res: Response, hasMore: boolean, nextOffset: number): void {
  res.set("X-Has-More", String(hasMore));
  if (hasMore) res.set("X-Next-Offset", String(nextOffset));
}

type CursorToken = { after: unknown | null; ceiling: unknown | null; context: string };
type UserCursorKey = { createdAt: string; clerkId: string };

export function cursorContext(route: string, userId: string, binding = ""): string {
  return createHash("sha256").update(`${route}\0${userId}\0${binding}`).digest("hex");
}

export function cursorListRequest(
  req: AuthenticatedRequest,
  res: Response,
  context: string,
  isAfter: (value: unknown) => boolean,
  isCeiling: (value: unknown) => boolean,
  validPair: (after: unknown, ceiling: unknown) => boolean = () => true,
): { page: { limit: number; offset: number }; cursor: CursorToken | null } | null {
  const page = parseCollectionPage(req.query, MAX_LIST_PAGE_SIZE);
  if (!page) {
    res.status(400).json({ error: `Invalid pagination: limit must be 1–${MAX_LIST_PAGE_SIZE} and offset must be a nonnegative safe integer.` });
    return null;
  }
  if (req.query.cursor === undefined) return { page, cursor: null };
  const raw = req.query.cursor;
  if (typeof raw !== "string" || req.query.offset !== undefined) {
    res.status(400).json({ error: "Invalid cursor pagination." });
    return null;
  }
  if (raw === "start") return { page, cursor: { after: null, ceiling: null, context } };
  try {
    if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw) || Buffer.from(raw, "base64url").toString("base64url") !== raw) {
      throw new Error("Invalid base64url cursor.");
    }
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error("Invalid cursor object.");
    const token = decoded as Record<string, unknown>;
    if (Object.keys(token).length !== 3 || !("after" in token) || !("ceiling" in token) || !("context" in token)
      || token.context !== context
      || (token.after !== null && !isAfter(token.after))
      || (token.ceiling !== null && !isCeiling(token.ceiling))
      || token.after === null
      || token.ceiling === null
      || !validPair(token.after, token.ceiling)) {
      throw new Error("Invalid cursor fields.");
    }
    return { page, cursor: { after: token.after, ceiling: token.ceiling, context } };
  } catch {
    res.status(400).json({ error: "Invalid cursor pagination." });
    return null;
  }
}

export async function cursorVisibleListPage<T, A, C>(
  after: A | null,
  ceiling: C | null,
  limit: number,
  initialCeiling: () => Promise<C | null>,
  fetchBatch: (after: A | null, ceiling: C, batchSize: number) => Promise<T[]>,
  afterKey: (row: T) => A,
  visible: (rows: T[]) => Promise<T[]>,
): Promise<{ rows: T[]; hasMore: boolean; nextAfter: A | null; ceiling: C | null }> {
  const fixedCeiling = ceiling ?? await initialCeiling();
  if (fixedCeiling === null) return { rows: [], hasMore: false, nextAfter: null, ceiling: null };
  const selected: T[] = [];
  let scanAfter = after;
  while (selected.length <= limit) {
    const batch = await fetchBatch(scanAfter, fixedCeiling, MAX_LIST_PAGE_SIZE);
    if (batch.length === 0) break;
    scanAfter = afterKey(batch[batch.length - 1]);
    for (const row of await visible(batch)) {
      selected.push(row);
      if (selected.length > limit) break;
    }
    if (batch.length < MAX_LIST_PAGE_SIZE) break;
  }
  const rows = selected.slice(0, limit);
  return {
    rows,
    hasMore: selected.length > limit,
    nextAfter: selected.length > limit && rows.length ? afterKey(rows[rows.length - 1]) : null,
    ceiling: fixedCeiling,
  };
}

function setCursorPageHeaders<A, C>(
  res: Response,
  page: { hasMore: boolean; nextAfter: A | null; ceiling: C | null },
  context: string,
): void {
  res.set("X-Has-More", String(page.hasMore));
  if (page.hasMore && page.nextAfter !== null && page.ceiling !== null) {
    res.set("X-Next-Cursor", Buffer.from(JSON.stringify({
      after: page.nextAfter,
      ceiling: page.ceiling,
      context,
    })).toString("base64url"));
  }
}

function isPositiveCursorId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUserCursorAfter(value: unknown): value is UserCursorKey {
  return isUserCursorKey(value);
}

function isUserCursorCeiling(value: unknown): value is UserCursorKey {
  return isUserCursorKey(value);
}

function isUserCursorKey(value: unknown): value is UserCursorKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return Object.keys(key).length === 2
    && typeof key.createdAt === "string"
    && Number.isFinite(Date.parse(key.createdAt))
    && typeof key.clerkId === "string"
    && key.clerkId.length > 0
    && key.clerkId.length <= 256;
}

function enforceRateLimit(
  req: AuthenticatedRequest,
  res: Response,
  limiter: FixedWindowLimiter,
  message: string,
  key = rateLimitKey(getUserId(req), req.ip ?? req.socket.remoteAddress ?? "unknown"),
): boolean {
  const result = limiter.check(key);
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
  let updated: typeof usersTable.$inferSelect | undefined;
  try {
    [updated] = await db.update(usersTable).set({
      ...(username ? { username } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      status: "online",
      lastSeenAt: new Date(),
    }).where(eq(usersTable.clerkId, userId)).returning();
  } catch (error) {
    if (!isUsernameUniqueViolation(error)) throw error;
    res.status(409).json({
      error: "That username is already taken.",
      code: "USERNAME_TAKEN",
    });
    return;
  }
  res.json(updated);
});

router.get("/channels", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const context = cursorContext("/channels", userId);
  const request = cursorListRequest(req, res, context, isPositiveCursorId, isPositiveCursorId,
    (after, ceiling) => typeof after === "number" && typeof ceiling === "number" && after <= ceiling);
  if (!request) return;
  const page = request.page;
  await ensureProfile(userId);
  await ensureDefaults(userId);
  const joinedIds = new Set<number>();
  const communityPrivacy = new Map<number, boolean>();
  const communityNames = new Map<number, string>();
  const publicCommunityIds = new Set<number>();
  const availableCommunityIds = new Set<number>();
  const membershipIds = new Set<number>();
  const pendingIds = new Set<number>();
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
  const channelVisibility = async (batch: Array<typeof channelsTable.$inferSelect>) => {
      const ids = batch.map((channel) => channel.id);
      const communityIds = [...new Set(batch.flatMap((channel) => channel.communityId === null ? [] : [channel.communityId]))];
      const [joined, pending, communities, memberships] = await Promise.all([
        db.select({ channelId: channelMembersTable.channelId }).from(channelMembersTable)
          .where(and(eq(channelMembersTable.userId, userId), inArray(channelMembersTable.channelId, ids))),
        db.select({ channelId: channelJoinRequestsTable.channelId }).from(channelJoinRequestsTable)
          .where(and(eq(channelJoinRequestsTable.userId, userId), eq(channelJoinRequestsTable.status, "pending"), inArray(channelJoinRequestsTable.channelId, ids))),
        db.select({ id: communitiesTable.id, name: communitiesTable.name, isPrivate: communitiesTable.isPrivate, plan: communitiesTable.plan, ownerId: communitiesTable.ownerId })
          .from(communitiesTable).where(inArray(communitiesTable.id, communityIds.length ? communityIds : [-1])),
        db.select({ communityId: communityMembersTable.communityId }).from(communityMembersTable)
          .where(and(eq(communityMembersTable.userId, userId), inArray(communityMembersTable.communityId, communityIds.length ? communityIds : [-1]))),
      ]);
      joined.forEach((item) => joinedIds.add(item.channelId));
      pending.forEach((item) => pendingIds.add(item.channelId));
      memberships.forEach((item) => membershipIds.add(item.communityId));
      const activeSubscriberOwners = new Set<string>();
      await Promise.all([...new Set(communities.filter((community) => community.plan === "subscriber_community").map((community) => community.ownerId))].map(async (ownerId) => {
        if (await subscriberPaidThrough(ownerId)) activeSubscriberOwners.add(ownerId);
      }));
      for (const community of communities) {
        if (community.plan === "subscriber_community" && !activeSubscriberOwners.has(community.ownerId)) continue;
        availableCommunityIds.add(community.id);
        communityPrivacy.set(community.id, community.isPrivate);
        communityNames.set(community.id, community.name);
        if (!community.isPrivate && ["free_community", "purchased_community", "subscriber_community"].includes(community.plan)) publicCommunityIds.add(community.id);
      }
      const visible = await Promise.all(batch.map(async (channel) => {
        if (channel.communityId !== null && !availableCommunityIds.has(channel.communityId)) return null;
        if (channel.communityId !== null && communityPrivacy.get(channel.communityId) !== false && !(await hasPrivateCommunityAccess(channel.communityId))) return null;
        return !channel.isPrivate || joinedIds.has(channel.id) ? channel : null;
      }));
      return visible.filter((channel): channel is typeof batch[number] => channel !== null);
  };
  const channelPage = request.cursor
    ? await cursorVisibleListPage(
      request.cursor.after as number | null,
      request.cursor.ceiling as number | null,
      page.limit,
      async () => (await db.select({ id: channelsTable.id }).from(channelsTable)
        .orderBy(desc(channelsTable.id)).limit(1))[0]?.id ?? null,
      (after, ceiling, batchSize) => db.select().from(channelsTable)
        .where(and(after === null ? undefined : gt(channelsTable.id, after), lte(channelsTable.id, ceiling)))
        .orderBy(asc(channelsTable.id)).limit(batchSize),
      (channel) => channel.id,
      channelVisibility,
    )
    : await visibleListPage<typeof channelsTable.$inferSelect>(page, MAX_LIST_PAGE_SIZE,
      (after) => db.select().from(channelsTable)
        .where(after ? or(gt(channelsTable.name, after.name), and(eq(channelsTable.name, after.name), gt(channelsTable.id, after.id))) : undefined)
        .orderBy(asc(channelsTable.name), asc(channelsTable.id)).limit(MAX_LIST_PAGE_SIZE),
      channelVisibility).then((result) => ({ ...result, nextAfter: null, ceiling: null }));
  const channels = channelPage.rows;
  const hasMore = channelPage.hasMore;
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
  const categoryIds = [...new Set(channels.flatMap((channel) => channel.categoryId === null ? [] : [channel.categoryId]))];
  const allCategories = categoryIds.length ? await db.select().from(categoriesTable).where(inArray(categoriesTable.id, categoryIds)) : [];
  const visibleCategories = await Promise.all(allCategories.map(async (category) => {
    if (category.communityId === null) return category;
    if (!availableCommunityIds.has(category.communityId)) return null;
    return communityPrivacy.get(category.communityId) !== true
      || await hasPrivateCommunityAccess(category.communityId)
      ? category
      : null;
  }));
  const categories = visibleCategories.filter((category): category is typeof allCategories[number] => category !== null);
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  if (request.cursor) setCursorPageHeaders(res, channelPage, context);
  else setListPageHeaders(res, hasMore, page.offset + channels.length);
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
  const context = cursorContext("/categories", userId);
  const request = cursorListRequest(req, res, context, isPositiveCursorId, isPositiveCursorId,
    (after, ceiling) => typeof after === "number" && typeof ceiling === "number" && after <= ceiling);
  if (!request) return;
  const page = request.page;
  const categoryVisibility = async (batch: Array<typeof categoriesTable.$inferSelect>) => {
      const communityIds = [...new Set(batch.flatMap((category) => category.communityId === null ? [] : [category.communityId]))];
      const [permissions, categoryCommunities] = await Promise.all([
        permissionsForCommunities(userId, communityIds, ["view_business", "manage_community"]),
        communityIds.length ? db.select({ id: communitiesTable.id, plan: communitiesTable.plan, ownerId: communitiesTable.ownerId })
          .from(communitiesTable).where(inArray(communitiesTable.id, communityIds)) : Promise.resolve([]),
      ]);
      const available = new Set((await Promise.all(categoryCommunities.map(async (community) =>
        await isPublicCommunityAvailable(community) ? community.id : null))).filter((id): id is number => id !== null));
      return batch.filter((category) => {
        if (category.communityId === null) return true;
        if (!available.has(category.communityId)) return false;
        const access = permissions.get(category.communityId);
        return Boolean(access?.has("view_business") || access?.has("manage_community"));
      });
  };
  const categoryPage = request.cursor
    ? await cursorVisibleListPage(
      request.cursor.after as number | null,
      request.cursor.ceiling as number | null,
      page.limit,
      async () => (await db.select({ id: categoriesTable.id }).from(categoriesTable)
        .orderBy(desc(categoriesTable.id)).limit(1))[0]?.id ?? null,
      (after, ceiling, batchSize) => db.select().from(categoriesTable)
        .where(and(after === null ? undefined : gt(categoriesTable.id, after), lte(categoriesTable.id, ceiling)))
        .orderBy(asc(categoriesTable.id)).limit(batchSize),
      (category) => category.id,
      categoryVisibility,
    )
    : await visibleListPage<typeof categoriesTable.$inferSelect>(page, MAX_LIST_PAGE_SIZE,
      (after) => db.select().from(categoriesTable)
        .where(after ? or(gt(categoriesTable.name, after.name), and(eq(categoriesTable.name, after.name), gt(categoriesTable.id, after.id))) : undefined)
        .orderBy(asc(categoriesTable.name), asc(categoriesTable.id)).limit(MAX_LIST_PAGE_SIZE),
      categoryVisibility).then((result) => ({ ...result, nextAfter: null, ceiling: null }));
  const categories = categoryPage.rows;
  if (request.cursor) setCursorPageHeaders(res, categoryPage, context);
  else setListPageHeaders(res, categoryPage.hasMore, page.offset + categories.length);
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
    const [targetCommunity] = await db.select({ plan: communitiesTable.plan, ownerId: communitiesTable.ownerId })
      .from(communitiesTable).where(eq(communitiesTable.id, communityId));
    if (targetCommunity && !(await isPublicCommunityAvailable(targetCommunity))) {
      res.status(403).json({ error: "This community is paused until its owner's subscription is renewed." });
      return;
    }
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
      || (sourceCommunity?.isPrivate === false && ["free_community", "purchased_community", "subscriber_community"].includes(sourceCommunity.plan))),
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
  try {
    await db.transaction(async (tx) => {
      await assertDeletionEligibleUser(userId, tx);
      await tx.insert(channelMembersTable).values({ channelId: channel.id, userId }).onConflictDoNothing();
      await tx.delete(channelInvitesTable).where(and(eq(channelInvitesTable.channelId, channel.id), eq(channelInvitesTable.userId, userId)));
    });
  } catch (error) {
    if (error instanceof AccountDeletionPendingError) {
      res.status(409).json({ error: "This account is pending deletion and cannot join channels." });
      return;
    }
    throw error;
  }
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
    if (decision === "approve") {
      try {
        await assertDeletionEligibleUser(request.userId, tx);
      } catch (error) {
        if (!(error instanceof AccountDeletionPendingError)) throw error;
        return { outcome: "pending_deletion" } as const;
      }
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
  if (review.outcome === "pending_deletion") {
    res.status(409).json({ error: "This account is pending deletion and cannot join channels." });
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
  const invitation = await db.transaction(async (tx) => {
    const [lockedChannel] = await tx.select().from(channelsTable)
      .where(eq(channelsTable.id, channel.id)).for("update");
    if (!lockedChannel) return { outcome: "not_found" } as const;
    const [actor] = await tx.select({ role: channelMembersTable.role })
      .from(channelMembersTable)
      .where(and(eq(channelMembersTable.channelId, channel.id), eq(channelMembersTable.userId, userId)))
      .for("update");
    const authorized = (actor && ["owner", "moderator"].includes(actor.role))
      || await hasPermission(userId, "manage_channel", { channelId: channel.id }, tx, true)
      || await hasPermission(userId, "moderate_channel", { channelId: channel.id }, tx, true);
    if (!authorized) {
      return { outcome: "forbidden" } as const;
    }
    await tx.insert(channelInvitesTable).values({ channelId: channel.id, userId: target.clerkId, invitedBy: userId }).onConflictDoUpdate({
      target: [channelInvitesTable.channelId, channelInvitesTable.userId],
      set: { invitedBy: userId, createdAt: new Date() },
    });
    const [notification] = await tx.insert(notificationsTable).values({
      userId: target.clerkId,
      type: "channel_invite",
      category: "join_request",
      body: `You were invited to ${lockedChannel.name}.`,
      entityType: "channel",
      entityId: String(channel.id),
    }).returning();
    return { outcome: "created", notification } as const;
  });
  if (invitation.outcome === "not_found") {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (invitation.outcome === "forbidden") {
    res.status(403).json({ error: "Only channel operators can invite users." });
    return;
  }
  wsHub.broadcastUser(invitation.notification.userId, {
    type: "notification",
    notification: {
      ...invitation.notification,
      category: categoryForNotification(invitation.notification.type, invitation.notification.category),
    },
  });
  res.status(201).json({ ok: true });
});

router.post("/channels/:channelId/leave", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  const channel = await channelFor(param(req, "channelId"));
  if (!channel) {
    res.status(404).json(channelNotFoundError);
    return;
  }
  const leaveResult = await db.transaction(async (tx) => {
    const [lockedChannel] = await tx
      .select({
        id: channelsTable.id,
        ownerId: channelsTable.ownerId,
        isPrivate: channelsTable.isPrivate,
      })
      .from(channelsTable)
      .where(eq(channelsTable.id, channel.id))
      .for("update");
    if (!lockedChannel) return { outcome: "not_found" } as const;

    const [member] = await tx
      .select({ role: channelMembersTable.role })
      .from(channelMembersTable)
      .where(and(
        eq(channelMembersTable.channelId, lockedChannel.id),
        eq(channelMembersTable.userId, userId),
      ))
      .for("update");

    if (lockedChannel.isPrivate) {
      const isOwner = lockedChannel.ownerId === userId;
      const isOperator = isOwner || ["owner", "moderator"].includes(member?.role ?? "");
      if (isOperator) {
        const operators = await tx
          .select({
            userId: channelMembersTable.userId,
            role: channelMembersTable.role,
          })
          .from(channelMembersTable)
          .where(and(
            eq(channelMembersTable.channelId, lockedChannel.id),
            inArray(channelMembersTable.role, ["owner", "moderator"]),
          ))
          .orderBy(asc(channelMembersTable.userId))
          .for("update");
        const remainingOperators = operators.filter((operator) => operator.userId !== userId);

        if (isOwner) {
          const successor = remainingOperators.find((operator) => operator.role === "moderator")
            ?? remainingOperators.find((operator) => operator.role === "owner");
          if (!successor) return { outcome: "last_operator" } as const;

          await tx
            .update(channelsTable)
            .set({ ownerId: successor.userId })
            .where(eq(channelsTable.id, lockedChannel.id));
          if (successor.role !== "owner") {
            await tx
              .update(channelMembersTable)
              .set({ role: "owner" })
              .where(and(
                eq(channelMembersTable.channelId, lockedChannel.id),
                eq(channelMembersTable.userId, successor.userId),
              ));
          }
        } else if (remainingOperators.length === 0) {
          return { outcome: "last_operator" } as const;
        }
      }
    }

    await tx.delete(channelMembersTable).where(and(
      eq(channelMembersTable.channelId, lockedChannel.id),
      eq(channelMembersTable.userId, userId),
    ));
    await tx.delete(channelJoinRequestsTable).where(and(
      eq(channelJoinRequestsTable.channelId, lockedChannel.id),
      eq(channelJoinRequestsTable.userId, userId),
    ));
    return { outcome: "left", isPrivate: lockedChannel.isPrivate } as const;
  });
  if (leaveResult.outcome === "not_found") {
    res.status(404).json(channelNotFoundError);
    return;
  }
  if (leaveResult.outcome === "last_operator") {
    res.status(409).json({
      error: "A private channel must keep an owner or moderator. Promote another member before leaving.",
    });
    return;
  }
  if (leaveResult.isPrivate) wsHub.revokeChannelAccess(channel.id, userId);
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
  if (!enforceRateLimit(req, res, messageSendLimiter, "Too many message requests.", userId)) return;
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
  const mentionedNames = [...new Set([...body.matchAll(/@([a-z0-9_]{3,24})/gi)].map((match) => match[1].toLowerCase()))];
  const notificationRecipientIds = mentionedNames.length
    ? sql<string[]>`ARRAY(
        SELECT ${usersTable.clerkId} FROM ${usersTable}
        INNER JOIN ${channelMembersTable} ON ${channelMembersTable.userId} = ${usersTable.clerkId}
        WHERE ${channelMembersTable.channelId} = ${channel.id}
          AND ${usersTable.clerkId} <> ${userId}
          AND ${inArray(usersTable.username, mentionedNames)}
      )`
    : [];
  const [message] = await db.insert(messagesTable).values({ channelId: channel.id, senderId: userId, replyToId, body, notificationStatus: "pending", notificationRecipientIds }).returning();
  const view = await messageView(message);
  res.status(201).json(view);
  wsHub.broadcastChannel(channel.id, { type: "message", message: view });
});

router.post("/channels/:channelId/file-messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  if (!enforceRateLimit(req, res, messageSendLimiter, "Too many message requests.", userId)) return;
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
    !(channel.communityId === null
      ? await isAvailableUnscopedObjectPath(objectPath, userId)
      : isUploadedObjectPathForResource(objectPath, {
        workspaceId: channel.communityId, resourceType: "channel", resourceId: channel.id,
      }))
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
  const context = cursorContext("/channels/:channelId/public-spaces", userId, param(req, "channelId"));
  const request = cursorListRequest(req, res, context, isPositiveCursorId, isPositiveCursorId,
    (after, ceiling) => typeof after === "number" && typeof ceiling === "number" && after <= ceiling);
  if (!request) return;
  const page = request.page;
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
  if (channel.isPrivate || (source && (source.isPrivate || !["free_community", "purchased_community", "subscriber_community"].includes(source.plan)
    || !(await isPublicCommunityAvailable(source))))) {
    res.status(400).json({ error: "Only channels in public communities or the public network can move between public spaces." });
    return;
  }
  const active = Boolean(await subscriberPaidThrough(userId));
  const eligibleCommunities = and(eq(communitiesTable.ownerId, userId),
      inArray(communitiesTable.plan, active ? ["free_community", "purchased_community", "subscriber_community"] : ["free_community", "purchased_community"]),
      channel.communityId === null ? undefined : sql`${communitiesTable.id} <> ${channel.communityId}`,
      eq(communitiesTable.isPrivate, false), eq(communitiesTable.status, "active"));
  if (request.cursor) {
    const ownedPage = await cursorVisibleListPage(
      request.cursor.after as number | null,
      request.cursor.ceiling as number | null,
      page.limit,
      async () => (await db.select({ id: communitiesTable.id }).from(communitiesTable)
        .where(eligibleCommunities).orderBy(desc(communitiesTable.id)).limit(1))[0]?.id ?? null,
      (after, ceiling, batchSize) => db.select({ id: communitiesTable.id, name: communitiesTable.name, plan: communitiesTable.plan })
        .from(communitiesTable)
        .where(and(eligibleCommunities, after === null ? undefined : gt(communitiesTable.id, after), lte(communitiesTable.id, ceiling)))
        .orderBy(asc(communitiesTable.id)).limit(batchSize),
      (community) => community.id,
      async (rows) => rows,
    );
    setCursorPageHeaders(res, ownedPage, context);
    res.json(ownedPage.rows);
    return;
  }
  const owned = await db.select({ id: communitiesTable.id, name: communitiesTable.name, plan: communitiesTable.plan })
    .from(communitiesTable).where(eligibleCommunities)
    .orderBy(asc(communitiesTable.name), asc(communitiesTable.id))
    .limit(page.limit + 1).offset(page.offset);
  setListPageHeaders(res, owned.length > page.limit, page.offset + page.limit);
  res.json(owned.slice(0, page.limit));
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
    if (channel.communityId !== null && (!source || source.isPrivate || !["free_community", "purchased_community", "subscriber_community"].includes(source.plan)
      || !(await isPublicCommunityAvailable(source)))) {
      return { outcome: "not_public" } as const;
    }
    const destination = communities.find((item) => item.id === destinationId);
    if (!destination || destination.ownerId !== userId
      || destination.isPrivate || !["free_community", "purchased_community", "subscriber_community"].includes(destination.plan)
      || !(await isPublicCommunityAvailable(destination)) || destination.status !== "active") {
      return { outcome: "invalid_destination" } as const;
    }
    const [actor] = await tx.select({ displayName: usersTable.displayName })
      .from(usersTable)
      .where(eq(usersTable.clerkId, userId))
      .limit(1);
    if (!actor) throw new Error("Authenticated moderation actor profile was not found.");
    const [updated] = await tx.update(channelsTable)
      .set({ communityId: destinationId, categoryId: null })
      .where(eq(channelsTable.id, channelId)).returning();
    await tx.insert(moderationActionsTable).values({
      actorId: userId,
      actorDisplayName: actor.displayName,
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
  void wsHub.broadcastChannelListChanged(channelId);
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
    const [actor] = await tx.select({ displayName: usersTable.displayName })
      .from(usersTable)
      .where(eq(usersTable.clerkId, userId))
      .limit(1);
    if (!actor) throw new Error("Authenticated moderation actor profile was not found.");
    const [updated] = await tx.update(channelsTable).set({
      ...(topic === undefined ? {} : { topic }),
      ...(description === undefined ? {} : { description }),
      ...(isInviteOnly === undefined ? {} : { isInviteOnly }),
      ...(password === undefined ? {} : { passwordHash: password ? passwordHash(password) : null }),
      ...(hasCategoryId ? { categoryId } : {}),
    }).where(eq(channelsTable.id, channelId)).returning();
    await tx.insert(moderationActionsTable).values({
      actorId: userId,
      actorDisplayName: actor.displayName,
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
  if (hasCategoryId) void wsHub.broadcastChannelListChanged(channelId);
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
  if (!enforceRateLimit(req, res, messageSendLimiter, "Too many message requests.", userId)) return;
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
  const attachmentChannel = message.channelId === null ? null : await channelFor(String(message.channelId));
  const validObjectPath = message.channelId === null || attachmentChannel?.communityId === null
    ? await isAvailableUnscopedObjectPath(objectPath, userId)
    : typeof attachmentChannel?.communityId === "number" && isUploadedObjectPathForResource(objectPath, {
      workspaceId: attachmentChannel.communityId, resourceType: "channel", resourceId: attachmentChannel.id,
    });
  const metadata = validateUploadMetadata({
    name: req.body?.fileName,
    size: req.body?.fileSize,
    contentType: req.body?.contentType,
  });
  if (
    !validObjectPath
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
  const actorDisplayName = await moderationActorDisplayName(userId);
  if (
    action !== "moderator"
    && action !== "kick"
    && action !== "ban"
    && !(await isChannelOwnerOrModerator(channel.id, userId))
  ) {
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
  } else if (action === "kick" || action === "ban") {
    const moderationResult = await db.transaction(async (tx) => {
      const [lockedChannel] = await tx
        .select({
          id: channelsTable.id,
          ownerId: channelsTable.ownerId,
          isPrivate: channelsTable.isPrivate,
        })
        .from(channelsTable)
        .where(eq(channelsTable.id, channel.id))
        .for("update");
      if (!lockedChannel) return { outcome: "not_found" } as const;

      const members = await tx
        .select({
          userId: channelMembersTable.userId,
          role: channelMembersTable.role,
        })
        .from(channelMembersTable)
        .where(eq(channelMembersTable.channelId, lockedChannel.id))
        .orderBy(asc(channelMembersTable.userId))
        .for("update");
      const actorMembership = members.find((member) => member.userId === userId);
      const actorIsOperator = Boolean(
        actorMembership && ["owner", "moderator"].includes(actorMembership.role),
      );
      const actorCanModerateChannel = actorIsOperator
        || await hasPermission(userId, "manage_channel", { channelId: lockedChannel.id }, tx, true)
        || await hasPermission(userId, "moderate_channel", { channelId: lockedChannel.id }, tx, true);
      if (!actorCanModerateChannel) {
        return { outcome: "forbidden" } as const;
      }

      const targetMembership = members.find((member) => member.userId === targetUserId);
      const targetIsOperator = lockedChannel.ownerId === targetUserId
        || Boolean(targetMembership && ["owner", "moderator"].includes(targetMembership.role));
      if (lockedChannel.isPrivate && targetIsOperator) {
        const remainingOperators = members.filter((member) =>
          member.userId !== targetUserId && ["owner", "moderator"].includes(member.role),
        );

        if (lockedChannel.ownerId === targetUserId) {
          const successor = remainingOperators.find((member) => member.role === "moderator")
            ?? remainingOperators.find((member) => member.role === "owner");
          if (!successor) return { outcome: "last_operator" } as const;

          await tx
            .update(channelsTable)
            .set({ ownerId: successor.userId })
            .where(eq(channelsTable.id, lockedChannel.id));
          if (successor.role !== "owner") {
            await tx
              .update(channelMembersTable)
              .set({ role: "owner" })
              .where(and(
                eq(channelMembersTable.channelId, lockedChannel.id),
                eq(channelMembersTable.userId, successor.userId),
              ));
          }
        } else if (remainingOperators.length === 0) {
          return { outcome: "last_operator" } as const;
        }
      }

      await tx.delete(channelMembersTable).where(and(
        eq(channelMembersTable.channelId, lockedChannel.id),
        eq(channelMembersTable.userId, targetUserId),
      ));
      if (action === "ban") {
        await tx
          .insert(channelBansTable)
          .values({
            channelId: lockedChannel.id,
            userId: targetUserId,
            reason: String(req.body.reason ?? ""),
          })
          .onConflictDoUpdate({
            target: [channelBansTable.channelId, channelBansTable.userId],
            set: { reason: String(req.body.reason ?? "") },
          });
      }
      await tx.insert(moderationActionsTable).values({
        actorId: userId,
        actorDisplayName,
        targetUserId,
        communityId: channel.communityId,
        channelId: lockedChannel.id,
        action,
        details: typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : null,
      });
      return { outcome: "updated" } as const;
    });

    if (moderationResult.outcome === "not_found") {
      res.status(404).json(channelNotFoundError);
      return;
    }
    if (moderationResult.outcome === "forbidden") {
      res.status(403).json({ error: "You do not have moderation permissions." });
      return;
    }
    if (moderationResult.outcome === "last_operator") {
      res.status(409).json({
        error: "A private channel must keep an owner or moderator. Promote another member before removing this operator.",
      });
      return;
    }
    wsHub.revokeChannelAccess(channel.id, targetUserId);
  } else if (action === "unban") {
    await db.delete(channelBansTable).where(and(eq(channelBansTable.channelId, channel.id), eq(channelBansTable.userId, targetUserId)));
  }
  if (action !== "kick" && action !== "ban") {
    await db.insert(moderationActionsTable).values({
      actorId: userId,
      actorDisplayName,
      targetUserId,
      communityId: channel.communityId,
      channelId: channel.id,
      action,
      details: typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : null,
    });
  }
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
  const context = cursorContext("/users/search", userId, q);
  const request = cursorListRequest(req, res, context, isUserCursorAfter, isUserCursorCeiling);
  if (!request) return;
  const page = request.page;
  if (q.length < 2) {
    if (request.cursor) setCursorPageHeaders(res, { hasMore: false, nextAfter: null, ceiling: null }, context);
    res.json([]);
    return;
  }
  const nameMatches = or(ilike(usersTable.username, `%${q}%`), ilike(usersTable.displayName, `%${q}%`));
  const makeUserCursorKey = (createdAt: string, clerkId: string): UserCursorKey => ({ createdAt, clerkId });
  const userCursorCeiling = () => db.select({
    createdAt: sql<string>`${usersTable.createdAt}::text`,
    clerkId: usersTable.clerkId,
  }).from(usersTable).where(nameMatches)
    .orderBy(desc(usersTable.createdAt), desc(usersTable.clerkId)).limit(1);
  const userCursorBounds = (after: UserCursorKey | null, ceiling: UserCursorKey) => and(
    sql`(${usersTable.createdAt}, ${usersTable.clerkId}) <= (${ceiling.createdAt}::timestamptz, ${ceiling.clerkId})`,
    after === null ? undefined
      : sql`(${usersTable.createdAt}, ${usersTable.clerkId}) > (${after.createdAt}::timestamptz, ${after.clerkId})`,
  );
  if (await hasPermission(userId, "manage_any_community")) {
    if (request.cursor) {
      const cursorPage = await cursorVisibleListPage(
        request.cursor.after as UserCursorKey | null,
        request.cursor.ceiling as UserCursorKey | null,
        page.limit,
        async () => {
          const ceiling = (await userCursorCeiling())[0];
          return ceiling ? makeUserCursorKey(ceiling.createdAt, ceiling.clerkId) : null;
        },
        (after, ceiling, batchSize) => db.select({
          user: usersTable,
          cursorCreatedAt: sql<string>`${usersTable.createdAt}::text`,
        }).from(usersTable)
          .where(and(nameMatches, userCursorBounds(after, ceiling)))
          .orderBy(asc(usersTable.createdAt), asc(usersTable.clerkId)).limit(batchSize),
        ({ user, cursorCreatedAt }) => makeUserCursorKey(cursorCreatedAt, user.clerkId),
        async (rows) => rows,
      );
      setCursorPageHeaders(res, cursorPage, context);
      res.json(cursorPage.rows.map(({ user }) => ({ id: user.clerkId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, status: user.status })));
      return;
    }
    const users = await db.select().from(usersTable)
      .where(nameMatches)
      .orderBy(asc(usersTable.clerkId)).limit(page.limit + 1).offset(page.offset);
    const hasMore = users.length > page.limit;
    if (hasMore) users.pop();
    setListPageHeaders(res, hasMore, page.offset + users.length);
    res.json(users.map((user) => ({ id: user.clerkId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, status: user.status })));
    return;
  }
  const memberships = await db.select({ communityId: communityMembersTable.communityId })
    .from(communityMembersTable)
    .where(eq(communityMembersTable.userId, userId));
  if (memberships.length === 0) {
    if (request.cursor) setCursorPageHeaders(res, { hasMore: false, nextAfter: null, ceiling: null }, context);
    res.json([]);
    return;
  }
  if (request.cursor) {
    const communityIds = memberships.map((item) => item.communityId);
    const cursorMembershipCeiling = () => db.select({
      value: sql<string>`${usersTable.createdAt}::text`,
      clerkId: usersTable.clerkId,
    })
      .from(communityMembersTable)
      .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
      .where(and(
        inArray(communityMembersTable.communityId, communityIds),
        nameMatches,
      ))
      .orderBy(desc(usersTable.createdAt), desc(usersTable.clerkId)).limit(1);
    const cursorMembershipFetch = (after: UserCursorKey | null, ceiling: UserCursorKey, batchSize: number) =>
      db.selectDistinct({
        user: usersTable,
        cursorCreatedAt: sql<string>`${usersTable.createdAt}::text`,
      })
        .from(communityMembersTable)
        .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
        .where(and(
          inArray(communityMembersTable.communityId, communityIds),
          nameMatches,
          userCursorBounds(after, ceiling),
        ))
        .orderBy(asc(usersTable.createdAt), asc(usersTable.clerkId)).limit(batchSize);
    const cursorPage = await cursorVisibleListPage(
      request.cursor.after as UserCursorKey | null,
      request.cursor.ceiling as UserCursorKey | null,
      page.limit,
      async () => {
        const ceiling = (await cursorMembershipCeiling())[0];
        return ceiling ? makeUserCursorKey(ceiling.value, ceiling.clerkId) : null;
      },
      cursorMembershipFetch,
      ({ user, cursorCreatedAt }) => makeUserCursorKey(cursorCreatedAt, user.clerkId),
      async (rows) => rows,
    );
    setCursorPageHeaders(res, cursorPage, context);
    res.json(cursorPage.rows.map(({ user }) => ({ id: user.clerkId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl, status: user.status })));
    return;
  }
  const users = await db.selectDistinct({ user: usersTable })
    .from(communityMembersTable)
    .innerJoin(usersTable, eq(usersTable.clerkId, communityMembersTable.userId))
    .where(and(
      inArray(communityMembersTable.communityId, memberships.map((item) => item.communityId)),
      or(ilike(usersTable.username, `%${q}%`), ilike(usersTable.displayName, `%${q}%`)),
    ))
    .orderBy(asc(usersTable.clerkId)).limit(page.limit + 1).offset(page.offset);
  const hasMore = users.length > page.limit;
  if (hasMore) users.pop();
  setListPageHeaders(res, hasMore, page.offset + users.length);
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
  const page = validatedListPage(req, res);
  if (!page) return;
  const rows: typeof messagesTable.$inferSelect[] = [];
  let after: string | null = null;
  let skipped = 0;
  while (rows.length <= page.limit) {
    const batch = await db.selectDistinctOn([messagesTable.threadKey]).from(messagesTable)
      .where(and(or(eq(messagesTable.senderId, userId), eq(messagesTable.recipientId, userId)),
        isNotNull(messagesTable.threadKey),
        after === null ? undefined : gt(messagesTable.threadKey, after)))
      .orderBy(asc(messagesTable.threadKey), desc(messagesTable.createdAt), desc(messagesTable.id))
      .limit(MAX_LIST_PAGE_SIZE);
    if (!batch.length) break;
    after = batch[batch.length - 1].threadKey;
    for (const row of batch) {
      const peerId = row.threadKey?.split(":").find((id) => id !== userId);
      if (!peerId || !(await sharesBusiness(userId, peerId))) continue;
      if (skipped < page.offset) skipped += 1;
      else rows.push(row);
      if (rows.length > page.limit) break;
    }
    if (batch.length < MAX_LIST_PAGE_SIZE) break;
  }
  const hasMore = rows.length > page.limit;
  if (hasMore) rows.pop();
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
    if (key && peerId && peer && lastMessage) {
      threads.push({ key, peer, lastMessage });
    }
  }
  setListPageHeaders(res, hasMore, page.offset + rows.length);
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
  if (!enforceRateLimit(req, res, messageSendLimiter, "Too many message requests.", senderId)) return;
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
  const [message] = await db.insert(messagesTable).values({ senderId, recipientId, threadKey: threadKey(senderId, recipientId), replyToId, body, notificationStatus: "pending", notificationRecipientIds: [recipientId] }).returning();
  const view = await messageView(message);
  res.status(201).json(view);
  wsHub.broadcastUser(senderId, { type: "dm", message: view });
  wsHub.broadcastUser(recipientId, { type: "dm", message: view });
});

router.get("/search/messages", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  if (!enforceRateLimit(req, res, messageSearchLimiter, "Too many message search requests.")) return;
  const userId = getUserId(req);
  const page = validatedListPage(req, res);
  if (!page) return;
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
  )).orderBy(desc(messagesTable.createdAt), desc(messagesTable.id)).limit(page.limit + 1).offset(page.offset);
  const hasMore = rows.length > page.limit;
  if (hasMore) rows.pop();
  setListPageHeaders(res, hasMore, page.offset + rows.length);
  res.json(await messageViews(rows, userId));
});

router.get("/notifications", requireAuth, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = getUserId(req);
  await ensureTaskDeadlineNotifications(userId);
  const archived = req.query.archived === "true";
  const page = listPage(req);
  const rows = await db.select().from(notificationsTable).where(and(
    eq(notificationsTable.userId, userId),
    isNull(notificationsTable.deletedAt),
    archived ? sql`${notificationsTable.archivedAt} IS NOT NULL` : isNull(notificationsTable.archivedAt),
  )).orderBy(desc(notificationsTable.createdAt), desc(notificationsTable.id))
    .limit(page.limit + 1)
    .offset(page.offset);
  const hasMore = rows.length > page.limit;
  if (hasMore) rows.pop();
  setListPageHeaders(res, hasMore, page.offset + page.limit);
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
  const page = validatedListPage(req, res);
  if (!page) return;
  const memberships = await db.select({ communityId: communityMembersTable.communityId })
    .from(communityMembersTable)
    .where(eq(communityMembersTable.userId, userId));
  await Promise.all(memberships.map(async ({ communityId }) => {
    const due = await db.select().from(serverAnnouncementsTable).where(and(
      eq(serverAnnouncementsTable.communityId, communityId),
      eq(serverAnnouncementsTable.status, "scheduled"),
      lte(serverAnnouncementsTable.scheduledAt, new Date()),
      or(isNull(serverAnnouncementsTable.expiresAt), gt(serverAnnouncementsTable.expiresAt, new Date())),
    ));
    for (const announcement of due) {
      const [activated] = await db.update(serverAnnouncementsTable).set({ status: "published" })
        .where(and(eq(serverAnnouncementsTable.id, announcement.id), eq(serverAnnouncementsTable.status, "scheduled"))).returning();
      if (!activated) continue;
      const recipients = await db.select({ userId: communityMembersTable.userId }).from(communityMembersTable)
        .where(and(
          eq(communityMembersTable.communityId, communityId),
          announcement.audienceType === "individual" ? eq(communityMembersTable.userId, announcement.recipientId!) :
          announcement.audienceType === "department" ? exists(db.select({ id: employeeProfilesTable.userId }).from(employeeProfilesTable).where(and(
              eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.userId, communityMembersTable.userId),
              eq(employeeProfilesTable.departmentId, announcement.departmentId!),
            ))) :
          announcement.audienceType === "location" ? exists(db.select({ id: employeeProfilesTable.userId }).from(employeeProfilesTable).where(and(
              eq(employeeProfilesTable.communityId, communityId), eq(employeeProfilesTable.userId, communityMembersTable.userId),
              eq(employeeProfilesTable.locationId, announcement.locationId!),
            ))) :
          announcement.audienceType === "team" ? exists(db.select({ id: teamMembersTable.userId }).from(teamMembersTable)
              .innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId))
              .where(and(eq(teamsTable.communityId, communityId), eq(teamMembersTable.teamId, announcement.teamId!), eq(teamMembersTable.userId, communityMembersTable.userId), eq(teamMembersTable.status, "active")))) : undefined,
        ));
      if (recipients.length) await createNotifications(recipients.map((recipient) => recipient.userId), {
        type: "community_announcement", category: "announcement", body: `${announcement.title}: ${announcement.body}`,
        communityId, entityType: "announcement", entityId: announcement.id, actionUrl: `/communities/${communityId}`,
      });
    }
  }));
  const isPlatformAdmin = await hasPermission(userId, "manage_any_community");
  const visibility = isPlatformAdmin
    ? undefined
    : memberships.length > 0
      ? or(
        isNull(serverAnnouncementsTable.communityId),
        inArray(serverAnnouncementsTable.communityId, memberships.map((item) => item.communityId)),
      )
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
      or(isNull(serverAnnouncementsTable.scheduledAt), lte(serverAnnouncementsTable.scheduledAt, new Date())),
      or(isNull(serverAnnouncementsTable.expiresAt), gt(serverAnnouncementsTable.expiresAt, new Date())),
      isPlatformAdmin ? undefined : or(
        isNull(serverAnnouncementsTable.communityId),
        eq(serverAnnouncementsTable.audienceType, "company"),
        eq(serverAnnouncementsTable.recipientId, userId),
        exists(db.select({ id: employeeProfilesTable.userId }).from(employeeProfilesTable).where(and(
          eq(employeeProfilesTable.communityId, serverAnnouncementsTable.communityId),
          eq(employeeProfilesTable.userId, userId),
          or(
            and(eq(serverAnnouncementsTable.audienceType, "department"), eq(employeeProfilesTable.departmentId, serverAnnouncementsTable.departmentId)),
            and(eq(serverAnnouncementsTable.audienceType, "location"), eq(employeeProfilesTable.locationId, serverAnnouncementsTable.locationId)),
          ),
        ))),
        exists(db.select({ id: teamMembersTable.userId }).from(teamMembersTable)
          .innerJoin(teamsTable, eq(teamsTable.id, teamMembersTable.teamId))
          .where(and(
            eq(teamsTable.communityId, serverAnnouncementsTable.communityId),
            eq(teamMembersTable.userId, userId),
            eq(teamMembersTable.status, "active"),
            eq(serverAnnouncementsTable.audienceType, "team"),
            eq(teamMembersTable.teamId, serverAnnouncementsTable.teamId),
          ))),
      ),
    ))
    .orderBy(desc(serverAnnouncementsTable.createdAt), desc(serverAnnouncementsTable.id))
    .limit(page.limit + 1).offset(page.offset);
  const hasMore = announcements.length > page.limit;
  if (hasMore) announcements.pop();
  setListPageHeaders(res, hasMore, page.offset + announcements.length);
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